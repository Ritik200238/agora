// agora-paywall — put a per-request USDC paywall in front of ANY Express/Node route in 3 lines.
//
//   import { agoraPaywall } from "agora-paywall";
//   app.get("/premium/:id",
//     agoraPaywall({ priceUsdc: 0.01, payTo: "0xYourWallet", rpcUrl: process.env.ARC_RPC }),
//     (req, res) => res.json({ article: "…the paid content…" }));
//
// A request with no payment gets HTTP 402 + x402 terms (price, payTo, token, chain). The client transfers
// USDC on-chain, then resends with `X-Payment: <txHash>`; the middleware verifies the transfer on-chain
// (right amount, recent, not replayed) and serves the content. Settles on Circle's Arc by default — sub-cent
// per request, which cards can't do. No custody, no Agora account required: you're paid directly to payTo.
import { createPublicClient, http, parseUnits, parseAbiItem, decodeEventLog } from "viem";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ARC_USDC = "0x3600000000000000000000000000000000000000"; // ERC-20 USDC on Arc (6 decimals)
const ARC_RPC = "https://rpc.testnet.arc.network";
const ARC_CHAIN_ID = 5042002;

async function verifyPayment(client, txHash, price, payTo, token, consumed, windowBlocks) {
  const key = String(txHash).toLowerCase();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return { ok: false, reason: "payment must be a 0x transaction hash" };
  if (consumed.has(key)) return { ok: false, reason: "payment already used (replay rejected)" };
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: key });
  } catch {
    return { ok: false, reason: "payment tx not found (is it mined?)" };
  }
  const head = await client.getBlockNumber();
  if (head - receipt.blockNumber > BigInt(windowBlocks)) return { ok: false, reason: "payment too old — the replay window has closed" };
  let paid = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
      if (ev.args.to.toLowerCase() === payTo.toLowerCase()) paid += ev.args.value;
    } catch {
      /* not a transfer */
    }
  }
  if (paid < price) return { ok: false, reason: `insufficient payment: got ${paid} units, need ${price}` };
  consumed.add(key);
  return { ok: true, paid };
}

/**
 * Express middleware that charges `priceUsdc` per request, settled in USDC on-chain (Arc by default).
 * @param {object} opts
 * @param {number} opts.priceUsdc  price per request, e.g. 0.01 (supports sub-cent, e.g. 0.000001)
 * @param {string} opts.payTo      your wallet — paid directly, no custody
 * @param {string} [opts.rpcUrl]   chain RPC (default Arc testnet)
 * @param {string} [opts.token]    USDC ERC-20 address (default Arc USDC)
 * @param {number} [opts.chainId]  chain id (default 5042002)
 * @param {number} [opts.usdcDecimals] default 6
 * @param {number} [opts.replayWindowBlocks] how recent a payment must be (default 500)
 * @param {string} [opts.name]     label shown in the 402 terms
 * @param {(info:{tx:string,priceUsdc:number})=>void} [opts.onPaid] called after a verified payment
 */
export function agoraPaywall(opts = {}) {
  if (!(opts.priceUsdc > 0)) throw new Error("agora-paywall: priceUsdc must be > 0");
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(opts.payTo || ""))) throw new Error("agora-paywall: payTo must be a 0x wallet address");
  const decimals = opts.usdcDecimals ?? 6;
  const price = parseUnits(String(opts.priceUsdc), decimals);
  const token = opts.token || ARC_USDC;
  const chainId = opts.chainId || ARC_CHAIN_ID;
  const rpcUrl = opts.rpcUrl || ARC_RPC;
  const windowBlocks = opts.replayWindowBlocks ?? 500;
  const client = createPublicClient({ transport: http(rpcUrl) });
  const consumed = new Set();

  const terms = () => ({
    service: opts.name || "premium content",
    priceUsdc: opts.priceUsdc,
    priceUnits: price.toString(),
    payTo: opts.payTo,
    token,
    chainId,
    how: "transfer >= priceUnits USDC to payTo on this chain, then resend this request with header 'X-Payment: <txHash>'",
  });

  return async function paywall(req, res, next) {
    const payment = req.headers["x-payment"] || req.query?.payment || (req.body && req.body.payment);
    if (!payment) return res.status(402).json({ error: "payment required", terms: terms() });
    let v;
    try {
      v = await verifyPayment(client, payment, price, opts.payTo, token, consumed, windowBlocks);
    } catch (e) {
      return res.status(502).json({ error: "could not verify payment on-chain: " + (e?.message || e), terms: terms() });
    }
    if (!v.ok) return res.status(402).json({ error: v.reason, terms: terms() });
    req.agoraPayment = { tx: String(payment), priceUsdc: opts.priceUsdc, payTo: opts.payTo };
    if (typeof opts.onPaid === "function") {
      try {
        opts.onPaid(req.agoraPayment);
      } catch {
        /* publisher callback errors never block delivery */
      }
    }
    next();
  };
}

export default agoraPaywall;
