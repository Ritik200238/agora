// agora-pay — a tiny client for the Agora pay-per-use gateway.
//
// Two ways for an AI agent (or app) to pay TINY USDC per call:
//   A) Tabs — no wallet needed. Open a capped tab, then call services against it. Zero deps.
//   B) Raw x402 — your agent signs a real USDC transfer with its own funded wallet. Needs viem.
//
// Example (A, tabs — runs anywhere `fetch` exists):
//   import { AgoraTab } from "./agora-pay.js";
//   const tab = new AgoraTab("https://agora-j52a.onrender.com");
//   await tab.open(0.10);                                   // $0.10 demo credit
//   const r = await tab.call("compute", { op: "sum", nums: [3,1,4] });
//   console.log(r.result, "paid", r.paidUsdc, "tx", r.tx); // -> { op:'sum', result:8 } paid 0.001 ...
//
// Example (B, raw x402 — your own funded wallet on Arc):
//   const out = await payAndFetch({ baseUrl, service: "feed", walletClient, publicClient, account, chain });

/** A) Tab client — zero dependencies. The gateway custodies a pre-funded, cap-enforced tab wallet. */
export class AgoraTab {
  constructor(baseUrl) {
    this.base = String(baseUrl).replace(/\/$/, "");
    this.tabId = null;
  }
  /** Open a capped tab (demo credit on the local chain). Returns { tabId, address, capUsdc, ... }. */
  async open(capUsdc = 0.1) {
    const j = await this.#json(`${this.base}/x402/tab`, { capUsdc });
    this.tabId = j.tabId;
    return j;
  }
  /** Pay-per-call against the tab. Returns { service, paidUsdc, tx, result, tab }. */
  async call(service, input = {}) {
    if (!this.tabId) throw new Error("open() a tab first");
    return this.#json(`${this.base}/x402/tab/${this.tabId}/call`, { service, input });
  }
  /** The running bill: { capUsdc, spentUsdc, remainingUsdc, items[] }. */
  async bill() {
    return (await fetch(`${this.base}/x402/tab/${this.tabId}`)).json();
  }
  /** List services + prices. */
  async services() {
    return (await fetch(`${this.base}/x402/services`)).json();
  }
  async #json(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j;
  }
}

const USDC_TRANSFER_ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ type: "bool" }] },
];

/**
 * B) Raw x402 payAndFetch — the Dexter/Skyfire "payAndFetch": GET a service → 402 + price terms →
 * your agent signs a USDC transfer to payTo → POST the tx as proof → get the result.
 * Pass a viem walletClient + publicClient + account (a funded wallet).
 */
export async function payAndFetch({ baseUrl, service, input = {}, walletClient, publicClient, account, chain }) {
  const base = String(baseUrl).replace(/\/$/, "");
  const probe = await (await fetch(`${base}/x402/${service}`)).json(); // 402 Payment Required + terms
  const t = probe.terms;
  if (!t) throw new Error("no payment terms: " + JSON.stringify(probe));
  const hash = await walletClient.writeContract({
    account,
    chain,
    address: t.token,
    abi: USDC_TRANSFER_ABI,
    functionName: "transfer",
    args: [t.payTo, BigInt(t.priceUnits)],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  const r = await fetch(`${base}/x402/${service}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payment: hash, input }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j; // { service, paidUsdc, result }
}
