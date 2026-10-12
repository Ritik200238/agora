# agora-paywall

**Put a per-request USDC paywall in front of any Express/Node route — in 3 lines.** Charge per article, per API call, per photo, per song — sub-cent, settled on **Circle's Arc** via [x402](https://www.x402.org). No subscriptions, no Stripe, no KYC, no custody: you're paid **directly to your wallet**.

Below ~$0.30 a call, card networks literally can't do this. Agents can.

```bash
npm install agora-paywall viem
```

```js
import express from "express";
import { agoraPaywall } from "agora-paywall";

const app = express();

app.get("/premium/:id",
  agoraPaywall({ priceUsdc: 0.01, payTo: "0xYourWallet", rpcUrl: process.env.ARC_RPC }),
  (req, res) => res.json({ article: "…the paid content…", paidTx: req.agoraPayment.tx })
);

app.listen(3000);
```

That's it. The route now costs **$0.01 in USDC per request**.

## How it works (the x402 flow)

1. A client hits the route with **no payment** → it gets **HTTP 402** + terms:
   ```json
   { "error": "payment required",
     "terms": { "priceUsdc": 0.01, "payTo": "0xYourWallet", "token": "0x3600…0000", "chainId": 5042002,
                "claimMessage": "Agora paywall: I paid {txHash} to 0xyourwallet", "how": "…" } }
   ```
2. The client (a human wallet or an **AI agent**) transfers the USDC on-chain, signs `claimMessage` (with its
   lowercase tx hash filled in) using **the same wallet**, and **resends the request** with headers
   `X-Payment: <txHash>` and `X-Payment-Signature: <signature>`.
3. The middleware **verifies the transfer on-chain**: correct amount, sent by the signer, recent and not
   already used. Then it serves the content. Tx hashes are public, so the signature stops anyone from reusing
   a real buyer's payment. A payment can't be replayed, even by two requests sent at the same moment.

```js
// client side (viem): pay, sign, fetch
const hash = await wallet.writeContract({ address: terms.token, abi: erc20Abi, functionName: "transfer", args: [terms.payTo, BigInt(terms.priceUnits)] });
await publicClient.waitForTransactionReceipt({ hash });
const sig = await wallet.signMessage({ message: terms.claimMessage.replace("{txHash}", hash.toLowerCase()) });
const res = await fetch(url, { headers: { "X-Payment": hash, "X-Payment-Signature": sig } });
```

## Options

| option | default | notes |
|---|---|---|
| `priceUsdc` | — (required) | price per request. Supports sub-cent, e.g. `0.000001` |
| `payTo` | — (required) | your wallet — paid directly, no custody |
| `rpcUrl` | Arc testnet | any EVM RPC |
| `token` | Arc USDC `0x3600…0000` | USDC ERC-20 address on your chain |
| `chainId` | `5042002` | Arc testnet |
| `usdcDecimals` | `6` | |
| `replayWindowBlocks` | `500` | how recent a payment must be |
| `onPaid(info)` | — | called after each verified payment |

## Why Agora

`agora-paywall` works standalone. But list your endpoint on the **[Agora marketplace](https://github.com/Ritik200238/agora)** and you also get: **discovery** (agents find you), an on-chain **trust score**, an optional **bond** so buyers trust you, and **buyer-protection insurance** — the things a plain toll-gate can't offer.

Agents plug in with one line: `npx agora-pay-mcp`.

MIT · part of [Agora — the self-running agent economy on Arc](https://github.com/Ritik200238/agora).
