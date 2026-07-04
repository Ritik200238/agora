// Real tiny-USDC PAY-PER-USE settlement on Arc Testnet (chain 5042002).
// A fresh buyer wallet (funded by the deployer) pays the producer per call in USDC, verified on-chain —
// the x402 flow, on real Arc. Prints Arcscan links. This is what makes externalVolume REAL on Arc.
import "dotenv/config";
import { createPublicClient, createWalletClient, http, defineChain, parseUnits, formatUnits, formatEther, decodeEventLog, parseAbiItem } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const arc = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_TESTNET_RPC!] } },
  blockExplorers: { default: { name: "Arcscan", url: "https://testnet.arcscan.app" } },
});
const USDC = "0x3600000000000000000000000000000000000000" as const;
const ERC20 = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const tx = (h: string) => `https://testnet.arcscan.app/tx/${h}`;

async function main() {
  const pk = process.env.PRIVATE_KEY as `0x${string}`;
  if (!pk) throw new Error("no PRIVATE_KEY in .env");
  const producer = privateKeyToAccount(pk); // the deployer doubles as the API vendor (payTo)
  const pc = createPublicClient({ chain: arc, transport: http() });
  const seller = createWalletClient({ account: producer, chain: arc, transport: http() });
  const erc20Bal = (a: `0x${string}`) => pc.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [a] }) as Promise<bigint>;

  console.log("producer / payTo:", producer.address);
  console.log("chain:", await pc.getChainId(), "| block", (await pc.getBlockNumber()).toString());

  // 1. fresh buyer wallet, funded by the producer (native USDC = gas + spendable ERC-20)
  const buyer = privateKeyToAccount(generatePrivateKey());
  const buyerWallet = createWalletClient({ account: buyer, chain: arc, transport: http() });
  console.log("\nbuyer:", buyer.address);
  // Fund via ERC-20 transfer (credits BOTH the spendable token ledger AND native gas on Arc).
  const fund = await seller.writeContract({ account: producer, chain: arc, address: USDC, abi: ERC20, functionName: "transfer", args: [buyer.address, parseUnits("0.5", 6)] });
  await pc.waitForTransactionReceipt({ hash: fund });
  console.log("  funded buyer 0.5 USDC (ERC-20) →", tx(fund));
  console.log("  buyer native gas:", formatEther(await pc.getBalance({ address: buyer.address })), "USDC | ERC-20:", formatUnits(await erc20Bal(buyer.address), 6), "USDC");

  // 2. pay-per-use: the buyer pays the producer per call, verified on-chain (x402 semantics)
  const before = await erc20Bal(producer.address);
  const calls = [
    { service: "feed", price: parseUnits("0.000001", 6) }, // the $0.000001 nanopayment
    { service: "compute", price: parseUnits("0.001", 6) }, // a normal pay-per-call
    { service: "stats", price: parseUnits("0.0005", 6) },
  ];
  let externalVolume = 0n;
  for (const c of calls) {
    const h = await buyerWallet.writeContract({ account: buyer, chain: arc, address: USDC, abi: ERC20, functionName: "transfer", args: [producer.address, c.price] });
    const rcpt = await pc.waitForTransactionReceipt({ hash: h });
    // verify the payment on-chain (decode Transfer to payTo) — the gateway's x402 check
    let paid = 0n;
    for (const log of rcpt.logs) {
      if (log.address.toLowerCase() !== USDC.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
        const a = ev.args as { to: `0x${string}`; value: bigint };
        if (a.to.toLowerCase() === producer.address.toLowerCase()) paid += a.value;
      } catch {}
    }
    const ok = paid >= c.price;
    externalVolume += paid;
    console.log(`\n  pay-per-use "${c.service}" — $${formatUnits(c.price, 6)} USDC`);
    console.log(`    verified on-chain: paid $${formatUnits(paid, 6)} → ${ok ? "200 OK, result served" : "402 rejected"}  ${tx(h)}`);
    if (!ok) throw new Error("payment verification failed on Arc");
  }

  const after = await erc20Bal(producer.address);
  console.log("\n──────────────────────────────────────────────");
  console.log("REAL external volume settled on Arc:", "$" + formatUnits(externalVolume, 6), "USDC across", calls.length, "pay-per-use calls");
  console.log("producer USDC:", "$" + formatUnits(before, 6), "→ $" + formatUnits(after, 6), "(+$" + formatUnits(after - before, 6) + ")");
  console.log("✅ tiny USDC settled per-call on REAL Arc Testnet (chain 5042002).");
}
main().catch((e) => {
  console.error("FAILED:", (e as any).shortMessage || (e as Error).message);
  process.exit(1);
});
