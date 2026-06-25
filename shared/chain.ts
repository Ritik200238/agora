import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AGORA_NETWORK } from "./config";

export const localChain = defineChain({
  id: 31337,
  name: "Hardhat Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  // On Arc, USDC is the native gas token (18 decimals). The ERC-20 USDC used for
  // app-level transfers is 6 decimals (see USDC_DECIMALS) — these are distinct.
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.ARC_TESTNET_RPC || "https://rpc.testnet.arc.network"],
    },
  },
  blockExplorers: {
    default: { name: "Arcscan", url: "https://testnet.arcscan.app" },
  },
});

export const activeChain = AGORA_NETWORK === "arcTestnet" ? arcTestnet : localChain;

export const publicClient = createPublicClient({
  chain: activeChain,
  transport: http(),
});

export type Wallet = ReturnType<typeof createWalletClient> & { account: Account };

/** Build a wallet client for an agent from its private key. */
export function walletFor(privateKey: `0x${string}`): Wallet {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({
    account,
    chain: activeChain,
    transport: http(),
  }) as Wallet;
}
