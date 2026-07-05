# Agora — Submission

**Agora is payments infrastructure for AI agents on Circle's Arc.** Any agent — or developer — can charge and
pay **per API call in fractions of a cent**, settled instantly in USDC. A budget-capped agent wallet
(`npx agora-pay-mcp`), a trust-checked pay-per-use marketplace, sellers who **stake USDC**, and a
**buyer-protection insurance pool** — no subscriptions, no Stripe, no KYC, no custody.

> **Hackathon north star:** (1) an AI agent that sends/receives **tiny** USDC ($0.000001); (2) **pay-per-use**,
> not subscriptions; (3) a **real app on Arc that gets real users.** Status: settlement is proven on real Arc
> down to **$0.000001**; the marketplace, wallet (MCP), bonded trust, and insurance are live and tested. The
> open frontier is driving external traffic — the payment + trust layers underneath are done.

- **Live:** [pay-per-use](https://agora-j52a.onrender.com/pay) · [marketplace](https://agora-j52a.onrender.com/registry) · [economy dashboard](https://agora-j52a.onrender.com) · [landing](https://agora-arc.vercel.app) · [npm](https://www.npmjs.com/package/agora-pay-mcp) · [repo](https://github.com/Ritik200238/agora)
- **✅ On real Arc Testnet (chain 5042002):** contracts deployed + tiny-USDC pay-per-use **settled on-chain** — [$0.000001 nanopayment](https://testnet.arcscan.app/tx/0x29125d42028f32e6e3fd247f163b7f9cbe986a7cc01e596c3f52da48259de839) · [$0.001](https://testnet.arcscan.app/tx/0x74073eee40d40e9b5fc99425e1199715305e1f1a831917df79af2574c2d3cd8f) · [$0.0005](https://testnet.arcscan.app/tx/0x2e3b0dbd754dc33da251b903899734119fc3e9e6e4d188d25d2bf47dc6aeb9ce), each verified. Circle **Gateway / Nanopayments RUN on Arc** (`npm run gateway:arc`).
- **Run it:** `npm install && npm test` then `npm run dashboard` → http://localhost:4000

## Rubric mapping

| Axis | What Agora shows | Honest caveat |
| --- | --- | --- |
| **Agentic (30%)** | `agora-pay-mcp` gives any agent a budget-capped wallet: it discovers services, checks trust before paying, decides buy-vs-skip, and pays per call — plus a 12-agent economy that routes, validates, lends, and slashes autonomously. | The economy's fraud + hijack beats are injected on cue for the demo; skills are assigned. |
| **Traction (30%)** | A public pay-per-use marketplace anyone can list on or pay into, and a 24/7 economy of real on-chain USDC. `externalVolume` is the honest counter of real external payins. | External volume from non-team users is still early — the layer's open and live; usage is the frontier. |
| **Circle use (20%)** | USDC everywhere · ERC-8004 identity/reputation/validation · ERC-8183 escrow · **ServiceBond** collateral · **InsurancePool** buyer protection · x402 pay-per-call · **a real Circle Gateway/Nanopayments gasless nanopayment on Arc** (`npm run gateway:arc`). | The full 12-agent economy still runs on the local EVM (running all agents on Arc needs each funded). |
| **Innovation (20%)** | **Bonded, slashable trust + a buyer-protection insurance pool on Arc** — the least-mature lane in agent payments (Circle's stack leaves it open; Nava's $8.3M hasn't shipped it). Plus emergent price discovery + a reputation-backed credit market. | — |

## What's verified (actually run — see CI)

- **32 Hardhat contract tests** — escrow lifecycle, fraud→slash of the locked bond, **marketplace bond
  slashing** (`ServiceBond`), the **buyer-protection insurance pool** (`InsurancePool`), self-deal/owner-rug
  guards, soulbound passports, concurrent-job accounting, and the credit market.
- **7 end-to-end suites** against a real spawned chain — the economy (`test/e2e.ts`), pay-per-use gateway
  (`test/gateway.ts`), multi-tenant marketplace (`test/registry.ts`), seeded bonded services (`test/seed.ts`),
  the warranty/insurance flow (`test/warranty.ts`), the Postgres store (`test/pgstore.ts`), and the agent MCP
  (`test/mcp.ts`). Plus on-demand: `test:services` (real weather/FX/email), `test:paywall`.
- CI (`.github/workflows/ci.yml`) runs the whole suite on every push.

## Deployed on real Arc Testnet (chain 5042002)

All 6 contracts are live on Arc against the real USDC (`0x3600…0000`) — JobBoard `0x3b3AC51e…`, Identity
`0x23D910cE…`, Reputation `0x0e75f03C…`, Validation `0x5409b3Bb…`, Bond `0x3EaFDc33…`, LendingPool
`0x390A9A87…`. Real **tiny-USDC pay-per-use** settled on-chain (a **$0.000001** nanopayment + $0.001 / $0.0005
calls), each verified — Arcscan links above. Reproduce: `npm run deploy:arc && npm run arc:demo`.

## Submission checklist

- [x] Public GitHub repo — contracts, marketplace, MCP, paywall, insurance, tests
- [x] README with the product, the moat, and every Circle/Arc primitive used
- [x] CI proving the suite passes (32 contract tests + 7 e2e suites)
- [x] **Live landing** — https://agora-arc.vercel.app (auto-deploys from GitHub via Vercel)
- [x] **Live app** — https://agora-j52a.onrender.com (marketplace, pay-per-use, economy — 24/7 on Render)
- [x] **`agora-pay-mcp` published to npm** + directory-listing kit (`mcp/DIRECTORY-LISTINGS.md`)
- [ ] **Sub-3-minute demo video** _(recording — owner's task)_
- [ ] Submit via the official form

## Submission form — copy-paste answers

**Project name:** Agora — payments infrastructure for AI agents on Arc

**One-liner:** The money layer for AI agents: charge and pay per API call in fractions of a cent, settled in
USDC on Arc — with bonded, slashable trust and buyer-protection insurance no one else has.

**What it does:** Agora lets any AI agent (via one MCP line, `npx agora-pay-mcp`) get a budget-capped USDC
wallet and shop a trust-checked marketplace: it discovers services, checks each seller's on-chain trust
verdict, and pays sub-cent USDC per call over x402 — down to $0.000001, settled on Arc, inside a cap it can
never exceed. Any developer lists a service in one call and is paid directly on-chain per successful request
(no Stripe/KYC/subscription). The moat: sellers stake USDC (`ServiceBond`); a service that returns junk isn't
paid (schema-checked delivery), and one that keeps failing is **slashed** straight into an on-chain
**insurance pool** that refunds wronged buyers. Underneath, a fully autonomous 12-agent economy hires, prices,
validates, lends, and settles real USDC 24/7 — proof this is infrastructure, not a toy.

**How it uses Circle / Arc:** USDC for every payment (native gas on Arc; 6-dp ERC-20 for transfers) · a real
**Circle Gateway / Nanopayments** gasless batched nanopayment on Arc · x402 pay-per-call · ERC-8004
identity/reputation/validation · ERC-8183 escrow · ServiceBond collateral + InsurancePool buyer protection.
Deployed + settling real tiny-USDC on Arc Testnet (chain 5042002).

**Traction (honest):** A public pay-per-use marketplace anyone can list on or pay into, live at
agora-j52a.onrender.com, plus a 24/7 economy of continuous real on-chain USDC. We report volume honestly:
self-generated `internalVolume` (the economy) is kept separate from real `externalVolume` (external payins) —
never conflated.

**Tech stack:** Solidity 0.8.28 (OpenZeppelin v5, Cancun) · Hardhat · viem · TypeScript · Express + SSE ·
Postgres (durable) · Docker. Agents are rule-based (zero API keys, zero cost) so the system is deterministic
and fully testable — 32 contract tests + 7 e2e suites, green in CI.

**Links:** App https://agora-j52a.onrender.com · Landing https://agora-arc.vercel.app ·
npm https://www.npmjs.com/package/agora-pay-mcp · GitHub https://github.com/Ritik200238/agora · Demo video _[add after recording]_

## Demo script (≈3 min)

1. **Hook (0:20):** "Stripe can't charge a tenth of a cent. Agora can — and it's live on Arc." Show `/pay`.
2. **Pay per call (0:40):** open a tab, call `price`/`weather`/`fx` — real data returned, sub-cent USDC paid on-chain per call, cap bar moving.
3. **The marketplace + moat (0:50):** `/registry` — bonded services, the buyer-protection fund. Register a service; call a bad one → *not charged*; show a slash funding the insurance pool.
4. **The agent (0:35):** the MCP — an agent opens a budget, trust-checks, pays — one config line.
5. **Proof it's infra (0:35):** the live economy dashboard — GDP ticking, fraud slashed + frozen, firewall block.
