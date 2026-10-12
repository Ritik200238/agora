// The Arc operator's balances: native USDC (pays gas, 18dp) + ERC-20 USDC (6dp) + its Circle Gateway balance.
// Testnet by default; ARC_NETWORK=mainnet for Arc mainnet (uses MAINNET_PRIVATE_KEY).
import "dotenv/config";
import { formatUnits, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { arcPublicClient, arcOperatorKey, IS_ARC_MAINNET, ARC_RPC, GATEWAY_CHAIN } from "../shared/arc";

const ERC20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const;

async function main() {
  const pk = arcOperatorKey();
  if (!pk) throw new Error(`no ${IS_ARC_MAINNET ? "MAINNET_PRIVATE_KEY" : "PRIVATE_KEY"} in .env`);
  const acct = privateKeyToAccount(pk);
  const [chainId, block, native, erc20] = await Promise.all([
    arcPublicClient.getChainId(),
    arcPublicClient.getBlockNumber(),
    arcPublicClient.getBalance({ address: acct.address }),
    arcPublicClient.readContract({ address: "0x3600000000000000000000000000000000000000", abi: ERC20, functionName: "balanceOf", args: [acct.address] }),
  ]);
  console.log("network  :", IS_ARC_MAINNET ? "Arc MAINNET" : "Arc Testnet", "| chainId", chainId, "| block", block.toString());
  console.log("operator :", acct.address);
  console.log("native   :", formatEther(native), "USDC  (gas token, 18dp)");
  console.log("erc20    :", formatUnits(erc20 as bigint, 6), "USDC @ 0x3600…0000 (6dp)");
  try {
    const gw = await new GatewayClient({ chain: GATEWAY_CHAIN, privateKey: pk, rpcUrl: ARC_RPC }).getBalances();
    console.log("gateway  :", gw.gateway.formattedAvailable, "USDC available in Circle Gateway");
  } catch (e) {
    console.log("gateway  : (unavailable)", (e as Error).message.slice(0, 80));
  }
}
main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
