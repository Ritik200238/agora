// Verifies the marketplace SEED: on boot we list real, useful house services through the same seller path
// any third party uses, back each with a REAL USDC bond, and they are genuinely callable (real loopback
// proxy + real on-chain payment). This is what stops a first visitor from landing on an empty marketplace.
// `npm run test:seed`.
import express from "express";
import { startChain } from "./harness";
import { buildSociety } from "../agents/society";
import { Economy } from "../orchestrator/economy";
import { mountGateway } from "../dashboard/gateway";
import { mountHouseEndpoints, seedMarketplace } from "../dashboard/seed";
import { fmtUsd } from "../shared/usdc";
import * as A from "../shared/contracts";

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
}
const PORT = 4078;
const base = `http://localhost:${PORT}`;
const post = (p: string, body?: any) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (p: string) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));
const getText = (p: string) => fetch(base + p).then(async (r) => ({ status: r.status, text: await r.text() }));

async function main() {
  const chain = await startChain();
  let server: any;
  try {
    const society = await buildSociety();
    const eco = new Economy(society);
    const app = express();
    app.use(express.json());
    mountHouseEndpoints(app);
    mountGateway(app, eco, society);
    server = await new Promise<any>((r) => { const s = app.listen(PORT, () => r(s)); });

    console.log("\n[marketplace seed — real bonded house services on boot]");

    const seeded = await seedMarketplace(society, PORT);
    check("boot seeds real house services", seeded >= 3, `seeded=${seeded}`);

    // 1. they appear as registered + bonded with a real on-chain stake
    const svcs = await get("/x402/services");
    const uuidSvc = svcs.body.services.find((s: any) => s.id === "svc_house_uuid");
    check("a seeded service is listed as registered + BONDED with real stake", !!uuidSvc && uuidSvc.kind === "registered" && uuidSvc.bonded === true && uuidSvc.bondUsdc === "2", `${uuidSvc?.name}: bond=$${uuidSvc?.bondUsdc}`);

    // 2. the marketplace summary reflects the real total at stake
    const m = svcs.body.marketplace;
    check("marketplace shows the real total USDC at stake", !!m && Number(m.totalBondedUsdc) >= 6 && m.bondedServices >= 3, `$${m?.totalBondedUsdc} across ${m?.bondedServices}`);

    // 3. the stake is truly on-chain (read the bond directly)
    const onchain = await A.serviceBondOf(uuidSvc.payTo);
    check("the bond is real on-chain (ServiceBond.bondOf)", onchain === 2_000_000n, `bondOf=$${fmtUsd(onchain)}`);

    // 4. it actually WORKS: pay for it via a tab → real loopback proxy → real result
    const tab = await post("/x402/tab", { capUsdc: 0.05 });
    const call = await post(`/x402/tab/${tab.body.tabId}/call`, { service: "svc_house_uuid", input: { count: 3 } });
    check("a seeded service is genuinely callable + paid on-chain", call.status === 200 && Array.isArray(call.body.result?.uuids) && call.body.result.uuids.length === 3 && !!call.body.tx, `paid $${call.body.paidUsdc}, ${call.body.result?.uuids?.length} uuids`);

    // 5. the slug service does real work too
    const slug = await post(`/x402/tab/${tab.body.tabId}/call`, { service: "svc_house_slug", input: { text: "Hello Arc World!" } });
    check("the slug house service returns a correct real result", slug.status === 200 && slug.body.result?.slug === "hello-arc-world", `slug=${slug.body.result?.slug}`);

    // 6. each seeded service is a crawlable page
    const pg = await getText("/s/svc_house_uuid");
    check("a seeded service has a crawlable page", pg.status === 200 && pg.text.includes("UUID Generator") && pg.text.includes('"@type":"Service"'), `status=${pg.status}`);
  } finally {
    if (server) server.close();
    chain.stop();
  }
  console.log(fails === 0 ? "\n✅ SEED E2E PASSED — the marketplace boots with real, bonded, callable house services." : `\n❌ ${fails} SEED CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
