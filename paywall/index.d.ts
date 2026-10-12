import type { RequestHandler } from "express";

export interface AgoraPaywallOptions {
  /** Price per request in USDC, e.g. 0.01 (sub-cent supported, e.g. 0.000001). */
  priceUsdc: number;
  /** Your wallet — paid directly, no custody. */
  payTo: `0x${string}` | string;
  /** Chain RPC (default: Arc testnet). */
  rpcUrl?: string;
  /** USDC ERC-20 address (default: Arc USDC). */
  token?: string;
  /** Chain id (default: 5042002). */
  chainId?: number;
  /** USDC decimals (default: 6). */
  usdcDecimals?: number;
  /** How recent (in blocks) a payment must be (default: 500). */
  replayWindowBlocks?: number;
  /** Label shown in the 402 terms. */
  name?: string;
  /** Called after each verified payment. Errors thrown here never block delivery. */
  onPaid?: (info: AgoraPayment) => void;
}

/** Attached to `req.agoraPayment` once a request's payment is verified. */
export interface AgoraPayment {
  tx: string;
  priceUsdc: number;
  payTo: string;
}

declare global {
  namespace Express {
    interface Request {
      agoraPayment?: AgoraPayment;
    }
  }
}

/** Express middleware that charges `priceUsdc` per request, verified on-chain (payer-signed, replay-safe). */
export function agoraPaywall(opts: AgoraPaywallOptions): RequestHandler;
export default agoraPaywall;
