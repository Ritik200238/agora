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
    const tab = await post("/x402/tab", { capUsdc: 0.1 });
    check("tab opened with pre-funded demo credit", tab.status === 200 && !!tab.body.tabId, `cap = $${tab.body.capUsdc}`);
    const tabId = tab.body.tabId;

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
    const served = await post("/x402/feed", { payment: rcpt.transactionHash, input: {} });
    check("raw x402 serves after on-chain payment proof", served.status === 200 && served.body.result?.metric === "gdp_usdc", `status ${served.status}`);
    const replay = await post("/x402/feed", { payment: rcpt.transactionHash, input: {} });
    check("raw x402 replay rejected", replay.status === 402 && /already used/i.test(replay.body.error), replay.body.error);

    check("external sales accumulated across tab + raw paths", eco.externalSales >= 3, `externalSales = ${eco.externalSales}`);
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
