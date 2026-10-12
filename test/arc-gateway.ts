// LIVE end-to-end: the public gateway in ARC mode — the marketplace settles on real Arc via Circle Gateway
// while the agent economy runs on its sandbox chain. Spends a few cents of testnet USDC; needs PRIVATE_KEY.
// `npm run test:arc-gateway` (not in CI).
import "./isolate"; // keep test data out of the real store (must stay first)
import "dotenv/config";
import express from "express";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { parseUnits } from "viem";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { startChain } from "./harness";
import { buildSociety } from "../agents/society";
import { Economy } from "../orchestrator/economy";
import { mountGateway } from "../dashboard/gateway";
import { arcMarket } from "../dashboard/market";
import { ArcRail, ArcTabFunder, ArcTabPool } from "../dashboard/arcrail";
import { arcWallet, arcPublicClient, arcChain, ARC_RPC, GATEWAY_CHAIN, arcOperatorKey } from "../shared/arc";

process.env.AGORA_ALLOW_PRIVATE_SELLER_URLS = "1"; // the test's third-party seller runs on localhost
let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
}
const PORT = 4093;
const base = `http://localhost:${PORT}`;
const post = (p: string, body?: any) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json() }));
const get = (p: string) => fetch(base + p).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json() }));
const ERC20 = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;

async function main() {
  const opKey = arcOperatorKey(); // PRIVATE_KEY on testnet, MAINNET_PRIVATE_KEY on mainnet (ARC_NETWORK)
  if (!opKey) {
    console.log("⏭️  ARC GATEWAY TEST SKIPPED — set PRIVATE_KEY (a funded Arc Testnet key) to run it.");
    process.exit(0);
  }
  const chain = await startChain();
  let server: any;
  try {
    const society = await buildSociety();
    const eco = new Economy(society);
    for (let i = 0; i < 2; i++) await eco.tick();
    const market = arcMarket(opKey);
    const rail = await new ArcRail(opKey).init();
    const tabsPool = new ArcTabPool(new ArcTabFunder(opKey, 100_000n), 10_000n, 0); // $0.01 tabs, no pre-fund

    const app = express();
    app.use(express.json());
    app.post("/seller-echo", (req, res) => res.json({ upper: String(req.body?.input?.text ?? "").toUpperCase() }));
    app.post("/seller-bad", (_req, res) => res.status(500).json({ error: "boom" }));
    mountGateway(app, eco, society, { market, arc: { rail, tabs: tabsPool } });
    server = await new Promise<any>((r) => { const s = app.listen(PORT, () => r(s)); });

    console.log("\n[discovery reports real Arc settlement]");
    const svcs = await get("/x402/services");
    check("the marketplace settles on Arc via Circle Gateway", svcs.body.settlement === "circle-gateway" && svcs.body.chainId === 5042002 && svcs.body.arc?.x402 === "/x402/arc/:service", `chain ${svcs.body.chainId}`);

    console.log("\n[a visitor's tab — real Gateway deposit, real nanopayments]");
    const t0 = Date.now();
    const tab = await post("/x402/tab", {});
    check("a tab opens with a real Circle Gateway deposit on Arc", tab.status === 200 && tab.body.settlement === "circle-gateway" && /arcscan/.test(tab.body.depositUrl ?? ""), `${Date.now() - t0}ms, ${tab.body.depositUrl ?? tab.body.error}`);
    const c1 = await post(`/x402/tab/${tab.body.tabId}/call`, { service: "feed" });
    check("a $0.000001 call is served and settled through Circle", c1.status === 200 && c1.body.settlement === "circle-gateway" && /^[0-9a-f-]{36}$/.test(c1.body.tx ?? "") && c1.body.result?.metric === "gdp_usdc", `transfer ${c1.body.tx ?? JSON.stringify(c1.body)}`);

    // a third-party seller, paid straight into ITS OWN Gateway balance
    const sellerKey = generatePrivateKey();
    const seller = privateKeyToAccount(sellerKey);
    const reg = await post("/x402/services/register", { name: "Upper", url: `${base}/seller-echo`, priceUsdc: 0.0005, desc: "uppercases", payTo: seller.address });
    const c2 = await post(`/x402/tab/${tab.body.tabId}/call`, { service: reg.body.service.id, input: { text: "arc" } });
    check("a third-party seller's call settles to the seller via Circle", c2.status === 200 && c2.body.result?.upper === "ARC" && !!c2.body.tx, `transfer ${c2.body.tx ?? JSON.stringify(c2.body)}`);
    const transfer = await rail.transferStatus(c2.body.tx).catch((e) => ({ error: String(e?.message ?? e) }));
    check("Circle's ledger shows the transfer to the seller", (transfer as any)?.toAddress?.toLowerCase() === seller.address.toLowerCase() && (transfer as any)?.amount === "500", `status=${(transfer as any)?.status} to=${(transfer as any)?.toAddress}`);

    const bad = await post("/x402/services/register", { name: "Broken", url: `${base}/seller-bad`, priceUsdc: 0.0005, desc: "fails", payTo: seller.address });
    const c3 = await post(`/x402/tab/${tab.body.tabId}/call`, { service: bad.body.service.id, input: {} });
    const bill = await get(`/x402/tab/${tab.body.tabId}`);
    check("a failing seller is never settled — the tab is not charged", c3.status === 502 && c3.body.charged === false && bill.body.spentUsdc === "0.000501", `spent ${bill.body.spentUsdc}`);
    const buyerGw = new GatewayClient({ chain: GATEWAY_CHAIN, privateKey: generatePrivateKey(), rpcUrl: ARC_RPC });
    await new Promise((r) => setTimeout(r, 2000));
    const tabBal = BigInt((await buyerGw.getBalances(tab.body.address)).gateway.available);
    check("the tab's real Gateway balance moved by exactly the two delivered calls", tabBal === 10_000n - 501n, `available ${tabBal}`);

    console.log("\n[an outside agent with its own Arc wallet — standard x402 over Circle Gateway]");
    const pr = await get("/x402/arc/feed");
    const required = JSON.parse(Buffer.from(pr.headers.get("payment-required") ?? "", "base64").toString("utf8") || "{}");
    check("GET without payment → 402 with a standard PAYMENT-REQUIRED header", pr.status === 402 && required.x402Version === 2 && required.accepts?.[0]?.amount === "1" && required.accepts?.[0]?.extra?.name === "GatewayWalletBatched");

    const agentKey = generatePrivateKey();
    const agent = privateKeyToAccount(agentKey);
    const op = arcWallet(opKey);
    const fund = await op.writeContract({ account: op.account, chain: arcChain, address: "0x3600000000000000000000000000000000000000", abi: ERC20, functionName: "transfer", args: [agent.address, parseUnits("0.02", 6)] });
    await arcPublicClient.waitForTransactionReceipt({ hash: fund });
    const agentClient = new GatewayClient({ chain: GATEWAY_CHAIN, privateKey: agentKey, rpcUrl: ARC_RPC });
    await agentClient.deposit("0.01");
    for (let i = 0; i < 60; i++) {
      if (BigInt((await agentClient.getBalances()).gateway.available) >= 10_000n) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    const paid: any = await agentClient.pay(`${base}/x402/arc/compute`, { method: "POST", body: { input: { op: "sum", nums: [2, 3, 4] } } });
    check("Circle's own GatewayClient.pay() buys a service from Agora end-to-end", paid?.data?.result?.result === 9 && !!paid?.transaction, `transfer ${paid?.transaction}`);
    check("external sales recorded", eco.externalSales >= 3, `externalSales=${eco.externalSales}`);
  } finally {
    if (server) server.close();
    chain.stop();
  }
  console.log(fails === 0 ? "\n✅ ARC GATEWAY PASSED — the public marketplace settles real nanopayments on Arc, charged only on delivery." : `\n❌ ${fails} ARC GATEWAY CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("ARC GATEWAY TEST CRASHED:", (e as any)?.shortMessage || (e as Error)?.message || e);
  process.exit(1);
});
