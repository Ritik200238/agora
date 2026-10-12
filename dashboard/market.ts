// The marketplace's on-chain layer — seller bonds (ServiceBond) and buyer protection (InsurancePool) — behind
// one interface, so the gateway runs unchanged whether the marketplace settles on the local sandbox chain or on
// real Arc. Reads go through that chain's public client; writes are signed by the gateway operator key (the
// contracts' manager).
import type { PublicClient } from "viem";
import { ABIS } from "../shared/abis";
import { dep } from "../shared/config";
import { publicClient, activeChain, type Wallet } from "../shared/chain";
import { arcPublicClient, arcWallet, arcDep, arcTxUrl, arcChain, ARC_CHAIN_ID } from "../shared/arc";

export interface Market {
  kind: "local" | "arc";
  chainId: number;
  usdc: `0x${string}`;
  serviceBond: `0x${string}`;
  insurancePool: `0x${string}`;
  client: PublicClient;
  operator: Wallet; // signs slashes + payouts (the contracts' manager)
  bondOf(seller: `0x${string}`): Promise<bigint>;
  slash(seller: `0x${string}`, amount: bigint, reason: string): Promise<string>;
  totalSlashed(): Promise<bigint>;
  insuranceAvailable(): Promise<bigint>;
  insurancePaidOut(): Promise<bigint>;
  payout(to: `0x${string}`, amount: bigint, reason: string): Promise<string>;
  usdcBalance(who: `0x${string}`): Promise<bigint>;
  /** Block-explorer link for a tx on this chain (null for the sandbox — its hashes aren't public). */
  txUrl(hash: string): string | null;
}

function build(kind: "local" | "arc", client: PublicClient, operator: Wallet, d: { usdc: `0x${string}`; serviceBond: `0x${string}`; insurancePool: `0x${string}` }, chain: any): Market {
  const read = (address: `0x${string}`, abi: any[], functionName: string, args: any[] = []) =>
    client.readContract({ address, abi, functionName, args }) as Promise<any>;
  const send = async (address: `0x${string}`, abi: any[], functionName: string, args: any[]) => {
    const hash = await operator.writeContract({ account: operator.account, chain, address, abi, functionName, args });
    const rcpt = await client.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
    return hash;
  };
  return {
    kind,
    chainId: chain.id,
    usdc: d.usdc,
    serviceBond: d.serviceBond,
    insurancePool: d.insurancePool,
    client,
    operator,
    bondOf: (seller) => read(d.serviceBond, ABIS.ServiceBond, "bondOf", [seller]),
    slash: (seller, amount, reason) => send(d.serviceBond, ABIS.ServiceBond, "slash", [seller, amount, reason]),
    totalSlashed: () => read(d.serviceBond, ABIS.ServiceBond, "totalSlashed"),
    insuranceAvailable: () => read(d.insurancePool, ABIS.InsurancePool, "available"),
    insurancePaidOut: () => read(d.insurancePool, ABIS.InsurancePool, "totalPaidOut"),
    payout: (to, amount, reason) => send(d.insurancePool, ABIS.InsurancePool, "payout", [to, amount, reason]),
    usdcBalance: (who) => read(d.usdc, ABIS.MockUSDC, "balanceOf", [who]),
    txUrl: (hash) => (kind === "arc" ? arcTxUrl(hash) : null),
  };
}

/** Marketplace on the economy's own (sandbox) chain — the operator is the local faucet/deployer key. */
export function localMarket(operator: Wallet): Market {
  const d = dep();
  return build("local", publicClient as PublicClient, operator, d, activeChain);
}

/** Marketplace on real Arc (testnet or mainnet, per ARC_NETWORK) — the operator is the funded deployer key (the contracts' manager). */
export function arcMarket(operatorKey: `0x${string}`): Market {
  const d = arcDep();
  const m = build("arc", arcPublicClient, arcWallet(operatorKey), d, arcChain);
  if (m.chainId !== ARC_CHAIN_ID) throw new Error("arc market misconfigured");
  return m;
}
