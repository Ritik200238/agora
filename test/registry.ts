// End-to-end test of the MULTI-TENANT gateway (the seller door): a third-party dev registers their own
// HTTP service, an agent opens a capped tab and pays for it, the seller is paid DIRECTLY on-chain, the
// registry persists to disk, and a failing seller never charges the buyer. `npm run test:registry`.
import "./isolate"; // keep test data out of the real store (must stay first)
import express from "express";
import { startChain } from "./harness";
import { buildSociety } from "../agents/society";
import { Economy } from "../orchestrator/economy";
import { mountGateway } from "../dashboard/gateway";
import { fmtUsd, usd, usdcBalance, usdcMint, usdcApprove } from "../shared/usdc";
import { dep } from "../shared/config";
import { walletFor, activeChain } from "../shared/chain";
import * as A from "../shared/contracts";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { parseEther } from "viem";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
}
// sellers in this test run on localhost — opt in to private seller URLs (production refuses them)
process.env.AGORA_ALLOW_PRIVATE_SELLER_URLS = "1";
const PORT = 4077;
const base = `http://localhost:${PORT}`;
const post = (p: string, body?: any) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(
    async (r) => ({ status: r.status, body: await r.json() })
  );
const get = (p: string) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));
/** List a service, then prove payTo ownership by signing the returned message (needed for its bond to count). */
const registerSigned = async (pk: `0x${string}`, body: any) => {
  const first = await post("/x402/services/register", body);
  if (!first.body.verifyOwnership) return first;
  const signature = await privateKeyToAccount(pk).signMessage({ message: first.body.verifyOwnership.message });
  return post("/x402/services/register", { ...body, signature });
};
const getText = (p: string) => fetch(base + p).then(async (r) => ({ status: r.status, ct: r.headers.get("content-type") || "", text: await r.text() }));

async function main() {
  const chain = await startChain();
  let server: any;
  try {
    const society = await buildSociety();
    const eco = new Economy(society);
    for (let i = 0; i < 2; i++) await eco.tick();

    const app = express();
    app.use(express.json());
    // Mock THIRD-PARTY seller endpoints (this is what an external dev would host on their own server):
    app.post("/seller-echo", (req, res) => res.json({ upper: String(req.body?.input?.text ?? "").toUpperCase(), from: "seller" }));
    app.post("/seller-bad", (_req, res) => res.status(500).json({ error: "boom" }));
    mountGateway(app, eco, society);
    server = await new Promise<any>((r) => { const s = app.listen(PORT, () => r(s)); });

    console.log("\n[multi-tenant registry — a stranger's service, paid by an agent]");

    // 1. a third-party seller registers their own service
    const sellerPk = generatePrivateKey();
    const seller = privateKeyToAccount(sellerPk);
    const reg = await registerSigned(sellerPk, {
      name: "Uppercase API", url: `${base}/seller-echo`, priceUsdc: 0.002,
      desc: "uppercases your text", payTo: seller.address, exampleInput: { text: "hi" },
    });
    check("a third-party dev can list their own service", reg.status === 200 && reg.body.ok && !!reg.body.service?.id, `id=${reg.body.service?.id}`);
    const svcId = reg.body.service.id;

    // 2. it appears in discovery with a trust verdict
    const svcs = await get("/x402/services");
    const listed = svcs.body.services.find((s: any) => s.id === svcId);
    check("it appears in discovery as a registered service w/ trust", !!listed && listed.kind === "registered" && !!listed.verdict, `${listed?.name}: ${listed?.verdict}`);

    // 3. an agent opens a capped tab + calls the STRANGER's service
    const tab = await post("/x402/tab", { capUsdc: 0.05 });
    const before = await usdcBalance(dep().usdc, seller.address);
    const callRes = await post(`/x402/tab/${tab.body.tabId}/call`, { service: svcId, input: { text: "hello arc" } });
    check("an agent pays a third-party service + gets its result", callRes.status === 200 && callRes.body.result?.upper === "HELLO ARC" && callRes.body.kind === "registered", `paid $${callRes.body.paidUsdc}`);

    // 4. the seller was paid DIRECTLY on-chain (no custody, no withdrawal)
    const after = await usdcBalance(dep().usdc, seller.address);
    check("the seller earned USDC directly on-chain", after - before === BigInt(reg.body.service.priceUnits), `+$${fmtUsd(after - before)}`);

    // 5. earnings + stats tracked
    const detail = await get(`/x402/services/${svcId}`);
    check("seller earnings + stats tracked", detail.body.stats?.calls === 1 && detail.body.stats?.revenueUsdc === "0.002", `calls=${detail.body.stats?.calls}, rev=$${detail.body.stats?.revenueUsdc}`);

    // 6. registry persisted to disk (survives a server restart)
    await new Promise((r) => setTimeout(r, 400)); // let the debounced write flush to disk
    const storeFile = process.env.AGORA_DATA_DIR ? join(process.env.AGORA_DATA_DIR, "store.json") : join(process.cwd(), ".data", "store.json");
    const persisted = existsSync(storeFile) && JSON.parse(readFileSync(storeFile, "utf8")).services?.[svcId];
    check("registry persisted to disk (survives restart)", !!persisted && String(persisted.url).includes("/seller-echo"), storeFile);

    // 7. pay-only-on-success: a failing seller never charges the buyer
    const regBad = await post("/x402/services/register", { name: "Broken API", url: `${base}/seller-bad`, priceUsdc: 0.002, desc: "always fails", payTo: seller.address });
    const badCall = await post(`/x402/tab/${tab.body.tabId}/call`, { service: regBad.body.service.id, input: {} });
    check("a failing seller returns 502 and does NOT charge the buyer", badCall.status === 502 && badCall.body.charged === false, `status=${badCall.status}`);

    // 8. real external volume moved
    check("real external volume recorded from the third-party call", eco.externalSales >= 1 && eco.externalVolume > 0n, `sales=${eco.externalSales}, vol=$${fmtUsd(eco.externalVolume)}`);

    console.log("\n[Phase 2 — the moat: sellers stake real USDC; a bad service gets slashed]");

    // fund the good seller so it can post a bond (gas + USDC on the local chain)
    const sellerWallet = walletFor(sellerPk);
    await society.faucet.sendTransaction({ account: society.faucet.account, chain: activeChain, to: seller.address, value: parseEther("1") });
    await usdcMint(society.faucet, dep().usdc, seller.address, usd(20));

    // 9. a seller stakes real USDC behind their service → BONDED, verifiable on-chain
    const beforeBond = await get(`/x402/services/${svcId}`);
    await usdcApprove(sellerWallet, dep().usdc, dep().serviceBond, usd(10));
    await A.serviceBondPost(sellerWallet, usd(10));
    const afterBond = await get(`/x402/services/${svcId}`);
    check("a seller stakes real USDC behind their service (BONDED)", afterBond.body.bonded === true && afterBond.body.bondUsdc === "10" && (await A.serviceBondOf(seller.address)) === usd(10), `bond=$${afterBond.body.bondUsdc}`);

    // 10. staking real money lifts the trust score above the un-bonded baseline (skin in the game)
    check("bonding raises the service's trust score", afterBond.body.trustScore > beforeBond.body.trustScore, `${beforeBond.body.trustScore} → ${afterBond.body.trustScore}`);

    // 11. a BONDED service that keeps failing bleeds its stake (≥50% failures over ≥4 calls → on-chain slash)
    const badPk = generatePrivateKey();
    const badSeller = privateKeyToAccount(badPk);
    const badWallet = walletFor(badPk);
    await society.faucet.sendTransaction({ account: society.faucet.account, chain: activeChain, to: badSeller.address, value: parseEther("1") });
    await usdcMint(society.faucet, dep().usdc, badSeller.address, usd(5));
    await usdcApprove(badWallet, dep().usdc, dep().serviceBond, usd(5));
    await A.serviceBondPost(badWallet, usd(5));
    const regBonded = await registerSigned(badPk, { name: "Bonded-but-broken", url: `${base}/seller-bad`, priceUsdc: 0.002, desc: "bonded yet always fails", payTo: badSeller.address });
    const bondedBadId = regBonded.body.service.id;
    const bondBefore = await A.serviceBondOf(badSeller.address);
    let lastBad: any;
    for (let i = 0; i < 4; i++) lastBad = await post(`/x402/tab/${tab.body.tabId}/call`, { service: bondedBadId, input: {} });
    const bondAfter = await A.serviceBondOf(badSeller.address);
    check("a bonded service that keeps failing gets SLASHED on-chain", bondAfter < bondBefore && !!lastBad.body?.sellerSlashed, `bond $${fmtUsd(bondBefore)} → $${fmtUsd(bondAfter)}, slashed $${lastBad.body?.sellerSlashed?.slashedUsdc}`);

    // 12. …and the buyer is STILL never charged for the failure — the bond, not the buyer, pays the price
    check("the buyer was still NOT charged for the failed call", lastBad.status === 502 && lastBad.body.charged === false, `status=${lastBad.status}`);

    console.log("\n[ownership — a stranger cannot borrow (or burn) someone else's bond]");

    // 12b. an attacker lists a dead endpoint under the bonded seller's payTo WITHOUT their signature…
    const victimBondBefore = await A.serviceBondOf(seller.address);
    const grief = await post("/x402/services/register", { name: "Griefer", url: `${base}/seller-bad`, priceUsdc: 0.001, desc: "burns the victim's bond", payTo: seller.address });
    check("an unsigned listing under someone else's payTo gets no credit for their bond",
      grief.status === 200 && grief.body.service.ownerVerified === false && grief.body.service.bondUsdc === "0" && !grief.body.service.bonded && !!grief.body.verifyOwnership,
      `bond shown=$${grief.body.service.bondUsdc}`);
    let griefCall: any;
    for (let i = 0; i < 4; i++) griefCall = await post(`/x402/tab/${tab.body.tabId}/call`, { service: grief.body.service.id, input: {} });
    const victimBondAfter = await A.serviceBondOf(seller.address);
    check("…and failing it can never slash the real owner's stake", victimBondAfter === victimBondBefore && !griefCall.body?.sellerSlashed, `victim bond $${fmtUsd(victimBondBefore)} → $${fmtUsd(victimBondAfter)}`);

    // 12c. a wrong signature is refused; an owner-verified listing can't be rewritten without one
    const forgedSig = await privateKeyToAccount(generatePrivateKey()).signMessage({ message: grief.body.verifyOwnership.message });
    const forged = await post("/x402/services/register", { name: "Griefer", url: `${base}/seller-bad`, priceUsdc: 0.001, desc: "x", payTo: seller.address, signature: forgedSig });
    const hijack = await post("/x402/services/register", { name: "Uppercase API", url: `${base}/seller-echo`, priceUsdc: 1, desc: "re-priced by a stranger", payTo: seller.address });
    const stillPriced = (await get(`/x402/services/${svcId}`)).body.priceUsdc;
    check("forged signatures are rejected; verified listings can't be hijacked", forged.status === 400 && hijack.status === 409 && stillPriced === "0.002", `forged=${forged.status}, hijack=${hijack.status}, price=$${stillPriced}`);

    // 12d. re-registering keeps the track record (no wiping failures to reset trust)
    const reReg = await post("/x402/services/register", { name: "Griefer", url: `${base}/seller-bad`, priceUsdc: 0.001, desc: "fresh start?", payTo: seller.address });
    check("re-registering a listing keeps its failures (no trust reset)", reReg.body.service.stats.calls === 4 && reReg.body.service.stats.failures === 4, `calls=${reReg.body.service.stats.calls}, failures=${reReg.body.service.stats.failures}`);

    console.log("\n[Phase 3.1 — discovery: every service is a crawlable, indexable page]");

    // 13. a registered service renders a real SSR page with SEO meta + schema.org JSON-LD
    const pg = await getText(`/s/${svcId}`);
    const hasJsonLd = pg.text.includes('"@type":"Service"') && pg.text.includes('"priceCurrency":"USDC"');
    const hasMeta = pg.text.includes("<title>") && pg.text.includes('property="og:title"') && pg.text.includes('rel="canonical"');
    check("a service renders a crawlable page with title/OG/canonical + JSON-LD", pg.status === 200 && pg.ct.includes("html") && hasJsonLd && hasMeta && pg.text.includes("Uppercase API"), `status=${pg.status}`);

    // 13b. a seller-controlled name can't break out of the JSON-LD <script> (stored XSS on /s/:id)
    const evilName = "</script><script>alert(1)</script>";
    const evil = await post("/x402/services/register", { name: evilName, url: `${base}/seller-echo`, priceUsdc: 0.001, desc: "x", payTo: seller.address });
    const evilPg = await getText(`/s/${evil.body.service?.id}`);
    const ld = evilPg.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    check("a malicious service name cannot inject a script into its page",
      evilPg.status === 200 && !evilPg.text.includes("<script>alert(1)") && !!ld && JSON.parse(ld[1]).name === evilName,
      `injected=${evilPg.text.includes("<script>alert(1)")}`);

    // 14. a built-in service is indexable too (so search traffic can find sub-cent price/trust APIs)
    const pgBuiltin = await getText("/s/price");
    check("built-in services are indexable pages as well", pgBuiltin.status === 200 && pgBuiltin.text.includes('"@type":"Service"'), `status=${pgBuiltin.status}`);

    // 15. sitemap.xml lists services; unknown ids are a noindex 404; robots points at the sitemap
    const sm = await getText("/sitemap.xml");
    const missing = await getText("/s/svc_does_not_exist");
    const robots = await getText("/robots.txt");
    check("sitemap.xml lists services; 404 is noindex; robots links the sitemap",
      sm.status === 200 && sm.text.includes(`/s/${svcId}`) && sm.text.includes("<urlset") &&
      missing.status === 404 && missing.text.includes('name="robots" content="noindex"') &&
      robots.text.includes("Sitemap:"),
      `sitemap=${sm.status}, 404=${missing.status}`);
  } finally {
    if (server) server.close();
    chain.stop();
  }
  console.log(
    fails === 0
      ? "\n✅ REGISTRY E2E PASSED — a third-party dev lists a service, an agent pays it, the seller earns on-chain."
      : `\n❌ ${fails} REGISTRY CHECK(S) FAILED`
  );
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
