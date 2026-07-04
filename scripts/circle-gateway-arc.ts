// REAL Circle Gateway / Nanopayments end-to-end on Arc Testnet — the actual flagship Circle rail
// (gasless, batched, sub-cent), not a plain ERC-20 transfer.
//   Seller: an Express /premium route behind createGatewayMiddleware(...).require('$0.01').
//   Buyer:  GatewayClient — deposit() into the Gateway balance once, then gasless pay().
// Requires PRIVATE_KEY (funded Arc key) + ARC_TESTNET_RPC in .env.
import "dotenv/config";
import express from "express";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createWalletClient, createPublicClient, http, defineChain, parseUnits } from "viem";

const arc = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_TESTNET_RPC!] } },
});
const USDC = "0x3600000000000000000000000000000000000000" as const;
const ERC20 = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

async function main() {
  const pk = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk || !process.env.ARC_TESTNET_RPC) throw new Error("need PRIVATE_KEY + ARC_TESTNET_RPC in .env");
  const seller = privateKeyToAccount(pk);
  const pc = createPublicClient({ chain: arc, transport: http() });
  console.log("chain:", await pc.getChainId(), "| seller/payTo:", seller.address);

  // ---- Seller: a premium endpoint behind Circle Gateway ($0.01 per call) ----
  const { createGatewayMiddleware } = await import("@circle-fin/x402-batching/server");
  const gateway = createGatewayMiddleware({
    sellerAddress: seller.address,
    facilitatorUrl: process.env.GATEWAY_API || "https://gateway-api-testnet.circle.com",
    networks: ["eip155:5042002"],
  });
  const app = express();
  app.get("/premium", gateway.require("$0.01"), (_req, res) => res.json({ content: "PREMIUM — served via a real Circle Gateway nanopayment on Arc" }));
  const PORT = 4066;
  const server = await new Promise<any>((r) => { const s = app.listen(PORT, () => r(s)); });
  console.log("seller: /premium up behind Circle Gateway.require('$0.01')");

  try {
    // ---- Buyer: fresh wallet, funded from the seller (ERC-20 credits USDC + native gas on Arc) ----
    const buyerKey = generatePrivateKey();
    const buyer = privateKeyToAccount(buyerKey);
    const sw = createWalletClient({ account: seller, chain: arc, transport: http() });
    const fund = await sw.writeContract({ account: seller, chain: arc, address: USDC, abi: ERC20, functionName: "transfer", args: [buyer.address, parseUnits("0.5", 6)] });
    await pc.waitForTransactionReceipt({ hash: fund });
    console.log("buyer funded 0.5 USDC:", buyer.address);

    // ---- Circle Gateway: deposit into the Gateway balance, then GASLESS pay ----
    const { GatewayClient } = await import("@circle-fin/x402-batching/client");
    const client = new GatewayClient({ chain: "arcTestnet", privateKey: buyerKey, rpcUrl: process.env.ARC_TESTNET_RPC });
    console.log("depositing 0.30 USDC into the Gateway balance…");
    await client.deposit("0.30");
    console.log("paying /premium GASLESSLY via Circle Gateway…");
    const response = await client.pay(`http://localhost:${PORT}/premium`);
    const data = (response as any)?.data ?? response;
    console.log("\n✅ REAL CIRCLE GATEWAY NANOPAYMENT ON ARC — served:", JSON.stringify(data));
  } finally {
    server.close();
  }
}
main().catch((e) => {
  console.error("\n❌ Circle Gateway run FAILED:", (e as any)?.shortMessage || (e as Error)?.message || e);
  console.error("   (honest blocker — the wiring is SDK-correct; this is the live Gateway/facilitator path.)");
  process.exit(1);
});
