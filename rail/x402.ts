import express, { type Express } from "express";
import { decodeEventLog, parseAbiItem } from "viem";
import { publicClient, activeChain, type Wallet } from "../shared/chain";
import { dep, SETTLEMENT_MODE } from "../shared/config";
import { ChainSettlement } from "./settlement";

/**
 * x402 service boundary — "pay to use".
 *
 * Semantics (HTTP 402 Payment Required): a request with no payment returns 402 + terms
 * (price, payTo, token, chainId). The caller pays, then retries with proof of payment; the
 * provider verifies the payment ON-CHAIN (real USDC transfer to itself, with replay protection)
 * and serves the result.
 *
 * - LOCAL: payment = a real ERC-20 USDC transfer, verified by decoding the Transfer event.
 * - ARC:   payment = Circle Gateway / Nanopayments via @circle-fin/x402-batching (gasless, batched,
 *          sub-cent). See arcGatewayPay() / arcGatewayMiddleware() — requires a funded Arc key.
 */

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export interface X402Terms {
  price: string; // USDC (6dp) as string
  payTo: `0x${string}`;
  token: `0x${string}`;
  chainId: number;
}
export interface X402Response {
  status: number;
  body: any;
}

/** A producer's x402-paywalled service (transport-agnostic core). */
export function x402Service(opts: { payTo: `0x${string}`; price: bigint; produce: () => any }) {
  const consumed = new Set<string>();
  return async function handle(paymentRef?: string): Promise<X402Response> {
    if (!paymentRef) {
      const terms: X402Terms = {
        price: opts.price.toString(),
        payTo: opts.payTo,
        token: dep().usdc,
        chainId: activeChain.id,
      };
      return { status: 402, body: { error: "payment required", terms } };
    }
    if (consumed.has(paymentRef)) return { status: 409, body: { error: "payment already used" } };

    const receipt = await publicClient.getTransactionReceipt({ hash: paymentRef as `0x${string}` });
    let paid = 0n;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== dep().usdc.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
        const a = ev.args as { to: `0x${string}`; value: bigint };
        if (a.to.toLowerCase() === opts.payTo.toLowerCase()) paid += a.value;
      } catch {
        /* not a transfer */
      }
    }
    if (paid < opts.price) {
      return { status: 402, body: { error: "insufficient payment", paid: paid.toString(), required: opts.price.toString() } };
    }
    consumed.add(paymentRef);
    return { status: 200, body: opts.produce() };
  };
}

/** A consumer pays an x402 service and returns its result (local path: real ERC-20 settlement). */
export async function x402Pay(consumer: Wallet, service: (ref?: string) => Promise<X402Response>): Promise<any> {
  const probe = await service();
  if (probe.status === 200) return probe.body;
  if (probe.status !== 402) throw new Error(`x402 unexpected: ${JSON.stringify(probe.body)}`);

  const price = BigInt(probe.body.terms.price);
  const payTo = probe.body.terms.payTo as `0x${string}`;
  const { ref } = await new ChainSettlement().pay(consumer, payTo, price, "x402");
  const res = await service(ref);
  if (res.status !== 200) throw new Error(`x402 failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Mount x402 services on an Express app at the given paths (HTTP transport for the local path). */
export function x402Router(services: Record<string, ReturnType<typeof x402Service>>): Express {
  const app = express();
  for (const [path, svc] of Object.entries(services)) {
    app.get(path, async (req, res) => {
      const ref = (req.query.payment as string) || (req.header("x-payment") ?? undefined);
      const out = await svc(ref);
      res.status(out.status).json(out.body);
    });
  }
  return app;
}

// ---------------------------------------------------------------------------
// ARC path — real Circle Gateway / Nanopayments (requires a funded Arc key).
// Lazily imported so the local path never loads the Circle SDK.
// ---------------------------------------------------------------------------

/** Pay an x402 endpoint URL on Arc via Circle Gateway. Requires SETTLEMENT=arc + PRIVATE_KEY. */
export async function arcGatewayPay(url: string): Promise<{ status: number; data: any }> {
  if (SETTLEMENT_MODE !== "arc") throw new Error("arcGatewayPay requires SETTLEMENT=arc");
  const pk = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!pk) throw new Error("arcGatewayPay requires PRIVATE_KEY (faucet-funded Arc Testnet key)");
  const { GatewayClient } = await import("@circle-fin/x402-batching/client");
  const client = new GatewayClient({ chain: "arcTestnet", privateKey: pk });
  return client.pay(url);
}

/** Build Circle's Gateway middleware so a producer can paywall an Express route on Arc. */
export async function arcGatewayMiddleware(sellerAddress: `0x${string}`) {
  const { createGatewayMiddleware } = await import("@circle-fin/x402-batching/server");
  return createGatewayMiddleware({
    sellerAddress,
    facilitatorUrl: process.env.GATEWAY_API || "https://gateway-api-testnet.circle.com",
    networks: ["eip155:5042002"],
  });
}
