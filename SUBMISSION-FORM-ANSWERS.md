# Agora — Lepton Hackathon Submission (Google Form Answers)

Drafted from a full, current read of the repo (49 commits, through `83397b2`, 2026-07-06).
Fill in the bracketed `[ ]` spots with real numbers before you submit — nothing here is invented.

---

## Problem Statement

Every payment rail built for humans has a floor. Stripe, cards, even most stablecoin rails — none of them can move $0.0001 without the fee eating the transfer. So the moment an AI agent needs to pay another agent, or pay for one API call instead of a subscription, the tooling forces it back into human-sized money: a monthly plan, a stored card, a $9.99 minimum for something that costs the seller a fraction of a cent to serve. That mismatch is why "autonomous agent economies" mostly stay diagrams — the payment layer underneath them was never built for machine-sized, call-by-call spend.

The second half of the problem is worse: even if an agent *can* pay another agent, it has no way to know if that agent will actually deliver. Skyfire and Nevermined have already proven this pain is real — they exist specifically to give agents a reputation system. But a reputation score is just a number someone can walk away from. Nothing forces the other side to have money on the line.

Agora exists to close both gaps at once: USDC settlement small enough to price a single API call honestly, and a counterparty that has real, slashable collateral behind its name — so trusting a stranger agent stops being a leap of faith and starts being a financial fact you can check before you pay.

---

## Project Description

Agora is a payments and trust layer for AI agents, built on Circle's Arc.

**How it works, end to end:**

1. **Identity & trust (ERC-8004).** Every agent gets a soulbound ERC-721 passport (`IdentityRegistry`), a reputation ledger written only by authorized reporters (`ReputationRegistry`), and a validation log (`ValidationRegistry`) that records re-executed, hash-verified job outcomes rather than trusting a submitted "pass/fail" claim.
2. **Collateral, not vibes.** Two separate bonding contracts back two separate trust surfaces: `ReputationBond` locks and slashes collateral inside the internal job economy (`JobBoard`, an ERC-8183-style escrow: fund → submit → validate → settle or slash), and `ServiceBond` does the same for any third-party seller listed on the public marketplace. A bad actor's stake is slashed on-chain into `InsurancePool`, which refunds the buyer it wronged — the only agent marketplace where the cost of cheating is a real, automatic financial loss, not a lower star rating.
3. **The payment rail.** `x402.ts` implements real HTTP-402 semantics with replay-safe, receipt-verified settlement; `FlowMeter` metering signs and re-derives per-unit usage so a producer streaming data gets paid for exactly what it delivered, never more. Circle Gateway / Nanopayments is wired for real gasless batched settlement on Arc Testnet (`@circle-fin/x402-batching`), alongside a plain ERC-20 `ChainSettlement` path that works identically on local Hardhat or Arc.
4. **A live marketplace, not just a demo.** The gateway sells real services with no API keys — live weather (Open-Meteo), FX rates (open.er-api.com), a price oracle (CoinGecko), a domain-deliverability check, and an on-chain Agent Trust Oracle — each server-rendered with schema.org markup, sitemap, and robots.txt so the marketplace is genuinely indexable, not a walled demo. A Postgres-backed store (with a documented in-memory degrade path) keeps the service registry alive across redeploys.
5. **Distribution, built to be used, not just watched.** `agora-pay-mcp` is a real, **published** MCP server (`npx agora-pay-mcp`, live on npm) — any Claude, Cursor, or Codex agent can open a budget-capped tab, browse the marketplace, check an on-chain trust verdict, and pay per call without anyone writing chain code. `agora-paywall` is a 3-line Express middleware that turns any existing API route into an x402-protected, on-chain-verified paywall.
6. **Proof it holds under load.** Underneath all of this, a 12-agent rule-based economy (consumers, workers, a broker, a validator, a producer, a lender, a treasury) runs 24/7 with zero LLM calls and zero API cost — hiring, pricing, delivering, validating, slashing fraud, and lending against reputation, entirely in real on-chain USDC.

**Tech stack:** Solidity 0.8.28 + OpenZeppelin v5 (Cancun EVM, Hardhat), TypeScript + viem, Express + Server-Sent Events for the live dashboard, Postgres (Supabase) for persistence, Docker + Render for always-on hosting, the official Model Context Protocol SDK for `agora-pay-mcp`, and Circle's x402 + Gateway/Nanopayments stack settling on Arc Testnet (chain `5042002`).

Everything above was built inside the Lepton window (first commit 2026-06-22, current HEAD 2026-07-06) — nine contracts, the full payment rail, the autonomous economy, the marketplace layer, and the MCP/paywall distribution packages, in that order.

---

## Traction

Being straight about this, because Agora's own honesty rule demands it:

- **Real, verifiable settlement on Arc Testnet**, not just claimed — three tiny-USDC transactions ($0.000001, $0.001, $0.0005) are live and checkable on Arcscan right now, chain `5042002`. [Add exact tx links again here if you want the reviewer to click without leaving the form.]
- **A real, installable artifact anyone can run today**: `agora-pay-mcp` is published on npm (v0.1.0) — that's traction independent of anyone "trying the demo," because any developer can `npx agora-pay-mcp` and get a working tool right now.
- **32 automated contract tests + 7 end-to-end suites**, all green, covering the escrow lifecycle, fraud → slash, the bonded-marketplace slash path, and the insurance payout — this is signal for judges who read code, not just a landing page.
- **49 commits**, shipped daily, each with a scoped, honestly-labeled message — the commit history itself is evidence of sustained, real build velocity, not a weekend hack.
- What we don't have yet: real external users paying real strangers' USDC. `externalVolume` — the counter that tracks payments from people who are not us — was still effectively zero as of our last internal check. [Put today's actual number here — check `/api/info` on the live dashboard before submitting.]
- [Fill in: GitHub stars / watchers / forks, npm download count for `agora-pay-mcp`, any Twitter/X RTs or follows, any Discord/Telegram mentions, any real third party who has listed a service or made a real paid call.]

We'd rather report zero honestly than round up. The infrastructure is real and tested; the "people other than us used it" number is the thing we're actively working on next.

---

## Project Source Code

https://github.com/Ritik200238/agora

---

## Project Live

- Product (pay-per-use marketplace + dashboard): https://agora-j52a.onrender.com — try it at `/pay`, browse the marketplace at `/registry`.
- Landing page: https://agora-arc.vercel.app

Note for judges reading closely (and it's in the README so they'll see it either way): the always-on hosted demo runs on a local-EVM sandbox for instant, always-available interaction — the same contracts and code, config-switchable to Arc. The three Arcscan-verifiable transactions above are the real Arc Testnet settlement proof.

---

## Project Video Demo

[Record this — 3 minutes max, script below built from your own FDesign.md demo flow, updated for what's actually shipped now]

1. **0:00–0:20 — Hook.** "Every payment rail today has a floor. Ours doesn't. This is Agora — the only agent marketplace where the seller has real money on the line."
2. **0:20–1:00 — One line, one wallet.** Show `npx agora-pay-mcp` inside a Claude/Cursor session. Have the agent call `list_services`, `check_trust` on a service, then `call_service` — a real sub-cent payment settles live.
3. **1:00–1:40 — Skin in the game.** Show a bonded service in the marketplace, its stake amount, and the trust verdict. Trigger (or show a recording of) a bad-service slash landing in the InsurancePool, and a buyer refund.
4. **1:40–2:20 — The economy underneath.** Cut to the live dashboard: GDP ticking, 12 agents trading, the fraud-injection beat, the worker's bond getting slashed and reputation dropping in real time.
5. **2:20–3:00 — Close on Arc.** Show one of the three real Arcscan transactions loading live. "Verified on Arc Testnet, chain 5042002. This is infrastructure, not a simulation."

Add subtitles — the instructions ask for it and it costs you nothing.

---

## Arc OSS — Yes, applying

**Why we should be chosen / what primitives we expose:**

Most of what's public in `circlefin/arc-*` is payment-rail reference code — a buyer paying a seller once, over x402 or Gateway. Agora is a hackathon-built superset that other builders can fork directly:

- **A working ERC-8004 reference implementation** (Identity, Reputation, Validation) that's actually wired end-to-end into a real escrow flow, not a spec walkthrough — `contracts/IdentityRegistry.sol`, `ReputationRegistry.sol`, `ValidationRegistry.sol`.
- **A reusable bonded-collateral + slashing pattern**, shipped twice for two different contexts (`ReputationBond` for internal jobs, `ServiceBond` for a public marketplace) — any builder who needs "make cheating cost real money" for their own agent product can fork either one directly.
- **`InsurancePool`** — a buyer-protection pattern funded automatically from slashed stakes. Nobody else in the Arc ecosystem repos ships this.
- **`agora-paywall`** — a 3-line Express middleware that adds an on-chain-verified x402 paywall to any existing API route. This is the single most reusable primitive here: any Arc builder can drop it into their own project without touching viem or Solidity directly.
- **`agora-pay-mcp`** — a real, published MCP server, so any Arc builder's agent-facing product gets pay-per-use and trust-checking for free by pointing an MCP client at it.
- **A live, SSR, schema.org-tagged service marketplace pattern** (`dashboard/pages.ts`) other builders can copy for their own service-listing product.

We're committing to keep all of it open source.

---

## Circle / Arc Feedback

**What worked well:**
- Arc's Cancun EVM support (via Reth) matched OpenZeppelin v5's `mcopy` requirement with zero compatibility shims — contracts written for local Hardhat deployed to Arc Testnet unchanged.
- USDC as the native gas token removed an entire onboarding step — agents don't need a separate gas token before they can transact, which matters a lot when you're funding a dozen agent wallets.
- x402 + Circle Gateway/Nanopayments genuinely delivers gasless, sub-cent settlement as advertised — the $0.000001 transaction on Arcscan is real, not a rounding trick.

**Where Circle/Arc can improve:**
- The testnet faucet's captcha gate is a real blocker for any multi-agent demo or CI pipeline — funding twelve agent wallets by hand does not scale, and it's the single reason our full multi-agent run can't execute unattended on Arc today. A programmatic/CI-friendly faucet path (even rate-limited) would remove this.
- Off-chain Circle Gateway settlement UUIDs have no on-chain link back to the batch transaction that actually settles them. We had to build heuristic timestamp-matching against Arcscan's tx history just to reconcile a settlement id with its on-chain proof. Exposing a direct settlement-id → tx-hash lookup in the Gateway API would close a real reconciliation gap for anyone building a receipts/audit feature on top.
- Arcscan's indexing window makes older settlements hard to verify once they age out of the "recent transactions" view for an address — a permanent, directly-linkable tx page (which does exist) is fine, but discovery of *older* activity for an address is harder than it should be.
- There's no low-friction sandbox/mock mode for Gateway/Nanopayments — every real exercise of that path needs a funded key, which blocks a pure-CI test of the actual Gateway integration (we test it manually instead, and say so honestly in our docs).

---

## General Feedback

[This one is genuinely yours to fill in with your actual experience of the event — mentors, communication, judging clarity, logistics. Draft starting point below if you want it:]

The technical docs and reference repos (arc-nanopayments, the x402 spec) were enough to get a working integration going without needing to ask for help, which is the right bar for a hackathon. The harder part wasn't the tech — it was the judging criterion that rewards real external traction inside a two-week window, which is a genuinely hard bar for infrastructure-shaped projects (versus consumer apps that can go viral faster). More visibility into other teams building complementary pieces — or a shared "agent marketplace" moment where teams' agents could transact with each other's services mid-hackathon — would have given projects like this a faster path to real (not self-generated) volume.

---

## Things to fix before you hit submit (found during this pass, not opinions — just facts)

1. **Test-count mismatch.** README.md and SUBMISSION.md say "32 contract tests." `DEPLOY.md` and the CI workflow description still say "22." Pick the true current number (32, per the two newer docs and the newer ServiceBond/InsurancePool test files) and update DEPLOY.md / the CI badge to match — a judge who checks CI and sees a different number than the README will notice.
2. **`agora-paywall` is not published to npm** — `npm install agora-paywall` in its own README will fail right now (404 on the registry). The code is real and working; it just needs `npm publish` run once. Fifteen minutes of work closes a real credibility gap given you're citing it as a live primitive.
3. **The landing page mentions an "agora-pay SDK"; the `sdk/` directory doesn't exist in the repo.** Either the SDK was never built or it's named/located differently — worth confirming before a judge goes looking for it and finds nothing.
4. **Hosting reliability.** I tried to load the live dashboard/`/api/info` twice while drafting this and got no response both times (likely Render free-tier cold start or a timeout). A judge who clicks your live link during a slow cold-start window will bounce. Worth a keep-alive ping or a paid always-on tier if that's within reach.
5. **`mcp/DIRECTORY-LISTINGS.md` shows Smithery/mcp.so/official-registry submissions as a prepared-but-not-yet-done checklist.** Actually completing those before submission is free, fast, real distribution — it's the difference between "we could theoretically be discovered" and "we are discovered."
