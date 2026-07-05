// Verifies the proven-demand data services return REAL data end-to-end through the paid gateway (a real tab
// pays real tiny USDC per call). These hit live free sources (Open-Meteo, er-api, DNS), so this runs on
// demand (`npm run test:services`) rather than in the deterministic suite. No API keys.
import express from "express";
import { startChain } from "./harness";
import { buildSociety } from "../agents/society";
import { Economy } from "../orchestrator/economy";
import { mountGateway } from "../dashboard/gateway";

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
}
const PORT = 4081;
const base = `http://localhost:${PORT}`;
const post = (p: string, body?: any) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (p: string) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));

async function main() {
  const chain = await startChain();
  let server: any;
  try {
    const society = await buildSociety();
    const eco = new Economy(society);
    const app = express();
    app.use(express.json());
    mountGateway(app, eco, society);
    server = await new Promise<any>((r) => { const s = app.listen(PORT, () => r(s)); });

    console.log("\n[proven-demand data services — REAL data, paid per call]");

    const svcs = await get("/x402/services");
    const ids = svcs.body.services.map((s: any) => s.id);
    check("fx / weather / email appear in discovery", ["fx", "weather", "email"].every((i) => ids.includes(i)), ids.filter((i: string) => ["fx", "weather", "email"].includes(i)).join(", "));

    const tab = await post("/x402/tab", { capUsdc: 0.05 });

    const fx = await post(`/x402/tab/${tab.body.tabId}/call`, { service: "fx", input: { from: "USD", to: "EUR", amount: 100 } });
    check("fx returns a real live conversion", fx.status === 200 && typeof fx.body.result?.result === "number" && fx.body.result.rate > 0, `100 USD = ${fx.body.result?.result} EUR @ ${fx.body.result?.rate}`);

    const wx = await post(`/x402/tab/${tab.body.tabId}/call`, { service: "weather", input: { city: "Tokyo" } });
    check("weather returns real current conditions", wx.status === 200 && typeof wx.body.result?.tempC === "number", `Tokyo ${wx.body.result?.tempC}°C, ${wx.body.result?.conditions}`);

    const em = await post(`/x402/tab/${tab.body.tabId}/call`, { service: "email", input: { email: "founder@stripe.com" } });
    check("email deliverability via a real DNS MX lookup", em.status === 200 && em.body.result?.deliverable === true && em.body.result?.hasMx === true, `mx=${em.body.result?.mx?.[0]}`);

    const emBad = await post(`/x402/tab/${tab.body.tabId}/call`, { service: "email", input: { email: "not-an-email" } });
    check("email flags invalid syntax (still a valid delivery)", emBad.status === 200 && emBad.body.result?.valid === false, `valid=${emBad.body.result?.valid}`);

    // an unknown city fails the fetch → the buyer is NOT charged (real source, honest failure)
    const wxBad = await post(`/x402/tab/${tab.body.tabId}/call`, { service: "weather", input: { city: "zzzznotacity" } });
    check("a failed real fetch does NOT charge the buyer", wxBad.status === 400 && wxBad.body.charged === false, `status=${wxBad.status}`);
  } finally {
    if (server) server.close();
    chain.stop();
  }
  console.log(fails === 0 ? "\n✅ SERVICES E2E PASSED — weather / fx / email return REAL data, paid in tiny USDC." : `\n❌ ${fails} SERVICE CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
