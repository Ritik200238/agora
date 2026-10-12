// Arc clients that exist ALONGSIDE the economy's chain. The hosted app runs its 12-agent economy on an
// in-process sandbox chain (it sends dozens of txs a second — at ~$0.001 gas per Arc transfer that would burn
// a budget in minutes), while the public MARKETPLACE settles on real Arc. So the marketplace can't use the
// global `publicClient`/`dep()` (bound to AGORA_NETWORK); it uses these.
//
// ARC_NETWORK selects which Arc: "testnet" (default, chain 5042002) or "mainnet" (chain 5042, real USDC).
// Both values below were verified against the live endpoints (eth_chainId, Circle's /x402/supported).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, type Wallet } from "./chain";
import { ROOT, type Deployment } from "./config";

export const IS_ARC_MAINNET = process.env.ARC_NETWORK === "mainnet";

const MAINNET_RPC = process.env.ARC_MAINNET_RPC || "https://rpc.mainnet.arc.io";
export const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [MAINNET_RPC] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
});

/** The Arc chain the marketplace settles on. */
export const arcChain = IS_ARC_MAINNET ? arcMainnet : arcTestnet;
export const ARC_CHAIN_ID = arcChain.id;
export const ARC_NETWORK = `eip155:${ARC_CHAIN_ID}`; // CAIP-2, as x402 / Circle Gateway name it
export const ARC_EXPLORER = IS_ARC_MAINNET ? "https://explorer.arc.io" : "https://testnet.arcscan.app";
export const ARC_RPC = IS_ARC_MAINNET ? MAINNET_RPC : process.env.ARC_TESTNET_RPC || "https://rpc.testnet.arc.network";
/** Circle Gateway chain key for GatewayClient. */
export const GATEWAY_CHAIN: "arc" | "arcTestnet" = IS_ARC_MAINNET ? "arc" : "arcTestnet";
/** Circle's x402 facilitator for this network. */
export const DEFAULT_FACILITATOR = IS_ARC_MAINNET ? "https://gateway-api.circle.com" : "https://gateway-api-testnet.circle.com";
/** The operator key for this network: mainnet uses its own dedicated key, never the testnet one. */
export const arcOperatorKey = (): `0x${string}` | undefined =>
  (IS_ARC_MAINNET ? process.env.MAINNET_PRIVATE_KEY : process.env.PRIVATE_KEY) as `0x${string}` | undefined;

export const arcPublicClient: PublicClient = createPublicClient({ chain: arcChain, transport: http(ARC_RPC) }) as PublicClient;

export function arcWallet(privateKey: `0x${string}`): Wallet {
  return createWalletClient({ account: privateKeyToAccount(privateKey), chain: arcChain, transport: http(ARC_RPC) }) as Wallet;
}

let _arcDep: Deployment | null = null;
/** The Arc deployment (committed at deployments/arcTestnet.json / arcMainnet.json — addresses are public). */
export function arcDep(): Deployment {
  if (_arcDep) return _arcDep;
  const file = IS_ARC_MAINNET ? "arcMainnet.json" : "arcTestnet.json";
  _arcDep = JSON.parse(readFileSync(join(ROOT, "deployments", file), "utf8")) as Deployment;
  if (_arcDep.chainId !== ARC_CHAIN_ID) throw new Error(`deployments/${file} is for chain ${_arcDep.chainId}, expected ${ARC_CHAIN_ID}`);
  return _arcDep;
}

export const arcTxUrl = (hash: string) => `${ARC_EXPLORER}/tx/${hash}`;
export const arcAddressUrl = (addr: string) => `${ARC_EXPLORER}/address/${addr}`;
