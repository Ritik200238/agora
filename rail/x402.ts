import express, { type Express } from "express";
import { decodeEventLog, parseAbiItem } from "viem";
import { publicClient, activeChain, type Wallet } from "../shared/chain";
import { dep, SETTLEMENT_MODE } from "../shared/config";
import { ChainSettlement } from "./settlement";

/**
 * x402 service boundary — "pay to use".
 *
 * Semantics (HTTP 402 Payment Required): a request with no payment returns 402 + terms
 * (price, payTo, token, chainId). The caller pays, then retries with proof of payment; the
 * provider verifies the payment ON-CHAIN (real USDC transfer to itself, with replay protection)
 * and serves the result.
 *
 * - LOCAL: payment = a real ERC-20 USDC transfer, verified by decoding the Transfer event.
 * - ARC:   payment = Circle Gateway / Nanopayments via @circle-fin/x402-batching (gasless, batched,
 *          sub-cent). See arcGatewayPay() / arcGatewayMiddleware() — requires a funded Arc key.
 */

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export interface X402Terms {
  price: string; // USDC (6dp) as string
  payTo: `0x${string}`;
  token: `0x${string}`;
  chainId: number;
  serviceId: string;
  challengeBlock: string; // payment must be mined AFTER this block
}
export interface X402Response {
  status: number;
  body: any;
}

let SERVICE_SEQ = 0;
// A given on-chain payment tx can be consumed for x402 settlement ONCE, across ALL service instances
// (closes cross-service replay). Module-level so it is shared by every x402Service. For a multi-process
// production deployment, back this with a persistent store; here each purchase mints a fresh tx.
const X402_CONSUMED = new Set<string>();

/** A producer's x402-paywalled service (transport-agnostic core).
 *  The payment is bound to a per-request CHALLENGE (a block height issued on the 402) so an unrelated or
 *  pre-existing transfer cannot satisfy the paywall (default-DENY when no live challenge), and each payment
 *  tx is consumed once globally. (On Arc, Circle's facilitator binds payments via signed EIP-712 auth.) */
export function x402Service(opts: { payTo: `0x${string}`; price: bigint; produce: () => any }) {
  const serviceId = `svc-${++SERVICE_SEQ}-${opts.payTo.slice(2, 10)}`;
  let challengeBlock = 0n;

  return async function handle(paymentRef?: string): Promise<X402Response> {
    if (!paymentRef) {
      challengeBlock = await publicClient.getBlockNumber();
      const terms: X402Terms = {
        price: opts.price.toString(),
        payTo: opts.payTo,
        token: dep().usdc,
        chainId: activeChain.id,
        serviceId,
        challengeBlock: challengeBlock.toString(),
      };
      return { status: 402, body: { error: "payment required", terms } };
    }

    const key = paymentRef.toLowerCase();
    if (X402_CONSUMED.has(key)) return { status: 409, body: { error: "payment already used" } };

    const receipt = await publicClient.getTransactionReceipt({ hash: paymentRef as `0x${string}` });
    // Default-DENY: a valid challenge must have been issued, and the payment must be mined after it.
    if (challengeBlock === 0n || receipt.blockNumber <= challengeBlock) {
      return { status: 402, body: { error: "no live challenge / payment predates it (replay rejected)" } };
    }

    let paid = 0n;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== dep().usdc.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
        const a = ev.args as { to: `0x${string}`; value: bigint };
        if (a.to.toLowerCase() === opts.payTo.toLowerCase()) paid += a.value;
      } catch {
        /* not a transfer */
      }
    }
    if (paid < opts.price) {
      return { status: 402, body: { error: "insufficient payment", paid: paid.toString(), required: opts.price.toString() } };
    }
    X402_CONSUMED.add(key);
    return { status: 200, body: opts.produce() };
  };
}

/** A consumer pays an x402 service and returns its result (local path: real ERC-20 settlement). */
export async function x402Pay(consumer: Wallet, service: (ref?: string) => Promise<X402Response>): Promise<any> {
  const probe = await service();
  if (probe.status === 200) return probe.body;
  if (probe.status !== 402) throw new Error(`x402 unexpected: ${JSON.stringify(probe.body)}`);

  const price = BigInt(probe.body.terms.price);
  const payTo = probe.body.terms.payTo as `0x${string}`;
  const { ref } = await new ChainSettlement().pay(consumer, payTo, price, "x402");
  const res = await service(ref);
  if (res.status !== 200) throw new Error(`x402 failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

/**
 * Mode-aware purchase across the x402 boundary — the single call the economy uses, so the Circle path is
 * a LIVE, selected branch (not dead code):
 *   - LOCAL: an in-process x402 paywall settled by a real, challenge-bound on-chain USDC transfer.
 *   - ARC:   Circle Gateway / Nanopayments via arcGatewayPay() against the producer's facilitator endpoint.
 */
export async function x402Buy(
  consumer: Wallet,
  producer: `0x${string}`,
  price: bigint,
  produce: () => any,
  arcEndpoint?: string
): Promise<any> {
  if (SETTLEMENT_MODE === "arc") {
    if (!arcEndpoint) throw new Error("x402Buy(arc) requires the producer's Circle-Gateway endpoint URL");
    return arcGatewayPay(arcEndpoint); // genuine Circle Gateway settlement on Arc
  }
  const service = x402Service({ payTo: producer, price, produce });
  return x402Pay(consumer, service);
}

/** Mount x402 services on an Express app at the given paths (HTTP transport for the local path). */
export function x402Router(services: Record<string, ReturnType<typeof x402Service>>): Express {
  const app = express();
  for (const [path, svc] of Object.entries(services)) {
    app.get(path, async (req, res) => {
      const ref = (req.query.payment as string) || (req.header("x-payment") ?? undefined);
      const out = await svc(ref);
      res.status(out.status).json(out.body);
    });
  }
  return app;
}

// ---------------------------------------------------------------------------
// ARC path — real Circle Gateway / Nanopayments (requires a funded Arc key).
// Lazily imported so the local path never loads the Circle SDK.
// ---------------------------------------------------------------------------

/** Pay an x402 endpoint URL on Arc via Circle Gateway. Requires SETTLEMENT=arc + PRIVATE_KEY. */
export async function arcGatewayPay(url: string, depositUsd?: string): Promise<{ status: number; data: any }> {
  if (SETTLEMENT_MODE !== "arc") throw new Error("arcGatewayPay requires SETTLEMENT=arc");
  const pk = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk) throw new Error("arcGatewayPay requires PRIVATE_KEY (faucet-funded Arc Testnet key)");
  const { GatewayClient } = await import("@circle-fin/x402-batching/client");
  const client = new GatewayClient({ chain: "arcTestnet", privateKey: pk, rpcUrl: process.env.ARC_TESTNET_RPC });
  if (depositUsd) await client.deposit(depositUsd); // one-time: fund the Gateway balance, then pay() is gasless
  return client.pay(url);
}

/** Build Circle's Gateway middleware so a producer can paywall an Express route on Arc. */
export async function arcGatewayMiddleware(sellerAddress: `0x${string}`, price: string = "$0.01") {
  const { createGatewayMiddleware } = await import("@circle-fin/x402-batching/server");
  const gateway = createGatewayMiddleware({
    sellerAddress,
    facilitatorUrl: process.env.GATEWAY_API || "https://gateway-api-testnet.circle.com",
    networks: ["eip155:5042002"],
  });
  return gateway.require(price); // the actual Express middleware — charges `price` USDC/call via Circle Gateway
}
