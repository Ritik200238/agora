# CLAUDE.md — Operating Rules for the Agora build

**Product spec / source of truth:** [`tdd.md`](./tdd.md) (Agora — The Self-Running Agent Economy on Arc).
Build the product according to that TDD. These rules govern *how* the work is done.

---

## 🎯 Hackathon north star — what the judges actually reward (added 2026-07-03)

The Lepton hackathon (Canteen × Circle × Arc), in three lines, wants:
1. **🤖 An AI agent that automatically sends & receives TINY USDC payments** — even **$0.000001**.
2. **💰 A product where people or AI pay only for what they use** (per article / API call / second / song) — **not** subscriptions.
3. **🚀 A real app on Arc that solves an ACTUAL problem and gets REAL USERS during the hackathon.**

> ELI5: instead of ₹500/month for Netflix, pay ₹1 for the one movie you watched — then replace humans with AI agents.

**Alignment bar for every decision:** does it push toward *tiny* payments, *pay-per-use*, and *real users on real Arc*?
The failure mode to avoid: a beautiful **closed simulation** with 0 real users, dollar-scale payments, on a local EVM.
Progress (2026-07-04): the core gap is largely closed — a **public pay-per-use gateway** (real `externalVolume`),
sub-cent pricing (**$0.000001**), and real **tiny-USDC pay-per-use settled on real Arc Testnet** (chain 5042002,
verifiable on Arcscan). Remaining: drive real external *users* + optionally run the full economy on Arc.

---

## NON-NEGOTIABLE RULES

1. **Commit attribution is mandatory.** Every single commit must end with the trailer:

   ```
   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   ```

   No skipping hooks. No `--no-verify`. No `--no-gpg-sign`. No rewriting or removing attribution.

2. **No time limit.** Never cut scope or rush to "finish." Build the whole thing properly.

3. **No effort limit.** Always full effort. No shallow answers, no skimming, no "good enough."

4. **Always do what you intend — no workarounds.** Build it the way it's meant to be built. If genuinely
   blocked (e.g., needs faucet funds, a paid key, an external service that isn't available), **surface the
   blocker explicitly and stop on that item** — do not silently route around it with a fake or lesser path.

5. **No half-baked building or testing.** Every feature is wired **end-to-end** and **actually run/tested** —
   no stubs, no mocks passed off as real, no fabricated results. If something fails, **report the failure
   honestly** with the real output. "Tested" means it actually executed and the assertions actually passed.

---

## Build conventions (how these rules apply to this stack)

- **Chains:** code runs on a **local EVM (Hardhat)** for full end-to-end testing AND is config-switchable to
  **Arc testnet** (chain ID `5042002`). Local runs are real (real EVM, real txs) — not stubs. Live Arc-testnet
  runs need a faucet-funded key (the one rule-4 blocker; surface it, don't fake on-chain results).
- **Settlement is an adapter, not a stub:** `LocalChainSettlement` (real USDC ERC-20 transfers on the local
  chain) and `ArcNanopaymentsSettlement` (Circle Gateway/Nanopayments on Arc testnet) — both real implementations.
- **Agents are rule-based by default** (per the TDD: most actors rule-based, only a few need a paid model) so the
  whole economy runs deterministically with **zero API keys and zero cost**, and is therefore fully testable.
- **Every contract has tests.** Every cross-component flow has an integration test that actually runs the loop.
- **Honesty over polish:** if a feature can't be truly tested in this environment, it is labeled clearly as
  "requires Arc testnet / external service," never presented as passing.

## Commit discipline
- This repo is git-initialized for the Agora build. Commit at meaningful milestones, each with the rule-1 trailer.
- Conventional, descriptive commit messages. Never bypass hooks or signing.
