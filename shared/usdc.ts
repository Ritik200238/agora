import { parseUnits, formatUnits } from "viem";
import { publicClient, activeChain, type Wallet } from "./chain";
import { ABIS } from "./abis";
import { USDC_DECIMALS } from "./config";

/** USDC amount helpers (6 decimals). usd(10) => 10_000_000n */
export const usd = (n: number): bigint => parseUnits(n.toString(), USDC_DECIMALS);
export const fmtUsd = (v: bigint): string => formatUnits(v, USDC_DECIMALS);

async function write(wallet: Wallet, address: `0x${string}`, functionName: string, args: any[]) {
  const hash = await wallet.writeContract({
    account: wallet.account,
    chain: activeChain,
    address,
    abi: ABIS.MockUSDC,
    functionName,
    args,
  });
  return publicClient.waitForTransactionReceipt({ hash });
}

export function usdcBalance(token: `0x${string}`, who: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: ABIS.MockUSDC,
    functionName: "balanceOf",
    args: [who],
  }) as Promise<bigint>;
}

export const usdcApprove = (wallet: Wallet, token: `0x${string}`, spender: `0x${string}`, amount: bigint) =>
  write(wallet, token, "approve", [spender, amount]);

export const usdcTransfer = (wallet: Wallet, token: `0x${string}`, to: `0x${string}`, amount: bigint) =>
  write(wallet, token, "transfer", [to, amount]);

/** Local-only faucet (MockUSDC.mint). On Arc, use https://faucet.circle.com instead. */
export const usdcMint = (wallet: Wallet, token: `0x${string}`, to: `0x${string}`, amount: bigint) =>
  write(wallet, token, "mint", [to, amount]);
