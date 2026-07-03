# 🏛️ Agora — the self-running agent economy on Arc

[![CI](https://github.com/Ritik200238/agora/actions/workflows/ci.yml/badge.svg)](https://github.com/Ritik200238/agora/actions/workflows/ci.yml)
[![Live dashboard](https://img.shields.io/badge/live_dashboard-agora--j52a.onrender.com-C2410C)](https://agora-j52a.onrender.com)
[![Landing](https://img.shields.io/badge/landing-agora--arc.vercel.app-059669)](https://agora-arc.vercel.app)
[![Open in GitHub Codespaces](https://img.shields.io/badge/Codespaces-run_the_live_economy-24292f?logo=github)](https://codespaces.new/Ritik200238/agora)
[![License: MIT](https://img.shields.io/badge/license-MIT-9CA3AF)](./LICENSE)

**🔗 Live dashboard — [agora-j52a.onrender.com](https://agora-j52a.onrender.com) (the economy, running 24/7) · Landing — [agora-arc.vercel.app](https://agora-arc.vercel.app) · Source — [github.com/Ritik200238/agora](https://github.com/Ritik200238/agora) · Or [run it on GitHub](https://codespaces.new/Ritik200238/agora)**

**Don't build a payments demo — boot up an economy and let it run.** Agora is a self-sustaining society
of autonomous AI agents that **hire, pay, rate, and compete** with each other 24/7, settling **USDC on-chain**
(a local EVM in the runnable demo; Arc Testnet with funded keys). The agents are *both supply and demand*, so
the economy generates its own **internal** on-chain volume — with zero humans, zero ad spend, and free funds.

> **FlowMeter** is its payment heart · **ERC-8004** is its trust layer · **ERC-8183** escrow settles every job.
> Full product spec: [`tdd.md`](./tdd.md).

---

## What it does (in one screen)

Each tick, the economy runs itself:

1. **Consumers** post needs (USDC-funded jobs) — gated by a **treasury spend-firewall**.
2. A **Broker** collects competitive **quotes** and routes each job to the best value (price × reputation);
   the price is **discovered**, not fixed, and expensive jobs get **priced out** (demand elasticity).
3. **Workers** deliver objective, re-executable work (honest = correct; a fraudster = tampered).
4. A **Validator** independently **re-executes** and attests on-chain (the contract derives the verdict).
5. The **JobBoard escrow** settles: pass → pay worker/broker/validator + raise reputation; fail → **refund
   the client, slash the worker's locked USDC bond, tank its reputation.**
6. A **Producer** sells a metered data feed over **FlowMeter** streams (proof-of-flow receipts, batched settle).
7. A **Lender** runs a reputation-backed **credit market** — reputable workers borrow working capital against
   their on-chain reputation and repay with interest.

**Emergent result:** prices move with supply/demand; honest workers earn *and* access credit; the fraudster is
slashed once and then *frozen out*; a hijacked agent that tries to drain funds is **blocked by the firewall**.

```mermaid
flowchart TB
  subgraph Agents["Agent society (rule-based, no API keys)"]
    CONS["Consumers (budgets)"]; BROK["Broker"]; WORK["Workers (sum/sort/max)"]
    VAL["Validator"]; PROD["Producer"]; FRAUD["Fraudster"]
  end
  subgraph Trust["Trust layer — ERC-8004 + bonds"]
    ID["IdentityRegistry"]; REP["ReputationRegistry"]; VR["ValidationRegistry"]; BOND["ReputationBond (slashable)"]
  end
  subgraph Rail["Payment rail"]
    JOB["JobBoard escrow (ERC-8183)"]; FM["FlowMeter (proof-of-flow)"]; X4["x402 boundary"]; FW["Treasury firewall"]
  end
  Agents --> JOB --> ARC["USDC settlement (Arc / local EVM)"]
  Agents --> FM --> ARC
  Agents --> Trust
  FW --> Agents
  DASH["Live dashboard (GDP, tx, reputation)"] --- ARC
```

---

## Circle / Arc primitives used

| Primitive | Where in Agora |
| --- | --- |
| **USDC** (native on Arc, 6-dp ERC-20) | every payment — escrow, streams, fees, bonds, slashes |
| **ERC-8004 Identity** | `contracts/IdentityRegistry.sol` — per-agent on-chain passport (ERC-721) |
| **ERC-8004 Reputation** | `contracts/ReputationRegistry.sol` — authorized-reporter on-chain track record |
| **ERC-8004 Validation** | `contracts/ValidationRegistry.sol` — request/respond attestation log |
| **ERC-8183 job escrow** | `contracts/JobBoard.sol` — fund → submit → validate → settle/slash |
| **Reputation-as-collateral** | `contracts/ReputationBond.sol` — post/withdraw/**lock**/slash USDC bonds |
| **Reputation-backed credit** | `contracts/LendingPool.sol` — lenders deposit USDC; workers borrow against on-chain reputation |
| **Price discovery** | `orchestrator/economy.ts` — competitive worker quotes + demand elasticity (dynamic prices) |
| **x402 service boundary** | `rail/x402.ts` — challenge-bound pay-to-use; LIVE in the economy (`x402Buy`), settled locally by a real on-chain USDC transfer |
| **Circle Gateway / Nanopayments** | `rail/x402.ts` `arcGatewayPay()` / `arcGatewayMiddleware()` — the Arc settlement branch selected by `SETTLEMENT=arc`. SDK-correct + wired, but **runs only on Arc with funded keys (not exercised in CI)** |
| **Treasury / spend policy** | `agents/treasury.ts` — fail-closed budgets + rate caps |

---

## Quickstart

**Run it live on GitHub — zero local setup:** click **[Open in Codespaces](https://codespaces.new/Ritik200238/agora)**. The
Codespace installs deps, compiles the contracts, and boots the whole economy; when port **4000** is
forwarded, open it to watch the live dashboard. (To share the URL, set port 4000 to **Public** in the Ports tab.)

Or run locally:

```bash
npm install
npm run compile        # compile contracts
npm test               # contract tests (14) + full end-to-end economy test
npm run dashboard      # boot chain + economy + live dashboard → http://localhost:4000
```

`npm run dashboard` boots a local chain, deploys the contracts, builds the agent society, and runs the
economy live — open **http://localhost:4000** to watch GDP tick up, the reputation leaderboard shift, the
fraudster get slashed, and the firewall block a hijack (buttons trigger those beats on demand).

Other commands:

```bash
TICKS=30 npm run economy   # run the economy headless for 30 ticks and print a final snapshot
npm run test:runtime       # runtime + payment-rail smoke test
npm run chain              # standalone local node
npm run deploy:local       # deploy onto a running local node
```

---

## What's verified (actually run, not stubbed)

- **`npm run test:contracts`** — 22 Hardhat tests: escrow lifecycle, payout splits, **fraud→slash of the
  locked bond**, enforced-collateral, locked-bond-can't-be-withdrawn, self-deal & owner-rug guards, soulbound
  passports, gated validation, expiry, concurrent-job lock/slash accounting, and the **credit market**
  (reputation credit limits, under-collateralized borrow, repay+interest, default recovery).
- **`npm run test:runtime`** — the TS runtime + rail against a real spawned chain: registration, a pass-job,
  a fraud-job→slash, FlowMeter metered streaming + fail-closed budget, and x402 pay-to-use.
- **`npm run test:e2e`** — boots the full economy for 20 ticks and asserts, against **real on-chain state**:
  GDP > 0, jobs completed, the fraudster slashed + reputation-negative + frozen out, the firewall blocking a
  hijack, producer stream earnings, **price discovery (prices actually vary)**, and an **active credit market**
  (loans against reputation + lender interest). (Last run: **GDP $41, 38 jobs, 23 distinct prices, 2 loans,
  fraud slashed, hijack blocked, top worker +130 reputation**.)

---

## Running on Arc Testnet

The whole system is **config-switchable to Arc Testnet** (chain ID `5042002`, USDC as native gas). The
contracts are standard Solidity/EVM and deploy as-is; the runtime points at Arc via env.

```bash
cp .env.example .env        # set PRIVATE_KEY (a faucet-funded Arc key) + ARC_TESTNET_RPC
npm run deploy:arc          # deploys Agora to Arc Testnet (uses real USDC 0x3600...0000)
AGORA_NETWORK=arcTestnet SETTLEMENT=arc npm run economy
```

> **Honest blocker (rule 4):** the full *multi-agent* economy needs each agent to hold a funded wallet, and
> Arc test-USDC comes from the **Circle faucet** (https://faucet.circle.com), which is browser/captcha-gated —
> so it can't be fully automated from CI. On Arc, fund the keys you want, or demonstrate individual primitives
> (e.g. the x402 Gateway payment path in `rail/x402.ts`). The **local** run is fully autonomous and proves the
> entire system; Arc deployment reuses the exact same code.

---

## How it maps to the judging rubric (with honest caveats)

- **Agentic (30%)** — agents autonomously discover, route, deliver, validate, pay, and rate; the broker
  reputation-gates routing so a slashed fraudster is **frozen out** — a real emergent dynamic. *Honest:* the
  fraud + hijack beats are deliberately injected on cue for the demo; worker skills are assigned, not discovered.
- **Traction (30%)** — a 24/7 economy generates real on-chain USDC transactions with zero humans and zero
  spend. **This volume is 100% self-generated (agents are both sides)** — the snapshot labels it `internalVolume`
  and reports `externalVolume` separately (currently **0**; the `x402Buy` boundary is open for non-agent payins,
  none have occurred). We do not claim external traction.
- **Circle use (20%)** — *runs in the demo:* USDC settlement (ERC-20), ERC-8004 (identity/reputation/validation),
  ERC-8183 escrow, reputation bonds, the FlowMeter rail, and the x402 pay-to-use boundary. *Wired for Arc but
  NOT exercised in CI:* Circle **Gateway / Nanopayments** via `@circle-fin/x402-batching` (the `SETTLEMENT=arc`
  branch of `x402Buy` / `arcGatewayPay`). The running economy settles via on-chain USDC transfers, not Gateway.
- **Innovation (20%)** — an *economic* agent society settling real on-chain value: **discovered prices**
  (competitive quotes + demand elasticity), a **reputation-backed credit market** (borrow against reputation),
  **enforced** reputation-as-collateral (locked + slashed), an on-chain-derived validator verdict, and
  proof-of-flow metering. *Honest:* the fraud + hijack beats are injected on cue for the demo, and worker
  skills are assigned (not discovered) — the emergent dynamics are **pricing, credit, trust, and routing**.

### What runs vs. what's wired (read this)
- **Runs + tested locally:** the entire economy on a local EVM — contracts, escrow, real slashing, FlowMeter,
  and the x402 boundary (settled by real on-chain USDC transfers). `npm test` proves it.
- **Wired, SDK-correct, but unexecuted here:** Circle Gateway/Nanopayments on **Arc Testnet** (needs a
  faucet-funded key) and a verified Arc deployment. Same code, different network — not run in this environment.

---

## Repo map

```
contracts/     ERC-8004 registries, ERC-8183 JobBoard, ReputationBond, LendingPool (credit), MockUSDC
shared/        chain clients, ABIs, USDC helpers, typed Agora contract client
rail/          settlement (ERC-20), FlowMeter (proof-of-flow), x402 boundary (local + Arc Gateway)
agents/        tasks, treasury firewall, Agent, society builder (incl. the Lender)
orchestrator/  economy.ts (world loop: jobs, price discovery, credit, streams, x402) + run.ts (CLI)
dashboard/     server.ts (SSE + /api/job trace) + public/index.html (live UI)
test/          contract tests (22), runtime smoke, end-to-end economy test, chain harness
scripts/       deploy.js  ·  Dockerfile + render.yaml + .github/workflows/ci.yml (deploy + CI)
tdd.md         the full product spec · README/DEPLOY/SUBMISSION/docs/research-note · CLAUDE.md the build rules
```

Built with Hardhat + viem + Express. Agents are rule-based (zero API keys, zero cost) so the economy runs
deterministically and is fully testable — exactly as the TDD intends.
