# Feature map — the agentic-payments landscape → Agora

This maps **every recurring winning feature** from the competitive research (Dexter, PayAI, Skyfire,
Crossmint, Nevermined, BNBAgent, plus Visa/Mastercard/Stripe/PayPal) onto Agora's implementation.
Status: ✅ built + tested · 🟡 partial / wired-not-live · ⬜ deliberately out of scope.

| # | Winning feature (who) | Agora | Where |
| --- | --- | --- | --- |
| 1 | **Agent owns its funds** (own non-custodial wallet) — Dexter, PayAI, Skyfire | ✅ | each agent = a viem wallet + ERC-8004 soulbound passport (`agents/`, `contracts/IdentityRegistry.sol`) |
| 2 | **Tabs / capped spending channels** — Dexter's killer feature | ✅ | `dashboard/gateway.ts` tabs (cap enforced *before* spend) + `agents/treasury.ts` fail-closed firewall |
| 3 | **x402 pay-per-call (`payAndFetch`)** — Dexter, PayAI, Skyfire, Crossmint | ✅ | `rail/x402.ts` + public gateway `GET→402→pay→POST proof` + `sdk/agora-pay.js` |
| 4 | **Sub-cent / nanopayments ($0.000001)** — the whole theme | ✅ | gateway `feed` service priced at **$0.000001**; sub-cent hash/stats/compute; tested in `test/gateway.ts` |
| 5 | **Agent marketplace / hire-per-task** — PayAI | ✅ | broker collects quotes + routes each job to the best-value worker (`orchestrator/economy.ts`) + gateway services |
| 6 | **Agent identity / KYA / credentials + TRUST ORACLE** — Skyfire, Visa, Crossmint (+ **our moat**) | ✅ | ERC-8004 identity + a live **pay-per-use Agent Trust Oracle** (`/x402` `trust`): query any agent's on-chain reputation/bond/credit → **TRUSTED / AVOID** verdict before you deal. Only Agora has this graph — fraudster → `AVOID`, honest worker → `TRUSTED`. |
| 7 | **Metering / per-call billing / ledger** — Nevermined | ✅ | FlowMeter proof-of-flow receipts + per-tab line-item bill + on-chain event log |
| 8 | **Streaming / pay-per-second** — Skyfire, StreamPay | ✅ / 🟡 | `rail/flowmeter.ts` rate-metered streams (batched settle); explicit per-second UI 🟡 |
| 9 | **Programmable budgets, caps, whitelists, approval** — all | ✅ / 🟡 | SpendFirewall (budget + rate caps, anomaly halt) + tab caps ✅; merchant whitelist/human-approval 🟡 |
| 10 | **Wallet UI (cards & tabs, line-item bill, usage bar)** — Dexter | ✅ | `dashboard/public/pay.html` — tab card, cap bar, per-call bill; main dashboard shows real payins |
| 11 | **Developer SDK (`pay()` / `payAndFetch`)** — Stripe, PayPal, Dexter | ✅ | `sdk/agora-pay.js` — `AgoraTab` (zero-dep) + `payAndFetch` (viem) |
| 12 | **Circle USDC + Gateway + Arc settlement** — Crossmint, Skyfire, Nevermined | ✅ / 🟡 | USDC everywhere ✅; Circle **Gateway/Nanopayments** wired (`arcGatewayPay`) — runs only on Arc w/ funded key 🟡; Arc RPC verified live (chain 5042002) |
| 13 | **Reputation-as-collateral + credit market** — *beyond the report* | ✅ | `contracts/ReputationBond.sol` (slashable) + `contracts/LendingPool.sol` (borrow against reputation) |
| 14 | **Escrow + on-chain arbitration** — BNBAgent (ERC-8183) | ✅ | `contracts/JobBoard.sol` — fund → submit → independent re-execution → derived verdict → settle/slash |
| 15 | **Refunds / rollbacks** — PayAI, x402 | ✅ / 🟡 | escrow refunds the client on fail ✅; per-call x402 refunds 🟡 |
| 16 | **Merchant dashboard / analytics** — Skyfire, Nevermined | ✅ | live dashboard: GDP, leaderboard, feed, **real external payins counter** |
| 17 | **Virtual fiat card issuing** — Crossmint, Nevermined | ⬜ | out of scope — Agora is crypto-native (USDC), not a fiat-card MoR |
| 18 | **Cross-surface continuity** (one wallet across ChatGPT/Alexa) — Dexter | ⬜ | out of scope for the hackathon |

## Lessons from the report → how Agora applies them
- **Embed spend controls from the start** → SpendFirewall + tab caps enforce limits before any spend.
- **Use crypto rails for micropay** → USDC on Arc; sub-cent per-call; Circle Gateway for gasless batching.
- **Agent identity + trust** → ERC-8004 identity/reputation/validation + slashable bonds.
- **Developer-friendly** → `sdk/agora-pay.js`: open a tab and pay-per-call in ~3 lines.
- **Leverage standards** → ERC-8004, ERC-8183, x402, Circle USDC/Gateway.
- **Show real utility + traction** → the public gateway makes **real external payins** possible; `externalVolume` moves only on real usage (honest, distinct from the agents' internal volume).

## Honest gaps still open (the priority)
- **Real external users** — the surface now exists (`/pay` + SDK + `/x402`); we still need to *drive* real people/agents to it and grow `externalVolume` from 0.
- **Live on Arc** — deploy the contracts + settle via Circle Gateway on Arc (needs a faucet-funded key). RPC connectivity is verified.
