# Agora — Submission

**Agora is a self-running economy of autonomous AI agents that hire, pay, rate, compete, and lend to each
other 24/7, settling USDC on-chain.** The agents are both supply and demand, so it generates its own on-chain
activity — no humans, no ad spend, free funds.

> **Hackathon north star (what judges reward), added 2026-07-03:** (1) an AI agent that sends/receives **tiny** USDC
> payments (even **$0.000001**); (2) **pay-per-use** (per call / article / second), not subscriptions; (3) a **real app
> on Arc that solves an actual problem and gets real users** during the hackathon. Honest status: we have the engine
> and the rails, but the live app is still a closed simulation — 0 external users, `local` settlement, ~$1 payments.
> Closing that gap is the top priority.

- **Product spec:** [`tdd.md`](./tdd.md) · **How it works + honesty notes:** [`README.md`](./README.md)
- **Live dashboard:** [agora-j52a.onrender.com](https://agora-j52a.onrender.com) · **Landing:** [agora-arc.vercel.app](https://agora-arc.vercel.app) · **Repo:** [github.com/Ritik200238/agora](https://github.com/Ritik200238/agora)
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
  faucet-funded key) + a full multi-agent Arc deployment. Same code, different network.
- **Arc connectivity verified:** the runtime talks to **real Arc Testnet** over the Canteen-hosted RPC —
  `eth_chainId` returns **5042002** and it reads live blocks. Deploying the contracts + settling via Gateway
  on Arc still needs a faucet-funded key (the one honest blocker).

## Submission checklist

- [x] Public GitHub repo (economy engine + agents + ERC-8004 + escrow + credit + FlowMeter + dashboard + tests)
- [x] README with architecture + every Circle/Arc primitive used
- [x] Research note on the observed economic behavior (`docs/research-note.md`)
- [x] CI proving the suite passes
- [x] **Live site (landing)** — **https://agora-arc.vercel.app** (auto-deploys from GitHub via Vercel)
- [x] **Live economy dashboard** — **https://agora-j52a.onrender.com** (24/7 on Render — Docker built from GitHub)
- [ ] **Sub-3-minute demo video** — record the dashboard (GDP ticking → leaderboard → one job trace →
      inject fraud/slash → simulate hijack/firewall → cumulative volume). Link: `________`
- [ ] Submit via the official form

## Submission form — copy-paste answers

**Project name:** Agora — the self-running agent economy on Arc

**One-liner:** A self-running economy of autonomous AI agents that hire, pay, rate, compete, and lend to each
other 24/7 — settling USDC on Arc.

**What it does:** Agora boots a society of 12 autonomous agents that are *both supply and demand*. Every tick:
consumers post USDC-funded jobs (gated by a treasury spend-firewall); a broker collects competitive quotes and
routes each job to the best value (price × on-chain reputation), so prices are *discovered*, not fixed; workers
deliver re-executable results; a disinterested validator independently re-executes and the ERC-8183 escrow
*derives the verdict on-chain*. Pass → it pays the worker, broker & validator and raises reputation. Fail → it
refunds the client and *slashes the worker's locked USDC bond*. A lender runs a reputation-backed credit market
(proven workers borrow working capital, repay with interest); a producer sells a metered data feed over a
proof-of-flow rail. Emergent result: real price discovery, on-chain reputation, a fraudster that gets *frozen
out*, and a hijacked agent that the firewall blocks — with no human in the loop.

**How it uses Circle / Arc:** USDC for every payment (native gas on Arc; 6-dp ERC-20 for transfers) · ERC-8004
identity/reputation/validation (the trust layer) · ERC-8183 job escrow · reputation-as-collateral USDC bonds
(locked + slashable) · a FlowMeter proof-of-flow streaming rail · an x402 pay-to-use boundary whose Arc branch
settles via Circle Gateway/Nanopayments. Targets Arc Testnet (chain 5042002); RPC connectivity verified live
against the Canteen-hosted Arc endpoint.

**Traction (honest):** A 24/7 economy generating continuous real on-chain USDC transactions with zero humans
and zero ad spend — live at agora-j52a.onrender.com. We report volume honestly: it is self-generated
`internalVolume` (agents are both sides of every trade); `externalVolume` (non-agent wallets paying in over the
open x402 boundary) is tracked separately and is currently 0. We make no external-user-traction claim.

**Tech stack:** Solidity 0.8.28 (OpenZeppelin v5, Cancun EVM) · Hardhat · viem · TypeScript · Express + SSE ·
Docker. Agents are rule-based (zero API keys, zero cost) so the economy is deterministic and fully testable —
22 contract tests + 17 end-to-end assertions + 14 runtime checks, all green in CI.

**Links:** Live dashboard https://agora-j52a.onrender.com · Landing https://agora-arc.vercel.app ·
GitHub https://github.com/Ritik200238/agora · Demo video _[add after recording]_

## Demo script (≈3 min)

1. **Hook (0:25):** "This isn't a payments demo. It's an economy. It's been running by itself."
2. **Living dashboard (0:45):** GDP + tx/min ticking, reputation leaderboard, market rates moving.
3. **One job end-to-end (0:40):** open a job trace (`/api/job/:id`) — post → route → deliver → validate → settle.
4. **Trust under fire (0:35):** *Inject fraud* → rejected + bond slashed; *Simulate hijack* → firewall blocks it.
5. **Scale + credit (0:35):** cumulative volume + the credit market (a worker borrowing against reputation).
