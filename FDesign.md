# Agora — Frontend Design Brief (FDesign.md)

> For the designer / frontend dev. This describes **what the frontend must convey, the data it has, the
> flows, and the states** — everything you need to design the experience. **It deliberately contains ZERO
> UI/visual direction** (no layout, colors, components, placement). Look, feel, structure, and interaction
> design are entirely your call. Full product spec lives in `tdd.md`; this is the frontend-relevant subset.

---

## 1. What you're designing

A **live, real-time web app that visualizes a self-running economy.** Agora is a society of autonomous AI
agents that hire, pay, rate, and compete with each other 24/7, settling real USDC on a blockchain. The
backend runs the economy continuously and streams its state; **the frontend is the window into that living
economy** — it should make a viewer feel they're watching a real economy run itself.

It is **not** a form, a wallet, or a checkout. There is no user account, no login, no data entry. The viewer
is an **observer** (with a couple of optional "trigger an event" controls for live demos).

---

## 2. Audience & goal

- **Primary audience:** hackathon judges + a live audience watching a <3-minute demo, plus anyone opening the
  hosted link later.
- **The one feeling to create:** *"this is a real economy, running by itself, with real money moving and real
  consequences."* Credibility + aliveness over decoration.
- **The headline truth to land:** the economy generates its own activity (agents are both buyers and sellers),
  trust is enforced automatically (cheaters get punished on-chain), and it never stops.

---

## 3. Core concepts (glossary — get the language right)

| Term | Meaning |
|---|---|
| **Agent** | An autonomous software actor with its own wallet, on-chain identity, role, and reputation. |
| **Role** | What an agent does: `consumer`, `broker`, `worker`, `validator`, `producer`. |
| **Job** | A unit of paid work: a consumer funds USDC into escrow, a worker delivers, a validator approves, it settles. |
| **Escrow** | USDC held by a contract during a job; released to the worker on success, refunded on failure. |
| **Reputation** | An on-chain score per agent (ERC-8004). Rises on good work, falls hard on fraud. Can be negative. |
| **Bond** | USDC collateral a worker/producer posts. **Slashed** (partially seized) if they cheat. |
| **Slash** | Automatic seizure of a fraudster's bond when their work fails validation. The "consequence." |
| **GDP** | Cumulative USDC actually settled to workers — the economy's total output. The hero metric. |
| **FlowMeter** | A metered "stream" payment: a producer sells a continuous feed, billed per unit, settled in batches. |
| **Treasury firewall** | A per-agent spend guard. Blocks any spend over budget/rate caps — stops a hijacked agent from draining funds. |
| **Validator** | An agent that independently **re-executes** a worker's task to verify it before money is released. |
| **Fraudster** | A worker that delivers tampered work. Used to demonstrate the slash/freeze-out mechanism. |
| **Tick** | One step of the economy's loop (~1.5s). Each tick, agents post/deliver/validate/pay. |
| **Arc / USDC** | The blockchain (Arc) and the dollar stablecoin (USDC) everything settles in. |

> Don't mislabel: it's "USDC" / "dollars," "reputation" (not "rating/karma"), "bond" (not "stake/deposit" —
> stake is fine as a synonym), "GDP" or "settled volume," "validator," "slash."

---

## 4. The actors (roles) and what's interesting about each

- **Consumers** — post needs (jobs) and pay. Have budgets. (Their treasury firewall can block spends.)
- **Broker** — routes each job to the best worker by reputation; skips known fraudsters. Earns a routing fee.
- **Workers** — do the actual tasks. Each has a **skill/specialty** (`sum`, `sort`, `max`). Earn per job.
  Build (or destroy) reputation. One worker is secretly a **fraudster** (`honest: false`).
- **Validator** — re-executes and approves/rejects work. Earns a validation fee.
- **Producer** — sells a continuous metered data feed (FlowMeter stream). Earns per unit streamed.

Each agent has live economics: **reputation score, bond, total earned, jobs done, jobs failed.**

---

## 5. What the frontend must communicate (information requirements)

These are the things a viewer needs to perceive. **How** you show them is your design:

1. **The economy is alive & running right now** — a continuous pulse; new things happen every ~1.5s.
2. **GDP / total USDC settled** — the growing headline number (and ideally its growth over time).
3. **Throughput** — jobs completed, jobs rejected, total jobs; the sense of volume/transactions.
4. **The reputation leaderboard** — every agent ranked by on-chain reputation, with the **fraudster visibly
   underwater (negative score)** and frozen out over time. This is the trust story made visible.
5. **Specialization** — which workers handle which task type (the economy organizing itself).
6. **The trust/safety events** — the two "money shots":
   - **Fraud → slash:** a worker delivered tampered work → rejected → bond slashed → reputation tanks.
   - **Hijack → firewall block:** an agent tried to drain a huge amount → blocked before any money moved.
7. **A live play-by-play feed** — the stream of individual economic events as they happen.
8. **Per-agent detail** — earnings, bond remaining, jobs done/failed, skill, role.
9. **Producer streams** — that metered feeds are flowing and settling.
10. **Context** — which network it's on (`localhost` for dev, `arcTestnet` for the real chain) and that it's autonomous.

---

## 6. Key states & moments (UX narrative — not visuals)

The experience evolves over time; design for these states:

- **Boot / empty:** the economy may show near-zero values for the first second or two before the first tick.
  Handle "nothing has happened yet" gracefully.
- **Steady state:** jobs flowing, GDP climbing, reputations diverging, feed scrolling.
- **Fraud moment (the climax):** a single, legible event where a fraudster is caught, rejected, and slashed —
  reputation visibly drops and they stop getting work afterward. This should be **noticeable**, not buried.
- **Hijack moment:** an attempted large malicious spend is **blocked** — nothing bad happens, and that's the
  point (safety demonstrated).
- **Maturity:** after a while, honest workers have clearly pulled ahead in reputation/earnings; the fraudster
  sits at the bottom; specialization is settled.

---

## 7. The demo flow the UI must support (≈3 minutes)

The frontend should make this narration land (the presenter speaks; the screen shows):

1. **Hook (~25s):** "This isn't a payments demo. It's an economy. It's been running by itself." → the screen
   should already show a live, populated, moving economy with a non-trivial GDP.
2. **The living economy (~45s):** GDP ticking up, transactions flowing, the reputation leaderboard, agents
   specializing. The aliveness reads at a glance.
3. **One job, end-to-end (~40s):** the ability to follow a single job through its lifecycle — consumer posts →
   broker routes → worker delivers → validator approves → settles → reputation updates. (The data for this is
   in the event stream; surfacing a single job's journey is a content need — how, is up to you.)
4. **Trust under fire (~35s):** trigger/observe a fraud → see it rejected and the bond slashed automatically;
   and a hijack attempt → see the firewall block it.
5. **Scale + close (~35s):** the cumulative settled-volume number and the overall picture; "the self-running
   economy for the machine age."

---

## 8. Interactions available

The viewer is mostly passive, but **two live-demo triggers exist** (so the presenter can fire the climactic
moments on cue). Whether/how you expose them is your call; the capability must be reachable:

- **Inject fraud** → causes a fraud job to occur (leads to a visible slash a moment later).
- **Simulate hijack** → causes a malicious large-spend attempt (leads to a visible firewall block).

These also fire automatically at scripted ticks even if not triggered manually. Beyond these, there's nothing
to input — no forms, no settings the user must fill.

---

## 9. The data contract (what the backend gives you)

The backend is a local HTTP server (default `http://localhost:4000`) that runs the economy and exposes:

### REST
- **`GET /api/info`** →
  ```json
  { "network": "localhost", "agents": 11, "tickMs": 1500 }
  ```
- **`GET /api/snapshot`** → the full current state (same shape as the SSE `snapshot` event below). Use this to
  populate initial state on load.
- **`POST /api/inject-fraud`** → `{ "ok": true }` (triggers a fraud event).
- **`POST /api/hijack`** → `{ "ok": false, "reason": "exceeds rate cap (...)" }` (triggers + reports a blocked hijack).

### Real-time: Server-Sent Events — **`GET /api/events`** (EventSource)
Three kinds of SSE messages arrive on this one stream:
- `event: hello` — a one-time handshake (ignore).
- `event: snapshot` — the **full economy state**, pushed every ~2 ticks. Shape:
  ```json
  {
    "tick": 20,
    "gdp": "34.96",                 // USDC settled, already formatted as dollars (string)
    "jobsCompleted": 38,
    "jobsRejected": 1,
    "jobsExpired": 0,
    "jobsTotal": 41,
    "slashed": "0.5",               // total USDC slashed from fraudsters (string)
    "slashEvents": 1,
    "firewallBlocks": 1,
    "internalVolume": "34.96",      // self-generated volume (agents trading each other) — equals gdp
    "externalVolume": "0.00",       // volume from non-agent wallets paying in via x402 (0 in the demo)
    "settlementMode": "local",      // "local" (ERC-20) or "arc" (Circle Gateway)
    "x402Sales": 6,                 // count of per-call x402 purchases settled
    "x402Volume": "0.06",           // USDC moved over the x402 boundary (string)
    "marketRates": { "sum": "0.85", "sort": "1.30", "max": "1.11" }, // DISCOVERED price per skill (EMA of winning quotes)
    "priceHistory": [               // recent quotes (last 40) — drives a price chart if you want one
      { "t": 12, "skill": "sum", "price": "0.88", "cleared": true }
    ],
    "pricedOut": 3,                 // jobs that didn't clear because the quote exceeded willingness-to-pay
    "pending": 2,                   // jobs currently in flight
    "agents": 11,
    "leaderboard": [                // sorted by score desc
      {
        "name": "Maxer-1",
        "role": "worker",           // consumer|broker|worker|validator|producer
        "skill": "max",             // sum|sort|max|feed|""
        "honest": true,             // false === the fraudster
        "score": 130,               // on-chain reputation (integer; can be negative)
        "bond": "50",               // USDC string, or null for roles that don't bond
        "earned": "8.74",           // USDC string
        "jobsDone": 13,
        "jobsFailed": 0
      }
      // ...one per agent
    ]
  }
  ```
- **default message** (no `event:` field) — a single **economy event** as it happens. Shape:
  ```json
  { "t": 6, "kind": "job_rejected", "msg": "⚠️ Grift delivered TAMPERED sum — REJECTED · client refunded · bond SLASHED", "data": { "worker": "Grift", "kind": "sum", "slashed": "0.5" } }
  ```

> Note: all USDC amounts arrive **pre-formatted as dollar strings** (e.g. `"34.96"`, `"0.5"`). Reputation
> scores are integers. `honest: false` is the only flag identifying the fraudster.

---

## 10. Event taxonomy (the `kind` field + meaning + sentiment)

Every live event has a `kind`. You decide how each reads, but here's their meaning and natural sentiment:

| `kind` | Meaning | Sentiment | `data` payload |
|---|---|---|---|
| `job_posted` | A consumer hired a worker (job created) | neutral | `{ jobId, worker, consumer, kind }` |
| `job_completed` | Work validated & paid | positive | `{ worker, kind }` |
| `job_rejected` | **Fraud caught** — tampered work rejected, bond slashed | alert / negative | `{ worker, kind, slashed }` |
| `stream_settled` | A producer's metered feed batch settled | positive (subtle) | `{ amount }` |
| `x402_sale` | A consumer bought a one-off data point over the x402 boundary | positive (subtle) | `{ amount }` |
| `priced_out` | A job didn't clear — the best quote exceeded the consumer's willingness-to-pay | neutral / info | `{ kind, quote }` |
| `firewall_block` | A spend was blocked (incl. **hijack** attempts) | alert / protective | `{ agent, reason }` |
| `tick` | Internal heartbeat (you can ignore these) | — | snapshot-ish |

The `msg` field is a human-readable, emoji-prefixed sentence you can show directly, or you can render your own
from the structured `data`. (Don't feel bound to the emojis.)

---

## 11. Units, formatting & terminology rules (content correctness)

- **Money:** USDC, shown as US dollars. Amounts come as strings already (e.g. `"34.96"` → "$34.96"). Underlying
  precision is 6 decimals; small stream amounts can be like `"0.08"`.
- **Reputation score:** integer; show sign (e.g. `+130`, `-25`); 0 is neutral/new.
- **Network label:** `localhost` (dev) or `arcTestnet` (the real Arc chain). Surface which one is live.
- **Counts:** jobs completed/rejected/total, slash events, firewall blocks — plain integers.
- **Don't** invent metrics the data doesn't provide. (E.g. "transactions per minute" isn't a field — but you
  can derive a rate from snapshots/ticks over time if you want a throughput indicator; tick cadence is `tickMs`.)

---

## 12. Real-time / non-functional considerations

- **Continuous updates:** a new full snapshot every ~2 ticks (~3s) and individual events arriving constantly.
  Design for smooth, non-jarring updates (no full-page flashes; the feed can be high-volume).
- **Reconnection:** SSE can drop; re-fetch `/api/snapshot` on (re)connect to resync.
- **Volume:** the event feed grows fast — assume you'll cap/scroll it (the current data keeps the latest ~hundreds).
- **Single-page, observe-only:** no routing/auth needed. One screen that stays open and live.
- **Framework-agnostic:** the backend just serves JSON + SSE + static files; use whatever frontend stack you
  prefer. (A built bundle can be dropped into the server's static dir, or it can call the API cross-origin in dev.)
- **Performance target:** it should stay smooth running unattended for many minutes (it's meant to "run all night").

---

## 13. Edge / empty / failure states to handle

- Economy just started: zeros / a near-empty leaderboard for a beat.
- No events yet / feed empty.
- An agent with no activity (0 earned, 0 jobs).
- The fraudster after being frozen out (negative score, 0 successful jobs, ≥1 failed).
- Backend not reachable / SSE disconnected (show it's offline + retry).
- Long-run: large cumulative numbers (GDP can grow well past the early values).

---

## 14. Explicitly your call (out of scope for this doc)

Everything visual and structural: layout, hierarchy, what's primary vs secondary, color, typography,
motion/animation, charts vs numbers, how the single-job journey is shown, how/whether the demo triggers are
surfaced, responsive behavior, theming, and overall art direction. **Design it however best tells the story of
a living economy.** You have the full data contract above — build the experience you think lands hardest.

---

### TL;DR for the designer
A live, observe-only dashboard for a **self-running AI-agent economy settling USDC on Arc.** Pull initial state
from `GET /api/snapshot`, then live-update from the `GET /api/events` SSE stream (full `snapshot` events +
individual economy events). Make a viewer feel a real economy is running itself — GDP climbing, agents
specializing, and **cheaters getting caught and slashed automatically** while a firewall blocks attacks. Two
optional triggers (`/api/inject-fraud`, `/api/hijack`) fire the dramatic moments for the live demo. All visual
and layout decisions are yours.
