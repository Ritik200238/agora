# Arc Microgrants — submission draft (Agora)

> Fill the `<…>` placeholders after the mainnet deploy (`npm run deploy:arc-mainnet` writes
> `deployments/arcMainnet.json`). Submissions close **Oct 14, 2026, 23:59 ET**.

**Project name:** Agora — pay-per-call USDC for AI agents, on Arc

**Live deployment (Arc mainnet):** https://agora-j52a.onrender.com/pay
- `/api/info` reports `"market":"arc","arcNetwork":"mainnet"`
- Contracts on Arc mainnet (chain 5042), viewable on https://explorer.arc.io:
  - ServiceBond: `<address>`
  - InsurancePool: `<address>`
  - JobBoard / IdentityRegistry / ReputationRegistry / LendingPool: `<addresses>`
- A real mainnet nanopayment through Circle Gateway: Circle transfer `<id>`; Gateway deposit tx `<explorer link>`

**Public repo:** https://github.com/Ritik200238/agora

**Builder profile:** https://github.com/Ritik200238

## What it does (short description)

Agora lets any AI agent or developer charge and pay **per API call, in fractions of a cent, in USDC on Arc**.
There are no subscriptions or API keys, and buyers are never charged for junk.

- **Agents pay per call.** Any agent with an Arc wallet pays any listed service through standard **x402** over
  **Circle Gateway**. It deposits once, and every call after that is a gasless signed authorization. A $0.000001
  call costs $0.000001. Agents can also plug in with one MCP line (`npx agora-pay-mcp`).
- **Sellers list any HTTP API** and are paid per successful call straight into their own Gateway balance, with
  no custody.
- **Charged only on delivery.** Agora verifies the payment, checks the buyer's balance, runs the service, and
  settles **only if the output is valid**. A failed or empty response is never settled.
- **Trust with real money behind it.** Sellers stake USDC in an on-chain `ServiceBond`. A service that keeps
  failing is slashed into an on-chain `InsurancePool` that refunds wronged buyers, with per-claim and daily
  payout caps.

## What it uses Arc for

- **USDC as gas + money in one asset.** Every price, stake, refund and fee is USDC, with no second token.
- **Circle Gateway on Arc** for real nanopayments. We measured a plain transfer on Arc at about $0.001 of gas,
  so sub-cent pricing only works with Gateway batching. Agora settles every marketplace call through it.
- **Arc contracts** for seller bonds, slashing, the buyer-protection pool, and an ERC-8004-style
  identity/reputation registry and job escrow.

## Technical credibility (what's actually verified)

- 50 Hardhat contract tests, plus security suites (SSRF guard, spoof-proof rate limiting) and 8 end-to-end suites,
  run in CI on every push.
- Live tests against real Arc and Circle's facilitator (`npm run test:arc`, `test:arc-gateway`):
  - a $0.000001 call settles
  - a failed delivery costs the buyer nothing (balance checked on Circle)
  - replays are refused
  - an unfunded payer is refused before the seller does any work
  - Circle's own `GatewayClient.pay()` buys a service from Agora end-to-end
- Contracts were hardened before mainnet. Credit is sized so defaulting never pays, workers must accept jobs,
  stuck validations unwind, stake can't be pulled ahead of a slash, and insurance payouts are capped.

## Why it's worth taking further

Agents need to buy from each other in amounts card networks can't handle, from parties they've never met.
Agora's wedge is **trust as collateral** (stake, slashing and insurance) on top of standard x402, so an
autonomous agent can spend without fear. Next steps:
- a seller dashboard (connect wallet → list → verify → earnings)
- publishing `agora-paywall` (per-request paywall for any Express route)
- staked-juror dispute resolution instead of operator review

## Honest notes

- The 12-agent demo economy on the homepage runs on a free sandbox chain because it sends dozens of txs a
  second. The **marketplace and its payments are on Arc mainnet.**
- Demo tabs on /pay are funded by us with a small daily budget and an on-chain reserve floor. Agents with
  their own wallet pay non-custodially via `/x402/arc/:service`.
