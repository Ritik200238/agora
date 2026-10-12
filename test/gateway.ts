// End-to-end test of the PUBLIC pay-per-use gateway: an external client opens a capped tab, pays
// tiny USDC per call for real services, and it settles on-chain as REAL external volume. Also exercises
// the raw client-signs x402 path + replay/cap protection. `npm run test:gateway`.
import express from "express";
import { startChain } from "./harness";
import { buildSociety } from "../agents/society";
import { Economy } from "../orchestrator/economy";
import { mountGateway } from "../dashboard/gateway";
import { fmtUsd, usdcTransfer } from "../shared/usdc";
import { dep } from "../shared/config";
import { walletFor } from "../shared/chain";
import { generatePrivateKey } from "viem/accounts";

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
}

const PORT = 4055;
const base = `http://localhost:${PORT}`;
const post = (p: string, body?: any) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(
    async (r) => ({ status: r.status, body: await r.json() })
  );
const get = (p: string) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));

async function main() {
  const chain = await startChain();
  let server: any;
  try {
    console.log("• building society + booting economy…");
    const society = await buildSociety();
    const eco = new Economy(society);
    for (let i = 0; i < 3; i++) await eco.tick(); // give the data feed a live GDP
    await eco.snapshot();

    const app = express();
    app.use(express.json());
    mountGateway(app, eco, society);
    server = await new Promise<any>((resolve) => {
      const s = app.listen(PORT, () => resolve(s));
    });

    console.log("\n[pay-per-use gateway — acting as an external client]");

    // 1. discovery
    const svcs = await get("/x402/services");
    const feed = svcs.body.services.find((s: any) => s.id === "feed");
    check("services listed with sub-cent prices", svcs.status === 200 && feed?.priceUsdc === "0.000001", `feed = $${feed?.priceUsdc}`);

    // 2. open a capped tab (demo credit)
    const published: string[] = []; // everything the public /api/events feed would broadcast
    eco.emitter.on("event", (e) => published.push(JSON.stringify(e)));
    const tab = await post("/x402/tab", { capUsdc: 0.1 });
    check("tab opened with pre-funded demo credit", tab.status === 200 && !!tab.body.tabId, `cap = $${tab.body.capUsdc}`);
    const tabId = tab.body.tabId;
    check("the tab id is an unguessable 128-bit secret, not derived from its address",
      /^tab_[0-9a-f]{32}$/.test(tabId) && !tabId.includes(String(tab.body.address).slice(2, 10).toLowerCase()), tabId.slice(0, 12) + "…");

    // 3. the headline: a $0.000001 nanopayment, settled on-chain
    const c1 = await post(`/x402/tab/${tabId}/call`, { service: "feed" });
    check(
      "nanopayment call ($0.000001) settled + served",
      c1.status === 200 && c1.body.paidUsdc === "0.000001" && c1.body.result?.metric === "gdp_usdc",
      `paid $${c1.body.paidUsdc}, value ${c1.body.result?.value}`
    );
    check("…backed by a REAL on-chain tx", typeof c1.body.tx === "string" && c1.body.tx.startsWith("0x"), c1.body.tx);

    // 4. a pay-per-use compute call
    const c2 = await post(`/x402/tab/${tabId}/call`, { service: "compute", input: { op: "sum", nums: [3, 1, 4, 1, 5] } });
    check("pay-per-use compute returns the right result", c2.status === 200 && c2.body.result?.result === 14, `result = ${c2.body.result?.result}`);

    // 5. the running bill (line items)
    const bill = await get(`/x402/tab/${tabId}`);
    check("tab bill shows line items + spend", bill.body.calls === 2 && bill.body.items.length === 2, `calls ${bill.body.calls}, spent $${bill.body.spentUsdc}`);

    // 6. REAL external volume recorded on the economy (distinct from internal wash)
    check("real external volume recorded", eco.externalVolume > 0n && eco.externalSales === 2, `externalVolume $${fmtUsd(eco.externalVolume)}, sales ${eco.externalSales}`);

    // 6b. REAL data oracle — live market data (best-effort: the external API may rate-limit in CI)
    try {
      const p = await post(`/x402/tab/${tabId}/call`, { service: "price", input: { asset: "bitcoin" } });
      if (p.status === 200 && typeof p.body.result?.usd === "number" && p.body.result.usd > 0)
        check("real price oracle returns LIVE market data", true, `BTC $${p.body.result.usd} via ${p.body.result.source}`);
      else console.log(`  ⚠️  price oracle unavailable (HTTP ${p.status}) — skipped (external API), not failing CI`);
    } catch {
      console.log("  ⚠️  price oracle network error — skipped (external API), not failing CI");
    }

    // 6c. Agent Reputation / Trust Oracle — the thing only WE own. Use it as intended: check BEFORE you deal.
    for (let i = 0; i < 3; i++) { await eco.injectFraud(); await eco.tick(); } // give the fraudster an on-chain slash
    const snapT = await eco.snapshot();
    const good = snapT.leaderboard.find((a: any) => a.role === "worker" && a.score > 0)?.name || "Maxer-1";
    const gT = await post(`/x402/tab/${tabId}/call`, { service: "trust", input: { agent: good } });
    check("trust oracle: honest worker → TRUSTED/NEUTRAL (positive on-chain reputation)", gT.status === 200 && gT.body.result?.reputation > 0 && ["TRUSTED", "NEUTRAL"].includes(gT.body.result?.verdict), `${good}: ${gT.body.result?.verdict}, trust ${gT.body.result?.trustScore}`);
    const fT = await post(`/x402/tab/${tabId}/call`, { service: "trust", input: { agent: "Grift" } });
    check("trust oracle: fraudster → RISKY/AVOID (negative reputation, flagged)", fT.status === 200 && fT.body.result?.reputation < 0 && ["RISKY", "AVOID"].includes(fT.body.result?.verdict), `Grift: ${fT.body.result?.verdict}, rep ${fT.body.result?.reputation}`);
    check("trust oracle DISTINGUISHES trusted from fraud (the core value)", (gT.body.result?.trustScore ?? 0) > (fT.body.result?.trustScore ?? 100), `${gT.body.result?.trustScore} vs ${fT.body.result?.trustScore}`);

    // 7. cap enforcement — an agent can never overspend its tab
    const small = await post("/x402/tab", { capUsdc: 0.001 });
    const okCall = await post(`/x402/tab/${small.body.tabId}/call`, { service: "compute", input: { op: "sum", nums: [1] } }); // == cap
    const overCall = await post(`/x402/tab/${small.body.tabId}/call`, { service: "compute", input: { op: "sum", nums: [1] } }); // exceeds
    check("cap enforced: over-cap call refused (402)", okCall.status === 200 && overCall.status === 402 && /cap reached/i.test(overCall.body.error), `over = ${overCall.status}`);

    // 8. raw x402 for an external agent with its own funded wallet: GET 402 → pay → POST proof
    const probe = await get("/x402/feed");
    check("raw x402 returns 402 + terms before payment", probe.status === 402 && !!probe.body.terms?.payTo, `status ${probe.status}`);
    const buyer = society.byRole("consumer")[0];
    const rcpt = await usdcTransfer(buyer.wallet, dep().usdc, probe.body.terms.payTo, BigInt(probe.body.terms.priceUnits));
    const claimFor = (svc: string, tx: string) => probe.body.terms.claimMessage.replace("feed", svc).replace("{txHash}", tx.toLowerCase());
    const buyerSig = await buyer.wallet.signMessage({ account: buyer.wallet.account, message: claimFor("feed", rcpt.transactionHash) });

    // a snooper who copies the tx hash off the chain can't claim it: no signature, or a signature from the wrong wallet
    const snoop = await post("/x402/feed", { payment: rcpt.transactionHash, input: {} });
    const outsider = walletFor(generatePrivateKey());
    const snoopSig = await outsider.signMessage({ account: outsider.account, message: claimFor("feed", rcpt.transactionHash) });
    const snoop2 = await post("/x402/feed", { payment: rcpt.transactionHash, signature: snoopSig, input: {} });
    check("a copied tx hash is useless without the payer's signature", snoop.status === 402 && snoop2.status === 402 && /not from the wallet/i.test(snoop2.body.error), `${snoop.status}/${snoop2.status}: ${snoop2.body.error}`);

    // the buyer's own signature can't be stretched to a pricier service with the same payment
    const upsell = await post("/x402/trust", { payment: rcpt.transactionHash, signature: buyerSig, input: { agent: "Grift" } });
    check("a payer signature is bound to the service it was made for", upsell.status === 402, `status ${upsell.status}`);

    // the real buyer is served — and two concurrent claims of the same payment can't both win
    const [served, raced] = await Promise.all([
      post("/x402/feed", { payment: rcpt.transactionHash, signature: buyerSig, input: {} }),
      post("/x402/feed", { payment: rcpt.transactionHash, signature: buyerSig, input: {} }),
    ]);
    const wins = [served, raced].filter((r) => r.status === 200);
    check("raw x402 serves the signed payer after on-chain payment proof", wins.length >= 1 && wins[0].body.result?.metric === "gdp_usdc", `statuses ${served.status}/${raced.status}`);
    check("concurrent double-spend of one payment is refused", wins.length === 1, `${wins.length} of 2 concurrent claims served`);
    const replay = await post("/x402/feed", { payment: rcpt.transactionHash, signature: buyerSig, input: {} });
    check("raw x402 replay rejected", replay.status === 402 && /already used/i.test(replay.body.error), replay.body.error);

    check("external sales accumulated across tab + raw paths", eco.externalSales >= 3, `externalSales = ${eco.externalSales}`);

    // the public event feed reports tab sales, but never the tab id (a bearer credential)
    const saleEvents = published.filter((p) => p.includes("x402_sale"));
    check("public event feed never leaks a spendable tab id", saleEvents.length > 0 && !published.some((p) => p.includes(tabId)), `${saleEvents.length} sale events, leaked=${published.some((p) => p.includes(tabId))}`);
  } finally {
    if (server) server.close();
    chain.stop();
  }

  console.log(
    fails === 0
      ? "\n✅ GATEWAY E2E PASSED — real external pay-per-use over x402 settles tiny USDC on-chain (externalVolume moves)."
      : `\n❌ ${fails} GATEWAY CHECK(S) FAILED`
  );
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
