// Real nanopayments on Arc via Circle Gateway (x402 "exact" scheme, batched settlement).
//
// Why Gateway and not plain transfers: an ERC-20 transfer on Arc costs ~$0.0012 of gas (measured), i.e. 1,200×
// a $0.000001 payment. With Gateway the buyer deposits USDC once (one on-chain tx); every call after that is an
// EIP-712 authorization signed off-chain, verified + settled by Circle's facilitator and batched onto Arc. A
// 1-unit ($0.000001) payment was verified end-to-end against the live testnet facilitator before this was built.
//
// The flow every paid call goes through (tabs and outside agents alike):
//     verify the signed authorization  →  run the service  →  settle ONLY if the delivery is valid
// so "never charged for junk" holds on real money too: a failed or invalid delivery is never settled, and an
// unsettled authorization moves no funds.
import { createHash } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseAbiItem, formatUnits } from "viem";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { BatchEvmScheme, GatewayClient } from "@circle-fin/x402-batching/client";
import { arcPublicClient, arcWallet, ARC_NETWORK, ARC_RPC } from "../shared/arc";
import { arcTestnet } from "../shared/chain";

export const FACILITATOR_URL = process.env.GATEWAY_API || "https://gateway-api-testnet.circle.com";
const SCHEME = "exact";
const BATCH_NAME = "GatewayWalletBatched";
const BATCH_VERSION = "1";
const AUTH_WINDOW_SECONDS = 7 * 24 * 3600 + 100; // Gateway's minimum authorization validity + buffer
const ERC20_TRANSFER = parseAbiItem("function transfer(address to, uint256 value) returns (bool)");
const ERC20_BALANCE = parseAbiItem("function balanceOf(address who) view returns (uint256)");

export interface PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; verifyingContract: string };
}

export interface PaymentPayload {
  x402Version: number;
  resource?: { url: string; description: string; mimeType: string };
  accepted?: PaymentRequirements;
  payload: Record<string, unknown>;
}

/** What a paid service run produced. `ok: false` → the payment is never settled (buyer not charged). */
export type RunOutcome = { ok: true; result: unknown } | { ok: false; status: number; body: Record<string, unknown> };

export type ChargeOutcome =
  | { ok: true; result: unknown; transfer: string; payer: string }
  | { ok: false; status: number; body: Record<string, unknown>; charged: false };

export class ArcRail {
  readonly facilitator = new BatchFacilitatorClient({ url: FACILITATOR_URL });
  private verifyingContract = "";
  private usdc = "";
  private inflight = new Set<string>(); // authorizations currently being processed (blocks concurrent reuse)
  private settled = new Set<string>(); // recently settled authorizations — a replay is refused before the seller runs
  private reader: GatewayClient; // read-only Gateway API access (balances, transfers) — never signs anything

  constructor(readerKey: `0x${string}` = generatePrivateKey()) {
    this.reader = new GatewayClient({ chain: "arcTestnet", privateKey: readerKey, rpcUrl: ARC_RPC });
  }

  /** A payer's spendable Gateway balance (atomic units). */
  async available(payer: string): Promise<bigint> {
    const b = await this.reader.getBalances(payer as `0x${string}`);
    return BigInt(b.gateway.available);
  }

  /** Load Gateway's Arc config (verifying contract + USDC) from the live facilitator. Throws if Arc is absent. */
  async init(): Promise<this> {
    const supported = await this.facilitator.getSupported();
    const kind = supported.kinds.find((k: any) => k.network === ARC_NETWORK && k.extra?.verifyingContract);
    const usdc = (kind?.extra as any)?.assets?.find((a: any) => a.symbol === "USDC")?.address;
    if (!kind || !usdc) throw new Error(`Circle Gateway facilitator at ${FACILITATOR_URL} does not support ${ARC_NETWORK}`);
    this.verifyingContract = String((kind.extra as any).verifyingContract);
    this.usdc = String(usdc);
    return this;
  }

  /** The x402 requirements for one call: exactly `amountUnits` USDC (6dp) to `payTo`, on Arc, via Gateway. */
  requirements(amountUnits: bigint, payTo: string): PaymentRequirements {
    if (!this.verifyingContract) throw new Error("ArcRail.init() not called");
    return {
      scheme: SCHEME,
      network: ARC_NETWORK,
      asset: this.usdc,
      amount: amountUnits.toString(),
      payTo,
      maxTimeoutSeconds: AUTH_WINDOW_SECONDS,
      extra: { name: BATCH_NAME, version: BATCH_VERSION, verifyingContract: this.verifyingContract },
    };
  }

  /** The standard x402 v2 402 response (base64 JSON in the PAYMENT-REQUIRED header — what x402 clients read). */
  paymentRequired(resourceUrl: string, description: string, reqs: PaymentRequirements) {
    const body = { x402Version: 2, resource: { url: resourceUrl, description, mimeType: "application/json" }, accepts: [reqs] };
    return { header: Buffer.from(JSON.stringify(body)).toString("base64"), body };
  }

  decode(header: string): PaymentPayload | null {
    try {
      const p = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      return p && typeof p === "object" && p.payload ? (p as PaymentPayload) : null;
    } catch {
      return null;
    }
  }

  /** Sign a payment for `reqs` as `privateKey` (the buyer side, used by custodial demo tabs). */
  async sign(privateKey: `0x${string}`, reqs: PaymentRequirements, resourceUrl: string, description: string): Promise<PaymentPayload> {
    const account = privateKeyToAccount(privateKey);
    const scheme = new BatchEvmScheme({ address: account.address, signTypedData: (p: any) => account.signTypedData(p) } as any);
    const signed = await scheme.createPaymentPayload(2, reqs as any);
    return { ...(signed as any), resource: { url: resourceUrl, description, mimeType: "application/json" }, accepted: reqs };
  }

  /**
   * verify → run → settle-on-success. The authorization must match `reqs` exactly (amount, payTo, network);
   * Circle checks the signature, the buyer's Gateway balance and the nonce. `run` executes the service; if it
   * fails or delivers junk, the authorization is simply never settled.
   */
  async charge(payload: PaymentPayload, reqs: PaymentRequirements, run: () => Promise<RunOutcome>): Promise<ChargeOutcome> {
    const key = createHash("sha256").update(JSON.stringify(payload.payload)).digest("hex");
    if (this.inflight.has(key)) return { ok: false, status: 409, body: { error: "this payment is already being processed" }, charged: false };
    // Circle rejects a reused nonce only at settle — by then the seller would already have done the work
    if (this.settled.has(key)) return { ok: false, status: 402, body: { error: "payment already used (replay rejected)" }, charged: false };
    this.inflight.add(key);
    try {
      if (payload.accepted && (payload.accepted.network !== reqs.network || payload.accepted.amount !== reqs.amount || payload.accepted.payTo?.toLowerCase() !== reqs.payTo.toLowerCase()))
        return { ok: false, status: 402, body: { error: "payment does not match this resource's terms", expected: { amount: reqs.amount, payTo: reqs.payTo, network: reqs.network } }, charged: false };
      let v;
      try {
        v = await this.facilitator.verify(payload as any, reqs as any);
      } catch (e) {
        return { ok: false, status: 502, body: { error: "payment verification unavailable: " + String((e as Error)?.message ?? e).slice(0, 160) }, charged: false };
      }
      if (!v.isValid) return { ok: false, status: 402, body: { error: "payment verification failed", reason: v.invalidReason }, charged: false };
      // Circle's verify checks the signature, not the funds (measured: a 0-balance payer verified fine and only
      // failed at settle). Check the balance BEFORE running, so a seller never does the work for a payer who
      // can't pay. Settlement still has the final word.
      const payer = v.payer ?? "";
      if (payer) {
        const avail = await this.available(payer).catch(() => null);
        if (avail !== null && avail < BigInt(reqs.amount))
          return { ok: false, status: 402, body: { error: "insufficient Gateway balance", availableUnits: avail.toString(), requiredUnits: reqs.amount, hint: "deposit USDC into Circle Gateway on Arc first (GatewayClient.deposit)" }, charged: false };
      }

      const outcome = await run();
      if (!outcome.ok) return { ok: false, status: outcome.status, body: { ...outcome.body, charged: false }, charged: false };

      let s;
      try {
        s = await this.facilitator.settle(payload as any, reqs as any);
      } catch (e) {
        return { ok: false, status: 502, body: { error: "settlement failed — you were NOT charged: " + String((e as Error)?.message ?? e).slice(0, 160) }, charged: false };
      }
      if (!s.success) return { ok: false, status: 402, body: { error: "settlement failed — you were NOT charged", reason: s.errorReason }, charged: false };
      this.settled.add(key);
      if (this.settled.size > 50_000) this.settled.delete(this.settled.values().next().value as string); // bounded; Circle's nonce check remains the backstop
      return { ok: true, result: outcome.result, transfer: s.transaction, payer: s.payer ?? payer };
    } finally {
      this.inflight.delete(key);
    }
  }

  /** A Circle Gateway transfer's current state (it gains an Arc txHash once its batch lands on-chain). */
  transferStatus(id: string) {
    return this.reader.getTransferById(id);
  }
}

/** A custodial demo tab on Arc: its own wallet with a real Circle Gateway deposit (the spending cap). */
export interface ArcTab {
  privateKey: `0x${string}`;
  address: `0x${string}`;
  depositTx: string;
  fundTx: string;
}

/**
 * Funds demo tabs from the operator wallet: one USDC transfer (on Arc, USDC is also the gas token, so this pays
 * the tab's gas too), then the tab approves + deposits `cap` into Gateway (~$0.0045 of gas, measured). A tab is
 * only handed out once Circle has CREDITED the deposit — measured: the balance reads 0 for a few seconds after
 * the deposit tx confirms, and a payment signed in that gap verifies but can't settle.
 * A daily budget caps total spend so a public endpoint can't drain the operator.
 */
export class ArcTabFunder {
  private day = "";
  private spentToday = 0n;
  private reader: GatewayClient;
  constructor(
    private operatorKey: `0x${string}`,
    readonly dailyBudgetUnits: bigint,
    readonly gasBufferUnits = 8_000n, // $0.008 covers approve + deposit (measured ~$0.0045) with headroom
    readonly creditTimeoutMs = 120_000,
    /** Hard floor, checked against the operator's ON-CHAIN balance before every funding. The daily budget is
     *  in memory, so a restart resets it; on a free host that restarts often, only this floor reliably stops
     *  demo tabs from draining the operator (which also pays for slashes and claim payouts). */
    readonly operatorFloorUnits = 5_000_000n
  ) {
    this.reader = new GatewayClient({ chain: "arcTestnet", privateKey: operatorKey, rpcUrl: ARC_RPC });
  }

  private rollDay() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.spentToday = 0n;
    }
  }

  remainingToday(): bigint {
    this.rollDay();
    return this.dailyBudgetUnits - this.spentToday;
  }

  async open(capUnits: bigint): Promise<ArcTab> {
    this.rollDay();
    const cost = capUnits + this.gasBufferUnits;
    if (this.spentToday + cost > this.dailyBudgetUnits)
      throw new Error("today's free demo credit is used up — try again tomorrow, or pay from your own Arc wallet via /x402/arc/:service");
    this.spentToday += cost; // reserve before any await so concurrent opens can't overshoot the budget
    let funded = false;
    try {
      const opBalance = (await arcPublicClient.readContract({ address: "0x3600000000000000000000000000000000000000", abi: [ERC20_BALANCE], functionName: "balanceOf", args: [privateKeyToAccount(this.operatorKey).address] })) as bigint;
      if (opBalance < this.operatorFloorUnits + cost) throw new Error("free demo credit is paused (operator reserve reached) — pay from your own Arc wallet via /x402/arc/:service");
      const privateKey = generatePrivateKey();
      const address = privateKeyToAccount(privateKey).address;
      const op = arcWallet(this.operatorKey);
      const fundTx = await op.writeContract({ account: op.account, chain: arcTestnet, address: "0x3600000000000000000000000000000000000000", abi: [ERC20_TRANSFER], functionName: "transfer", args: [address, cost] });
      const r = await arcPublicClient.waitForTransactionReceipt({ hash: fundTx });
      if (r.status !== "success") throw new Error("funding transfer reverted");
      funded = true; // from here the money has left the operator — it stays counted against today's budget
      const client = new GatewayClient({ chain: "arcTestnet", privateKey, rpcUrl: ARC_RPC });
      const dep = await client.deposit(formatUnits(capUnits, 6));
      const deadline = Date.now() + this.creditTimeoutMs;
      for (;;) {
        const avail = BigInt((await this.reader.getBalances(address)).gateway.available);
        if (avail >= capUnits) break;
        if (Date.now() > deadline) throw new Error("Circle Gateway did not credit the deposit in time");
        await new Promise((res) => setTimeout(res, 1500));
      }
      return { privateKey, address, depositTx: dep.depositTxHash, fundTx };
    } catch (e) {
      if (!funded) this.spentToday -= cost;
      throw e;
    }
  }
}

/** Keeps a few tabs pre-funded so a visitor's "open tab" is instant (a cold open takes ~25-40s on Arc). */
export class ArcTabPool {
  private ready: ArcTab[] = [];
  private filling = 0;
  constructor(private funder: ArcTabFunder, readonly capUnits: bigint, readonly target = 2) {}

  /** Top the pool up in the background (errors are logged, never thrown — a visitor can still cold-open). */
  refill(): void {
    while (this.ready.length + this.filling < this.target && this.funder.remainingToday() >= this.capUnits + this.funder.gasBufferUnits) {
      this.filling++;
      this.funder
        .open(this.capUnits)
        .then((t) => this.ready.push(t))
        .catch((e) => console.error("arc tab pre-fund failed:", (e as Error)?.message))
        .finally(() => {
          this.filling--;
        });
    }
  }

  /** A ready tab if one is waiting, else a fresh (slow) one. Always triggers a background refill. */
  async take(): Promise<ArcTab> {
    const t = this.ready.shift();
    this.refill();
    return t ?? this.funder.open(this.capUnits);
  }

  get readyCount() {
    return this.ready.length;
  }
}
