# Agora Master Plan v2 — "Open the Gates"

> **Vision (one sentence):** Agora is the economy real AI agents plug into — one config line gives any
> agent money, judgment, and a marketplace on Arc.
>
> **North star:** Agentic + On Arc + real users + Innovative. Production-level, launch-ready, honest.
> **Rules:** CLAUDE.md governs everything — real end-to-end builds, actually run + tested, no fakes,
> honest labels (internal vs external volume), commit discipline with the attribution trailer.

The insight this plan executes: Agora built a full agent economy (identity, reputation, escrow, bonds,
credit, pay-per-use rail) — but only our own 12 bots can use it. **Every phase below opens a real door
into that same economy.** Nothing is bolted on to please judges; each piece is Agora's own primitives,
opened to real outsiders.

---

## Phase 1 — OPEN THE GATES (the launch)

### 1.1 Persistence (nothing forgets)
- SQLite via `better-sqlite3` (file DB, $0) storing: tabs, service registry, call ledger, seller
  earnings, reputation/trust events. If `DATABASE_URL` env is set, use Postgres (Neon/Supabase free
  tier) instead — same data layer interface.
- Server boot restores state; tabs/registrations survive restarts.
- Honest caveat to document: Render free tier disk is ephemeral across *redeploys* — SQLite persists
  across restarts but not rebuilds; Postgres env upgrade fixes that when the user creates a free db.

### 1.2 Multi-tenant gateway — "List your service" (the seller door)
- `POST /x402/services/register` `{ name, url, priceUsdc, desc, payTo, exampleInput }` → validated,
  rate-limited, persisted. The service is then live at `POST /x402/svc/:id/...` — Agora takes the x402
  payment, proxies the request to the seller's `url` (timeout + error handling), returns the result,
  and credits the seller's earnings ledger.
- Seller earnings: ledger per service + `POST /x402/services/:id/withdraw` (testnet USDC transfer to
  `payTo`), and a seller stats endpoint (calls, revenue, success rate, latency).
- Per-service call history feeds the trust oracle (Phase 2).
- Guardrails: input validation, per-IP + per-service rate limits, response size caps, no header
  forwarding that could leak internal data, health checks.

### 1.3 Agora MCP server (the agent door) — the flagship
- New package in-repo: `mcp/` → npm package **`agora-pay-mcp`** (built + `npm pack`ed; publishing
  needs the user's one-time `npm login`).
- MCP tools (stdio server, zero-config against the live gateway via `AGORA_URL`, default = the Render
  deploy):
  - `open_tab(capUsdc)` — get a budget-capped wallet (demo credit on testnet)
  - `get_balance()` / `get_bill()` — budget awareness
  - `list_services()` — discover what's for sale (with prices + trust scores)
  - `check_trust(target)` — the bonded trust oracle verdict BEFORE spending
  - `call_service(id, input)` — pay-per-call over x402, settled on Arc rails
- Tool descriptions written so the MODEL decides: cost-vs-value, trust-gating (refuse AVOID verdicts
  unless user overrides), budget allocation. The agentic behavior is the model's judgment over these
  tools — not hardcoded automation.
- README: one-line config snippets for Claude Code, Claude Desktop, Cursor. "Give your agent money in
  one line."
- Demo script (docs): "Research X with a $0.05 budget" — discover → trust-check → reject an AVOID
  seller → buy from bonded sellers → stop at budget — all real payments on Arc testnet.

### 1.4 Docs (the two quickstarts that matter)
- **Sellers:** "Earn USDC from your API in 5 minutes — no Stripe, no KYC, no subscription code."
- **Agent users:** "One config line gives your agent a wallet + judgment on Arc."
- Update README/SUBMISSION honestly (what's live vs what needs the user's npm login).

### 1.5 Verification (rule 5 — nothing ships unproven)
- New e2e: register a third-party service → agent pays → seller earns → withdraw; restart server →
  state survives; MCP server spawned and exercised tool-by-tool programmatically.
- All existing suites stay green (22 contracts + 17 e2e + 16 gateway).
- Live browser/CLI verification of the deployed flow after push.

**Phase 1 human steps (the only ones):** `npm login` to publish the package; optionally create a free
Neon/Supabase db and set `DATABASE_URL` on Render.

---

## Phase 2 — THE MOAT (trust + warranty; the empty lanes the organizers flagged)  ✅ SHIPPED 2026-07-05

### 2.1 Bonded services (Prior Art #8 — "reputation as collateral", nearly-empty lane)  ✅
- Built a dedicated **`ServiceBond`** contract (marketplace-layer collateral, distinct from the internal
  `ReputationBond`): a seller stakes USDC behind their `payTo` → **BONDED** badge + trust boost. The gateway
  reads the live on-chain bond in discovery/detail. Ownership renounced post-deploy; the gateway operator is
  the sole slasher. Contract tests (5) + e2e all green.

### 2.2 Money-back calls (escrowed pay-per-use)  ✅ (delivered as slash-on-failure)
- The gateway already enforced **pay-only-on-success** (a failed seller call never charges the buyer). Phase 2
  adds the teeth: a **bonded** service that keeps failing (≥50% failures over ≥4 calls) is **slashed on-chain**
  — 100× the call price, capped at the stake, sent to the treasury. The buyer keeps their money; the bad
  seller bleeds theirs. "Money-back + skin-in-the-game" — the differentiator nobody else offers.

### 2.3 Trust oracle v2  ✅
- Registered-service trust now folds in the **live bonded stake** on top of success rate / volume / age: an
  unproven-but-bonded service reads above neutral (stake substitutes for track record), and staking lifts the
  score (proven in the e2e: 80 → 85). Verdicts backed by collateral — a warranty, not an opinion.

> Note: full **Arc-testnet** slashing needs the live gateway operator key set as the ServiceBond manager
> (`GATEWAY_OPERATOR` at deploy). On the local chain and the live Render gateway (which runs a local chain),
> the operator = deployer = manager, so slashing is real and tested there today.

---

## Phase 3 — GROW THE CITY (distribution surfaces)

- **3.1 Public registry pages** — one indexable page per service (discovery + SEO, $0 distribution).
- **3.2 `npx agora-sandbox`** — our local chain+economy boot repackaged as one command: the dev
  environment for the whole x402/agent-payments category (we lived this pain; solve it for everyone).
- **3.3 Creator district** — Owncast per-second tips sidecar on FlowMeter (webhook join/leave →
  meter → batched settle on Arc). RFB 6 / Prior Art #6 (streaming = flagged code gap).
- **3.4 TestMint integration** — easy test-USDC top-ups for users via x402 (no faucet captchas).

---

## Metrics & kill criteria (written before shipping, so we can't rationalize later)
- **Phase 1 success:** ≥1 real third-party service listed + ≥1 real external MCP user making paid
  calls (externalVolume from wallets we don't control).
- **30-day kill metric:** <10 third-party services AND <1k npm downloads → the seller wedge is
  falsified; re-aim the spearhead at `agora-sandbox` (devtool wedge) without discarding the platform.
- Traction dashboard stays honest: `externalVolume`/`externalSales` move ONLY on non-us usage.

## Execution discipline (every phase)
1. Build fully end-to-end (no stubs presented as real).
2. Run + test everything (suites + live verification in browser/CLI).
3. Commit per milestone with the CLAUDE.md trailer; push (auto-deploys Render + Vercel).
4. Update docs honestly, including what did NOT work.
5. Surface blockers explicitly (rule 4) — never route around them silently.
