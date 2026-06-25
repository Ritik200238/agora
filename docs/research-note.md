# Agora — Observed Economic Dynamics (research note)

A short, honest write-up of what we actually observe when the Agora agent economy runs on-chain. All numbers
below are from real `npm run test:e2e` runs (a 20-tick local economy of 11 agents); reproduce with that command.

## Setup
- 11 agents: 2 consumers, 1 broker, 6 workers (skills: sum/sort/max; **one is a fraudster**), 1 validator, 1 producer.
- Each job: consumer funds USDC escrow → broker routes to a reputation-gated worker → worker delivers →
  validator **re-executes** and submits its answer hash → the contract derives pass/fail → settle or slash.
- Reputation is on-chain (ERC-8004); workers post a USDC bond that is **locked per job and slashed on fraud**.

## What we observe (emergent)
1. **Fraud freeze-out.** The fraudster ("Grift") delivers tampered work. The validator's independently
   re-executed answer hash does not match the deliverable, so the contract **rejects and slashes the locked
   bond** (observed: score → −25, bond 50 → 49.5). Because the broker reputation-gates routing and never
   routes to a negative-score worker, Grift receives **0 further jobs** — the economy routes around it without
   any central intervention. This freeze-out is genuinely emergent from the routing rule + on-chain reputation.
2. **Reputation divergence / "rich get hired".** Honest workers accrue reputation and earnings while the
   fraudster flatlines. Observed top worker reached **+130 reputation / 13 completed jobs** over 20 ticks,
   while the fraudster sat at −25 / 0. Load-balanced selection among non-negative workers keeps a spread of
   honest workers active rather than a single monopolist.
3. **Throughput → GDP.** With agents on both sides, the economy settles continuously: observed **$34.96 GDP
   across 38 completed jobs** in 20 ticks, plus metered producer streams and per-call x402 sales — all real
   on-chain USDC movement, zero humans.
4. **Safety holds under attack.** A simulated hijacked agent attempting a $100,000 spend is blocked by the
   treasury firewall before any funds move; repeated attempts trip an **anomaly cutoff** that hard-halts the agent.

## What is NOT emergent (honest limitations)
- **No price discovery.** Job prices and fees are fixed constants — there is no bidding, undercutting, or
  market-maker layer, so we do not (and do not claim to) observe price dynamics, cartels, or boom/bust.
- **Specialization is assigned, not discovered.** Each worker's skill is a fixed seed; we observe routing and
  earning dynamics within those skills, not the discovery of specialization from scratch.
- **The fraud + hijack beats are injected on cue** for the demo (a fixed tick), not organically encountered —
  though the fraudster would also be selected and slashed naturally by the load-balanced gate.
- **Single validator.** Validation is one disinterested re-executor with on-chain verdict derivation; there is
  no multi-validator quorum or validator-staking/slashing yet (future work).

## Takeaway
The defensible, reproducible result is **emergent trust + routing**: real on-chain reputation + enforced
collateral cause a cheater to be caught, slashed, and economically frozen out automatically, while honest
agents specialize and earn. The emergent-*pricing* story (Smallville-but-markets) is future work, not a current claim.
