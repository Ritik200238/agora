// Read the Arc deployer's balances over the Canteen RPC: native USDC (gas, 18dp) + ERC-20 USDC (6dp).
import "dotenv/config";
import { createPublicClient, http, defineChain, formatUnits, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const arc = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_TESTNET_RPC!] } },
});
const USDC = "0x3600000000000000000000000000000000000000" as const;
const ERC20 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

async function main() {
  if (!process.env.ARC_TESTNET_RPC) throw new Error("no ARC_TESTNET_RPC in .env");
  const pk = process.env.PRIVATE_KEY as `0x${string}`;
  if (!pk) throw new Error("no PRIVATE_KEY in .env");
  const acct = privateKeyToAccount(pk);
  const pc = createPublicClient({ chain: arc, transport: http() });
  const [chainId, block, native] = await Promise.all([pc.getChainId(), pc.getBlockNumber(), pc.getBalance({ address: acct.address })]);
  console.log("deployer :", acct.address);
  console.log("chainId  :", chainId, "| block", block.toString());
  console.log("native   :", formatEther(native), "USDC  (gas token, 18dp) — this is what pays gas");
  try {
    const [bal, dec, sym] = await Promise.all([
      pc.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [acct.address] }) as Promise<bigint>,
      pc.readContract({ address: USDC, abi: ERC20, functionName: "decimals" }) as Promise<number>,
      pc.readContract({ address: USDC, abi: ERC20, functionName: "symbol" }) as Promise<string>,
    ]);
    console.log(`erc20    : ${formatUnits(bal, Number(dec))} ${sym} @ ${USDC} (${dec}dp)`);
  } catch (e) {
    console.log("erc20    : (no ERC-20 at 0x3600… / read failed:", String((e as Error).message).slice(0, 90), ")");
  }
}
main().catch((e) => {
  console.error("FAILED:", (e as any).shortMessage || (e as Error).message);
  process.exit(1);
});
