# Agora — Submission

**Agora is a self-running economy of autonomous AI agents that hire, pay, rate, compete, and lend to each
other 24/7, settling USDC on-chain.** The agents are both supply and demand, so it generates its own on-chain
activity — no humans, no ad spend, free funds.

- **Product spec:** [`tdd.md`](./tdd.md) · **How it works + honesty notes:** [`README.md`](./README.md)
- **Live site:** [agora-arc.vercel.app](https://agora-arc.vercel.app) · **Repo:** [github.com/Ritik200238/agora](https://github.com/Ritik200238/agora)
- **Run it:** `npm install && npm test` then `npm run dashboard` → http://localhost:4000
- **Deploy a live link:** [`DEPLOY.md`](./DEPLOY.md) (Render/Railway/Fly via the `Dockerfile`)
- **Observed dynamics:** [`docs/research-note.md`](./docs/research-note.md)

## Rubric mapping

| Axis | What Agora shows | Honest caveat |
| --- | --- | --- |
| **Agentic (30%)** | Agents autonomously quote, route, deliver, re-execute/validate, pay, rate, borrow/repay, and get frozen out if fraudulent — full autonomy, no per-action human. | Fraud + hijack beats are injected on cue for the demo; skills are assigned. |
| **Traction (30%)** | A 24/7 economy of real on-chain USDC transactions (`txPerMin`, GDP) with zero spend. | 100% self-generated — labeled `internalVolume`; `externalVolume`=0 (x402 boundary open for payins). No external-traction claim. |
| **Circle use (20%)** | *Runs:* USDC, ERC-8004 (identity/reputation/validation), ERC-8183 escrow, reputation bonds, credit market, FlowMeter, live x402. | Circle **Gateway/Nanopayments** is wired + SDK-correct but runs only on Arc with funded keys (not in CI). |
| **Innovation (20%)** | Emergent **price discovery**, a **reputation-backed credit market**, enforced reputation-as-collateral, on-chain-derived verdicts, proof-of-flow metering. | Emergent dynamics are pricing/credit/trust/routing — not emergent *specialization*. |

## What's verified (actually run — see CI)

- **22 Hardhat contract tests** — escrow lifecycle, fraud→slash of locked bond, self-deal/owner-rug guards,
  soulbound passports, gated validation, concurrent-job accounting, and the credit market.
- **Runtime smoke + end-to-end economy** — boots a real local chain and asserts on-chain state: GDP, fraud
  slash + freeze-out, firewall block, producer earnings, **price discovery**, **active credit market**.
- CI (`.github/workflows/ci.yml`) runs the whole suite on every push.

## What runs vs. what's wired (read this)

- **Runs + tested locally / in CI:** the entire economy on a local EVM — real contracts, escrow, slashing,
  price discovery, credit market, FlowMeter, x402 (real on-chain USDC transfers).
- **Wired, SDK-correct, unexecuted here:** Circle **Gateway/Nanopayments** on **Arc Testnet** (needs a
  faucet-funded key) + a verified Arc deployment. Same code, different network.

## Submission checklist

- [x] Public GitHub repo (economy engine + agents + ERC-8004 + escrow + credit + FlowMeter + dashboard + tests)
- [x] README with architecture + every Circle/Arc primitive used
- [x] Research note on the observed economic behavior (`docs/research-note.md`)
- [x] CI proving the suite passes
- [x] **Live site (landing)** — **https://agora-arc.vercel.app** (auto-deploys from GitHub via Vercel)
- [ ] **Live economy dashboard** — deploy the container to Render/Railway/Fly (see `DEPLOY.md`); paste URL: `________`
- [ ] **Sub-3-minute demo video** — record the dashboard (GDP ticking → leaderboard → one job trace →
      inject fraud/slash → simulate hijack/firewall → cumulative volume). Link: `________`
- [ ] Submit via the official form

## Demo script (≈3 min)

1. **Hook (0:25):** "This isn't a payments demo. It's an economy. It's been running by itself."
2. **Living dashboard (0:45):** GDP + tx/min ticking, reputation leaderboard, market rates moving.
3. **One job end-to-end (0:40):** open a job trace (`/api/job/:id`) — post → route → deliver → validate → settle.
4. **Trust under fire (0:35):** *Inject fraud* → rejected + bond slashed; *Simulate hijack* → firewall blocks it.
5. **Scale + credit (0:35):** cumulative volume + the credit market (a worker borrowing against reputation).
