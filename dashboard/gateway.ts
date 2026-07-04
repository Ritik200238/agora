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
import type { Economy } from "../orchestrator/economy";
import type { Society } from "../agents/society";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

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
      result = svc.run(req.body?.input, eco); // compute BEFORE charging, so a bad input isn't billed
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
      result = svc.run(req.body?.input, eco);
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
