import { type Wallet } from "../shared/chain";
import { usdcTransfer } from "../shared/usdc";
import { dep } from "../shared/config";

export interface Settlement {
  readonly name: string;
  /** Move `amount` USDC from `payer` to `to`. Returns a settlement reference (tx hash / id). */
  pay(payer: Wallet, to: `0x${string}`, amount: bigint, memo: string): Promise<{ ref: string }>;
}

/**
 * Real USDC settlement via direct ERC-20 transfer.
 * Works on the local Hardhat chain AND on Arc Testnet (Arc's USDC at 0x3600...0000 is ERC-20).
 * This is the FlowMeter's batched-settlement backend.
 *
 * NOTE: On Arc, Circle Gateway / Nanopayments additionally offers *gasless, sub-cent, batched*
 * settlement via the x402 facilitator (see rail/x402.ts). This ChainSettlement is the universal,
 * always-available path; the Gateway path is the Arc-native optimization for per-request micro-payments.
 */
export class ChainSettlement implements Settlement {
  readonly name = "chain-erc20";
  async pay(payer: Wallet, to: `0x${string}`, amount: bigint, _memo: string) {
    if (amount <= 0n) return { ref: "noop" };
    const receipt = await usdcTransfer(payer, dep().usdc, to, amount);
    return { ref: receipt.transactionHash };
  }
}
