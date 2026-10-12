// Arc Testnet clients that exist ALONGSIDE the economy's chain. The hosted app runs its 12-agent economy on an
// in-process sandbox chain (it sends dozens of txs a second — at ~$0.0012 gas per Arc transfer that would burn
// a faucet budget in minutes), while the public MARKETPLACE settles on real Arc. So the marketplace can't use
// the global `publicClient`/`dep()` (bound to AGORA_NETWORK); it uses these.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, type Wallet } from "./chain";
import { ROOT, type Deployment } from "./config";

export const ARC_CHAIN_ID = 5042002;
export const ARC_NETWORK = `eip155:${ARC_CHAIN_ID}`; // CAIP-2, as x402 / Circle Gateway name it
export const ARC_EXPLORER = "https://testnet.arcscan.app";
export const ARC_RPC = process.env.ARC_TESTNET_RPC || "https://rpc.testnet.arc.network";

export const arcPublicClient: PublicClient = createPublicClient({ chain: arcTestnet, transport: http(ARC_RPC) }) as PublicClient;

export function arcWallet(privateKey: `0x${string}`): Wallet {
  return createWalletClient({ account: privateKeyToAccount(privateKey), chain: arcTestnet, transport: http(ARC_RPC) }) as Wallet;
}

let _arcDep: Deployment | null = null;
/** The Arc deployment (committed at deployments/arcTestnet.json — addresses are public). */
export function arcDep(): Deployment {
  if (_arcDep) return _arcDep;
  _arcDep = JSON.parse(readFileSync(join(ROOT, "deployments", "arcTestnet.json"), "utf8")) as Deployment;
  if (_arcDep.chainId !== ARC_CHAIN_ID) throw new Error(`deployments/arcTestnet.json is for chain ${_arcDep.chainId}, expected ${ARC_CHAIN_ID}`);
  return _arcDep;
}

export const arcTxUrl = (hash: string) => `${ARC_EXPLORER}/tx/${hash}`;
export const arcAddressUrl = (addr: string) => `${ARC_EXPLORER}/address/${addr}`;
