// Agora Pay-Per-Use Gateway — the PUBLIC edge of the economy.
//
// This is what turns Agora from a closed simulation into a real product: anyone (a human via the
// /pay UI, or an external AI agent via the SDK) can pay TINY USDC PER CALL for real services over
// the x402 protocol. Two payment models, both settling REAL USDC on-chain:
//
//   1. Tabs (Dexter-style, browser-tryable): open a capped "tab" (pre-funded demo credit on the local
//      chain), then pay-per-call against it. The server custodies the tab wallet; the contract-enforced
//      cap means an agent can never overspend. Every call is a real on-chain USDC transfer.
//   2. Raw x402 (for external agents with their own funded wallet): GET a service → 402 + price terms →
//      transfer USDC yourself → POST { payment: txHash, input } → get the result. Verified on-chain.
//
// Every purchase here is counted as REAL externalVolume (distinct from the agents' internal wash volume).
import express, { type Express } from "express";
import { keccak256, toHex, parseAbiItem, decodeEventLog, parseEther } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { publicClient, walletFor, activeChain, type Wallet } from "../shared/chain";
import { dep, SETTLEMENT_MODE } from "../shared/config";
import { usd, fmtUsd, usdcMint, usdcTransfer } from "../shared/usdc";
import * as A from "../shared/contracts";
import type { Economy } from "../orchestrator/economy";
import type { Society } from "../agents/society";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// --- REAL data oracle: live crypto prices from CoinGecko (free, no key). Cached to respect rate limits.
//     If the real source is unavailable it THROWS — the caller is never charged and never served fake data. ---
const PRICE_TTL_MS = 30_000;
const PRICE_ASSETS = ["bitcoin", "ethereum", "solana", "usd-coin", "tether", "dogecoin", "arbitrum", "chainlink"];
const priceCache = new Map<string, { usd: number; at: number }>();
async function fetchPrice(assetIn: unknown) {
  const asset = String(assetIn || "bitcoin").toLowerCase().trim();
  if (!PRICE_ASSETS.includes(asset)) throw new Error(`unknown asset '${asset}' — try: ${PRICE_ASSETS.join(", ")}`);
  const now = Date.now();
  const c = priceCache.get(asset);
  if (c && now - c.at < PRICE_TTL_MS) return { asset, usd: c.usd, source: "coingecko", cached: true, asOf: new Date(c.at).toISOString() };
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(asset)}&vs_currencies=usd`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`price source unavailable (HTTP ${res.status})`);
  const j: any = await res.json();
  const usd = j?.[asset]?.usd;
  if (typeof usd !== "number") throw new Error(`no live price for '${asset}'`);
  priceCache.set(asset, { usd, at: now });
  return { asset, usd, source: "coingecko", cached: false, asOf: new Date(now).toISOString() };
}

// ---- the real, useful services the gateway sells (pay-per-call, rule-based, no API keys) ----
interface Service {
  id: string;
  price: bigint;
  desc: string;
  example: any;
  run: (input: any, eco: Economy) => any;
}

function makeServices(): Record<string, Service> {
  const list: Service[] = [
    {
      id: "feed",
      price: usd(0.000001), // $0.000001 — the hackathon's headline nanopayment
      desc: "One live reading from the economy's data feed (its current on-chain GDP).",
      example: {},
      run: (_input, eco) => ({ metric: "gdp_usdc", value: eco.lastGdp, tick: eco.tickN }),
    },
    {
      id: "price",
      price: usd(0.0001), // $0.0001 per real price read — a genuine reason to pay
      desc: "Live USD price of a crypto asset — REAL market data (CoinGecko). input: { asset }.",
      example: { asset: "bitcoin" },
      run: (input) => fetchPrice(input?.asset),
    },
    {
      id: "trust",
      price: usd(0.001), // $0.001 to check an agent before you risk money dealing with it
      desc: "Agent Reputation / Trust Oracle — on-chain trust profile + verdict BEFORE you deal. input: { agent }.",
      example: { agent: "Maxer-1" },
      run: (input, eco) => trustProfile(input?.agent, eco),
    },
    {
      id: "hash",
      price: usd(0.0001), // $0.0001
      desc: "Keccak-256 of your input string.",
      example: { data: "hello arc" },
      run: (input) => {
        const data = String(input?.data ?? "");
        return { input: data, keccak256: keccak256(toHex(data)) };
      },
    },
    {
      id: "stats",
      price: usd(0.0005), // $0.0005
      desc: "Text statistics: characters, words, sentences, lines.",
      example: { text: "Pay per call. No subscription." },
      run: (input) => {
        const t = String(input?.text ?? "");
        return {
          chars: t.length,
          words: t.trim() ? t.trim().split(/\s+/).length : 0,
          sentences: (t.match(/[.!?]+/g) || []).length,
          lines: t ? t.split(/\n/).length : 0,
        };
      },
    },
    {
      id: "compute",
      price: usd(0.001), // $0.001
      desc: "Objective compute over numbers: op = sort | sum | max.",
      example: { op: "sum", nums: [3, 1, 4, 1, 5] },
      run: (input) => {
        const nums = Array.isArray(input?.nums) ? input.nums.map(Number).filter((n: number) => Number.isFinite(n)) : [];
        if (!nums.length) throw new Error("compute requires nums: number[]");
        const op = String(input?.op ?? "sum");
        if (op === "sort") return { op, result: [...nums].sort((a, b) => a - b) };
        if (op === "max") return { op, result: Math.max(...nums) };
        return { op: "sum", result: nums.reduce((a: number, b: number) => a + b, 0) };
      },
    },
  ];
  return Object.fromEntries(list.map((s) => [s.id, s]));
}

// --- Agent Reputation / Trust Oracle — the on-chain trust profile of an agent BEFORE you deal with it.
//     This is the thing only WE have: a live ERC-8004 reputation + slashable-bond + credit graph.
//     "Should I trust agent X?" answered from real on-chain signals, with a verdict. ---
async function trustProfile(ref: unknown, eco: Economy) {
  const society = eco.society;
  const s = String(ref ?? "").trim();
  if (!s) throw new Error("trust requires input.agent (a name, agentId, or 0x address)");
  let agentId = 0n;
  let address: `0x${string}` | undefined;
  let name: string | undefined;
  const byName = society.byName(s);
  if (byName) {
    agentId = byName.agentId; address = byName.address; name = byName.name;
  } else if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
    address = s as `0x${string}`;
    agentId = await A.agentOf(address);
    name = society.agents.find((a) => a.address.toLowerCase() === s.toLowerCase())?.name;
  } else if (/^\d+$/.test(s)) {
    agentId = BigInt(s);
    const a = society.agents.find((x) => x.agentId === agentId);
    address = a?.address; name = a?.name;
  } else throw new Error(`could not resolve agent '${s}' (use a name, agentId, or 0x address)`);
  if (!agentId || agentId === 0n) throw new Error(`no on-chain identity for '${s}'`);
  if (!address) address = await A.ownerOfAgent(agentId);

  const role = await A.roleOf(agentId).catch(() => "unknown");
  const stats = await A.statsOf(agentId); // { score, jobs, completed, failed }
  const collateralized = role === "worker" || role === "producer";
  const [bond, avail, locked, debt, limit] = await Promise.all([
    collateralized ? A.bondOf(address) : Promise.resolve(0n),
    collateralized ? A.availableBond(address) : Promise.resolve(0n),
    collateralized ? A.lockedBond(address) : Promise.resolve(0n),
    A.debtOf(address),
    role === "worker" ? A.creditLimit(agentId) : Promise.resolve(0n),
  ]);

  const score = Number(stats.score);
  const completed = Number(stats.completed);
  const failed = Number(stats.failed);
  const bonded = Number(fmtUsd(bond));
  // trust score (0..100) derived from REAL on-chain signals: reputation, failures, bonded collateral
  let trust = 50 + score * 0.3 - failed * 25 + Math.min(bonded, 50) * 0.4;
  if (score < 0) trust -= 30;
  trust = Math.max(0, Math.min(100, Math.round(trust)));
  const verdict = trust >= 75 ? "TRUSTED" : trust >= 40 ? "NEUTRAL" : trust >= 15 ? "RISKY" : "AVOID";

  const reasons: string[] = [];
  if (score > 0) reasons.push(`+${score} on-chain reputation`);
  else if (score < 0) reasons.push(`NEGATIVE reputation (${score}) — previously slashed for fraud`);
  else reasons.push("no reputation history yet");
  if (bonded > 0) reasons.push(`$${bonded.toFixed(2)} bonded collateral (skin in the game)`);
  reasons.push(`${completed} job(s) completed, ${failed} failed`);
  if (Number(fmtUsd(locked)) > 0) reasons.push(`$${fmtUsd(locked)} locked in active jobs`);
  if (Number(fmtUsd(debt)) > 0) reasons.push(`$${fmtUsd(debt)} outstanding credit`);

  return {
    agent: name ?? `#${agentId}`,
    agentId: agentId.toString(),
    address,
    role,
    reputation: score,
    jobs: { completed, failed },
    bond: collateralized ? { total: fmtUsd(bond), available: fmtUsd(avail), locked: fmtUsd(locked) } : null,
    credit: { debt: fmtUsd(debt), limit: role === "worker" ? fmtUsd(limit) : null },
    trustScore: trust,
    verdict,
    reasons,
    recommendation: verdict === "TRUSTED" ? "safe to deal" : verdict === "AVOID" ? "do NOT deal" : "proceed with caution",
  };
}

interface Tab {
  id: string;
  wallet: Wallet;
  cap: bigint;
  spent: bigint;
  items: { service: string; priceUsdc: string; tx: string; at: string }[];
  createdAt: string;
}

/** Mount the public pay-per-use gateway at /x402 on the given Express app. */
export function mountGateway(app: Express, eco: Economy, society: Society): void {
  const services = makeServices();
  const producer = society.byRole("producer")[0];
  const payTo = producer.address; // the API vendor (a real agent that earns the fees)
  const faucet = society.faucet;
  const canMintDemo = SETTLEMENT_MODE !== "arc"; // MockUSDC.mint + free gas exist only on the local chain
  const consumed = new Set<string>(); // per-tx replay protection for the raw x402 path
  const tabs = new Map<string, Tab>();

  const r = express.Router();

  // --- discovery ---
  r.get("/services", (_req, res) =>
    res.json({
      payTo,
      token: dep().usdc,
      chainId: activeChain.id,
      settlement: SETTLEMENT_MODE,
      demoTabsEnabled: canMintDemo,
      services: Object.values(services).map((s) => ({
        id: s.id,
        priceUsdc: fmtUsd(s.price),
        priceUnits: s.price.toString(),
        desc: s.desc,
        example: s.example,
      })),
    })
  );

  // --- Tabs: open a capped, pre-funded spending channel (demo credit on the local chain) ---
  r.post("/tab", async (req, res) => {
    if (!canMintDemo)
      return res.status(400).json({ error: "demo tabs run only on the local chain; on Arc, fund your own wallet at https://faucet.circle.com and use the raw x402 flow" });
    const capUsdc = req.body?.capUsdc != null ? Number(req.body.capUsdc) : 0.1;
    if (!(capUsdc > 0) || capUsdc > 5) return res.status(400).json({ error: "capUsdc must be a number in (0, 5]" });
    const cap = usd(capUsdc);
    try {
      const wallet = walletFor(generatePrivateKey());
      const addr = wallet.account.address;
      // fund the tab: demo USDC credit + a little gas (local ETH) so it can send the pay-per-call transfers
      await faucet.sendTransaction({ account: faucet.account, chain: activeChain, to: addr, value: parseEther("1") });
      await usdcMint(faucet, dep().usdc, addr, cap);
      const id = "tab_" + addr.slice(2, 10);
      tabs.set(id, { id, wallet, cap, spent: 0n, items: [], createdAt: new Date().toISOString() });
      res.json({
        tabId: id,
        address: addr,
        capUsdc: fmtUsd(cap),
        spentUsdc: "0",
        remainingUsdc: fmtUsd(cap),
        note: "Demo credit (local test USDC). On Arc this is real USDC you fund yourself.",
      });
    } catch (e) {
      res.status(500).json({ error: "could not open tab: " + String((e as Error)?.message ?? e) });
    }
  });

  // pay-per-call against a tab (the server pays from the tab wallet; cap is enforced BEFORE paying)
  r.post("/tab/:id/call", async (req, res) => {
    const tab = tabs.get(req.params.id);
    if (!tab) return res.status(404).json({ error: "unknown tab" });
    const svc = services[String(req.body?.service)];
    if (!svc) return res.status(404).json({ error: "unknown service", services: Object.keys(services) });
    if (tab.spent + svc.price > tab.cap)
      return res.status(402).json({ error: "tab cap reached — an agent can never overspend its tab", capUsdc: fmtUsd(tab.cap), spentUsdc: fmtUsd(tab.spent) });

    let result: any;
    try {
      result = await svc.run(req.body?.input, eco); // compute BEFORE charging, so a bad input isn't billed
    } catch (e) {
      return res.status(400).json({ error: String((e as Error)?.message ?? e) });
    }
    let tx: string;
    try {
      const rcpt = await usdcTransfer(tab.wallet, dep().usdc, payTo, svc.price);
      tx = rcpt.transactionHash;
    } catch (e) {
      return res.status(500).json({ error: "payment failed: " + String((e as Error)?.message ?? e) });
    }
    tab.spent += svc.price;
    tab.items.push({ service: svc.id, priceUsdc: fmtUsd(svc.price), tx, at: new Date().toISOString() });
    eco.recordExternalSale(svc.price, svc.id, tab.id);
    res.json({
      service: svc.id,
      paidUsdc: fmtUsd(svc.price),
      tx,
      result,
      tab: { capUsdc: fmtUsd(tab.cap), spentUsdc: fmtUsd(tab.spent), remainingUsdc: fmtUsd(tab.cap - tab.spent), calls: tab.items.length },
    });
  });

  // the running bill for a tab (cap / spent / line items)
  r.get("/tab/:id", (req, res) => {
    const tab = tabs.get(req.params.id);
    if (!tab) return res.status(404).json({ error: "unknown tab" });
    res.json({
      tabId: tab.id,
      address: tab.wallet.account.address,
      capUsdc: fmtUsd(tab.cap),
      spentUsdc: fmtUsd(tab.spent),
      remainingUsdc: fmtUsd(tab.cap - tab.spent),
      calls: tab.items.length,
      items: tab.items,
    });
  });

  // --- Raw x402 (for external agents with their own funded wallet) ---
  // GET /x402/:service -> 402 Payment Required + terms
  r.get("/:service", async (req, res) => {
    const svc = services[req.params.service];
    if (!svc) return res.status(404).json({ error: "unknown service", services: Object.keys(services) });
    const head = await publicClient.getBlockNumber();
    res.status(402).json({
      error: "payment required",
      terms: {
        service: svc.id,
        priceUsdc: fmtUsd(svc.price),
        priceUnits: svc.price.toString(),
        payTo,
        token: dep().usdc,
        chainId: activeChain.id,
        sinceBlock: head.toString(),
        how: "transfer >= priceUnits USDC to payTo, then POST { payment: <txHash>, input } to this URL",
      },
    });
  });

  // POST /x402/:service { payment: txHash, input } -> verify on-chain, then serve
  r.post("/:service", async (req, res) => {
    const svc = services[req.params.service];
    if (!svc) return res.status(404).json({ error: "unknown service", services: Object.keys(services) });
    const payment = req.body?.payment;
    if (!payment) return res.status(402).json({ error: "payment required: POST { payment: <txHash>, input }" });

    const v = await verifyPayment(String(payment), svc.price, payTo, consumed);
    if (!v.ok) return res.status(402).json({ error: v.reason });

    let result: any;
    try {
      result = await svc.run(req.body?.input, eco);
    } catch (e) {
      return res.status(400).json({ error: String((e as Error)?.message ?? e) });
    }
    eco.recordExternalSale(svc.price, svc.id, "agent:" + String(payment).slice(0, 10));
    res.json({ service: svc.id, paidUsdc: fmtUsd(svc.price), result });
  });

  app.use("/x402", r);
  console.log(`• pay-per-use gateway mounted at /x402 (${Object.keys(services).length} services, payTo ${payTo.slice(0, 8)}…)`);
}

/** Verify a real on-chain USDC payment: a transfer to payTo of >= price, mined recently, not already used. */
async function verifyPayment(
  txHash: string,
  price: bigint,
  payTo: `0x${string}`,
  consumed: Set<string>
): Promise<{ ok: boolean; reason?: string }> {
  const key = txHash.toLowerCase();
  if (consumed.has(key)) return { ok: false, reason: "payment already used (replay rejected)" };
  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch {
    return { ok: false, reason: "payment tx not found" };
  }
  const head = await publicClient.getBlockNumber();
  if (head - receipt.blockNumber > 500n) return { ok: false, reason: "payment too old — the replay window has closed" };
  let paid = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== dep().usdc.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
      const a = ev.args as { to: `0x${string}`; value: bigint };
      if (a.to.toLowerCase() === payTo.toLowerCase()) paid += a.value;
    } catch {
      /* not a transfer */
    }
  }
  if (paid < price) return { ok: false, reason: `insufficient payment: paid ${paid} units, need ${price}` };
  consumed.add(key);
  return { ok: true };
}
