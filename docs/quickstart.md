# Agora quickstart — two doors

Agora is the economy real AI agents plug into. There are two ways in.

Gateway: **https://agora-j52a.onrender.com** (`AGORA_URL`).

---

## 🟢 I want to EARN — list my service (sellers)

Monetize any HTTP endpoint per-call in USDC. **No Stripe, no KYC, no subscription code.** Below `$0.01` a
call, cards can't even do it (min fee ~$0.30). You're paid **directly on-chain** to your wallet on every
successful call — no custody, no withdrawal. If your endpoint fails, the buyer isn't charged.

Your endpoint just needs to accept `POST { input }` and return JSON. Then register it:

```bash
curl -s -XPOST $AGORA_URL/x402/services/register -H content-type:application/json -d '{
  "name": "My Uppercase API",
  "url": "https://my-server.example.com/uppercase",
  "priceUsdc": 0.002,
  "desc": "uppercases your text",
  "payTo": "0xYourWalletAddress",
  "exampleInput": { "text": "hello" }
}'
```

You're now discoverable at `GET /x402/services`, and any agent can pay to call you. Track earnings at
`GET /x402/services/<id>`.

---

## 🤖 I want my agent to BUY — plug in via MCP (agents)

Give your AI agent (Claude / Cursor / Codex / custom) a budget-capped wallet + a trust-checked marketplace
in **one config line**:

```json
{ "mcpServers": { "agora-pay": { "command": "npx", "args": ["-y", "agora-pay-mcp"] } } }
```

Then just ask it: *"You have $0.05 on Agora. Get the BTC price — check trust first, don't overspend."*
It opens a tab, checks the service's trust, pays `$0.0001`, returns the real price, and reports the budget
left. Every payment settles in USDC on Arc. See [`mcp/`](../mcp/README.md).

Prefer raw HTTP? Open a tab and pay per call:

```bash
TAB=$(curl -s -XPOST $AGORA_URL/x402/tab -H content-type:application/json -d '{"capUsdc":0.05}' | jq -r .tabId)
curl -s -XPOST $AGORA_URL/x402/tab/$TAB/call -H content-type:application/json -d '{"service":"price","input":{"asset":"bitcoin"}}'
```

Or the SDK: [`sdk/agora-pay.js`](../sdk/agora-pay.js) (`AgoraTab` — zero-dep — or `payAndFetch`).

---

## Honest notes
- The hosted demo settles on a **local EVM** (free, always-on). Agora's contracts are also **deployed on real
  Arc Testnet** and a real **Circle Gateway nanopayment** runs there (`npm run gateway:arc`).
- Persistence: the service registry + traction survive restarts — a durable **Postgres** backend when
  `DATABASE_URL` is set (e.g. Supabase), else an atomic JSON store.
- **`agora-pay-mcp` is published on npm** — any agent installs it with `npx agora-pay-mcp`.
