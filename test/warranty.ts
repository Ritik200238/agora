// End-to-end test of the WARRANTY layer (Pillar 2): a buyer on Agora literally cannot lose money.
//   1. schema-validated delivery — a 200 carrying junk is NOT a valid delivery; the buyer is never charged.
//   2. slashing funds a real on-chain INSURANCE POOL (bad actors finance buyer protection).
//   3. a disputed (but charged) call is refunded from that pool + the seller is slashed to replenish it.
// `npm run test:warranty`.
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

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
}
const PORT = 4079;
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
    app.post("/w-good", (req, res) => res.json({ answer: String(req.body?.input?.q ?? "42") })); // valid delivery
    app.post("/w-junk", (_req, res) => res.json({})); // 200 but empty → invalid delivery
    mountGateway(app, eco, society);
    server = await new Promise<any>((r) => { const s = app.listen(PORT, () => r(s)); });

    console.log("\n[warranty — a buyer cannot lose money]");

    // fund a seller + bond $5 behind their services
    const sellerPk = generatePrivateKey();
    const seller = privateKeyToAccount(sellerPk);
    const sellerWallet = walletFor(sellerPk);
    await society.faucet.sendTransaction({ account: society.faucet.account, chain: activeChain, to: seller.address, value: parseEther("1") });
    await usdcMint(society.faucet, dep().usdc, seller.address, usd(20));
    await usdcApprove(sellerWallet, dep().usdc, dep().serviceBond, usd(5));
    await A.serviceBondPost(sellerWallet, usd(5));

    const good = await post("/x402/services/register", { name: "Warranted Oracle", url: `${base}/w-good`, priceUsdc: 0.002, desc: "returns an answer", payTo: seller.address, requires: ["answer"] });
    const junk = await post("/x402/services/register", { name: "Junk Oracle", url: `${base}/w-junk`, priceUsdc: 0.002, desc: "returns nothing", payTo: seller.address, requires: ["answer"] });
    const goodId = good.body.service.id, junkId = junk.body.service.id;

    // 1. the warranty contract is advertised
    check("a service declares its output contract + is warranted", good.body.service.requires?.[0] === "answer" && good.body.service.warranted === true, `requires=[${good.body.service.requires}]`);

    const tab = await post("/x402/tab", { capUsdc: 0.05 });
    const tabAddr = tab.body.address as `0x${string}`;

    // 2. junk delivery (200 but empty) → NOT charged
    const spentBefore = tab.body.spentUsdc;
    const junkCall = await post(`/x402/tab/${tab.body.tabId}/call`, { service: junkId, input: {} });
    const billAfterJunk = await get(`/x402/tab/${tab.body.tabId}`);
    check("a 200 carrying junk is rejected — buyer NOT charged", junkCall.status === 502 && junkCall.body.charged === false && junkCall.body.warranty === "invalid-delivery" && billAfterJunk.body.spentUsdc === spentBefore, `spent stayed ${billAfterJunk.body.spentUsdc}`);

    // 3. a valid delivery IS paid (and returns the answer)
    const goodCall = await post(`/x402/tab/${tab.body.tabId}/call`, { service: goodId, input: { q: "hi" } });
    check("a valid delivery is paid + returns the promised field", goodCall.status === 200 && goodCall.body.result?.answer === "hi" && !!goodCall.body.tx, `paid $${goodCall.body.paidUsdc}`);

    // 4. sustained junk slashes the seller → funds the on-chain insurance pool
    for (let i = 0; i < 3; i++) await post(`/x402/tab/${tab.body.tabId}/call`, { service: junkId, input: {} }); // now 4 junk calls total
    const poolAfterSlash = await A.insuranceAvailable();
    check("slashing a bad service funds the buyer-protection pool", poolAfterSlash > 0n, `pool=$${fmtUsd(poolAfterSlash)}`);

    // 5. dispute the (charged) good call → refunded from the pool + seller slashed to replenish
    const claim = await post("/x402/claim", { tabId: tab.body.tabId, tx: goodCall.body.tx, reason: "answer was wrong" });
    check("a buyer can file a claim on a charged call", claim.body.ok === true && claim.body.claim?.status === "open", `id=${claim.body.claim?.id}`);

    const buyerBefore = await usdcBalance(dep().usdc, tabAddr);
    const paidOutBefore = await A.insuranceTotalPaidOut();
    const resolve = await post(`/x402/admin/claim/${claim.body.claim.id}/resolve`, { approve: true });
    const buyerAfter = await usdcBalance(dep().usdc, tabAddr);
    check("an upheld claim refunds the buyer from the pool", resolve.body.ok === true && resolve.body.claim?.status === "paid" && buyerAfter - buyerBefore === 2000n, `refunded $${fmtUsd(buyerAfter - buyerBefore)}`);
    check("the insurance pool records the real payout", (await A.insuranceTotalPaidOut()) - paidOutBefore === 2000n, `paidOut +$${fmtUsd((await A.insuranceTotalPaidOut()) - paidOutBefore)}`);

    // 6. the marketplace surfaces the live buyer-protection fund
    const svcs = await get("/x402/services");
    check("discovery surfaces the buyer-protection fund", !!svcs.body.insurance && Number(svcs.body.insurance.poolUsdc) > 0 && Number(svcs.body.insurance.paidOutUsdc) > 0, `pool=$${svcs.body.insurance?.poolUsdc}, paid=$${svcs.body.insurance?.paidOutUsdc}`);
  } finally {
    if (server) server.close();
    chain.stop();
  }
  console.log(fails === 0 ? "\n✅ WARRANTY E2E PASSED — never charged for junk; bad actors fund an insurance pool that refunds wronged buyers." : `\n❌ ${fails} WARRANTY CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
