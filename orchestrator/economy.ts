import { EventEmitter } from "node:events";
import { publicClient } from "../shared/chain";
import { dep } from "../shared/config";
import { usd, fmtUsd, usdcApprove, usdcBalance } from "../shared/usdc";
import * as A from "../shared/contracts";
import { ChainSettlement } from "../rail/settlement";
import { FlowMeter, MeteredStream } from "../rail/flowmeter";
import { x402Buy } from "../rail/x402";
import { SETTLEMENT_MODE } from "../shared/config";
import { makeTask, deliver, verify, solve, deliverableHash, TASK_KINDS, type Task, type TaskKind } from "../agents/tasks";
import { type Society } from "../agents/society";
import { Agent } from "../agents/agent";

interface JobCtx {
  jobId: bigint;
  task: Task;
  consumer: Agent;
  worker: Agent;
  validator: Agent;
  broker: Agent;
  amount: bigint;
  state: "Open" | "Submitted";
  answer?: string;
}

export interface AgoraEvent {
  t: number;
  kind:
    | "job_posted"
    | "job_completed"
    | "job_rejected"
    | "stream_settled"
    | "x402_sale"
    | "priced_out"
    | "credit"
    | "firewall_block"
    | "tick";
  msg: string;
  data?: any;
}

const STREAM_RATE = () => usd(0.002);
const STREAM_BUDGET = () => usd(5);
const BROKER_FEE_BPS = 500; // 5%
const VALIDATOR_FEE_BPS = 300; // 3%

// --- price discovery ---
const WTP = () => usd(1.6); // consumer willingness-to-pay ceiling → demand elasticity (some jobs priced out)
const LOAD_BPS = 1500n; // +15% to a worker's quote per in-flight job (busy workers charge more)
const REP_MAX_BPS = 5000n; // up to +50% quote premium for a top-reputation worker
const VALUE_REP_BPS = 6000n; // broker discounts a high-rep worker's quote when comparing bids on value
const clampRep = (score: bigint) => BigInt(Math.max(0, Math.min(Number(score), 200))) * 50n; // 0..10000

// --- credit market ---
const CREDIT_MIN_REP = 30n; // minimum reputation to access working-capital credit
const BORROW_PRINCIPAL = () => usd(4); // a reputable worker borrows this to expand its bond/capacity

// value-moving events counted toward transactions-per-minute
const VALUE_KINDS = new Set(["job_posted", "job_completed", "job_rejected", "stream_settled", "x402_sale", "credit"]);

/**
 * Economy — the self-running world loop.
 *
 * Each tick: consumers post needs; a broker routes each to the best reputation-gated worker;
 * workers deliver (honest = correct, fraud = tampered); the validator RE-EXECUTES and attests;
 * the chain settles (payout + reputation, or refund + slash); producers stream metered feeds.
 * Emergent result: honest workers specialize + earn, the fraudster is slashed then frozen out.
 */
export class Economy {
  readonly flow: FlowMeter;
  readonly emitter = new EventEmitter();
  readonly events: AgoraEvent[] = [];
  pending: JobCtx[] = [];
  jobKinds = new Map<string, string>(); // jobId → task kind (durable; the event buffer prunes over time)
  streams: { stream: MeteredStream; consumer: Agent; producer: Agent }[] = [];
  tickN = 0;
  salt = 1;
  totalSlashed = 0n;
  slashEvents = 0;
  firewallBlocks = 0;
  // Volume bookkeeping (honest split): internalVolume is self-generated (agents trading each other);
  // externalVolume is from non-agent wallets paying in over the x402 boundary (0 in the closed demo).
  x402Sales = 0;
  x402Volume = 0n;
  externalVolume = 0n;
  // price discovery
  marketRates = new Map<string, bigint>(); // EMA of winning price per skill
  priceHistory: { t: number; skill: string; price: string; cleared: boolean }[] = [];
  pricedOut = 0;
  // credit market
  creditLoans = 0;
  creditRepaid = 0;
  // the job featured in the "one job end-to-end" panel (newest in-flight, else the last settled one)
  lastSpotlight: {
    jobId: string;
    client: string;
    worker: string;
    kind: string;
    amount: string;
    statusCode: number;
    passed: boolean | null;
  } | null = null;
  // transaction-rate tracking (wall-clock timestamps of value-moving events)
  txTimestamps: number[] = [];

  constructor(public readonly society: Society) {
    this.flow = new FlowMeter(new ChainSettlement());
  }

  private log(kind: AgoraEvent["kind"], msg: string, data?: any) {
    const e: AgoraEvent = { t: this.tickN, kind, msg, data };
    this.events.push(e);
    if (this.events.length > 800) this.events.shift();
    if (VALUE_KINDS.has(kind)) this.txTimestamps.push(Date.now());
    this.emitter.emit("event", e);
  }

  private activeJobsFor(workerId: bigint): number {
    return this.pending.filter((p) => p.worker.agentId === workerId).length;
  }

  /** A worker's quote = baseRate scaled up by its load (busy → dearer) and reputation (proven → premium). */
  private quote(w: Agent, score: bigint, activeJobs: number): bigint {
    const base = w.baseRate > 0n ? w.baseRate : usd(1);
    const repPremiumBps = (REP_MAX_BPS * clampRep(score)) / 10000n;
    const multBps = 10000n + LOAD_BPS * BigInt(activeJobs) + repPremiumBps;
    return (base * multBps) / 10000n;
  }

  private recordPrice(skill: string, price: bigint, cleared: boolean) {
    if (cleared) {
      const prev = this.marketRates.get(skill) ?? price;
      this.marketRates.set(skill, (prev * 7n + price) / 8n); // EMA of winning prices
    }
    this.priceHistory.push({ t: this.tickN, skill, price: fmtUsd(price), cleared });
    if (this.priceHistory.length > 400) this.priceHistory.shift();
  }

  /** Broker: eligible workers bid a quote; pick the best VALUE (quote discounted by reputation).
   *  Competition (cheaper newcomers) + reliability (high-rep premium) both move prices → discovery. */
  private async selectWorker(skill: string): Promise<{ worker: Agent; price: bigint } | undefined> {
    const workers = this.society.byRole("worker").filter((w) => w.skill === skill);
    if (workers.length === 0) return undefined;
    const scored = await Promise.all(workers.map(async (w) => ({ w, score: await A.scoreOf(w.agentId) })));
    const eligible = scored.filter((s) => s.score >= 0n); // never route to a known-bad worker
    if (eligible.length === 0) return undefined;
    const bids = eligible.map((s) => {
      const price = this.quote(s.w, s.score, this.activeJobsFor(s.w.agentId));
      const valueScore = (price * 10000n) / (10000n + (VALUE_REP_BPS * clampRep(s.score)) / 10000n);
      return { worker: s.w, price, valueScore };
    });
    bids.sort((a, b) =>
      a.valueScore < b.valueScore ? -1 : a.valueScore > b.valueScore ? 1 : Number(a.worker.agentId - b.worker.agentId)
    );
    return { worker: bids[0].worker, price: bids[0].price };
  }

  /** A consumer posts a job at a DISCOVERED price. `force` pins the worker (used to inject a fraud job). */
  async postNeed(consumer: Agent, force?: Agent): Promise<void> {
    const broker = this.society.byRole("broker")[0];
    const validator = this.society.byRole("validator")[0];
    if (!broker || !validator) return;
    const kind: TaskKind = force ? (force.skill as TaskKind) : TASK_KINDS[this.salt % TASK_KINDS.length];
    const task = makeTask(this.salt++, kind);

    let worker: Agent;
    let amount: bigint;
    if (force) {
      worker = force;
      amount = this.quote(force, await A.scoreOf(force.agentId), this.activeJobsFor(force.agentId));
    } else {
      const sel = await this.selectWorker(kind);
      if (!sel) return;
      worker = sel.worker;
      amount = sel.price;
    }

    // demand elasticity: if the best market quote exceeds willingness-to-pay, the job does not clear
    if (!force && amount > WTP()) {
      this.pricedOut += 1;
      this.recordPrice(kind, amount, false);
      this.log("priced_out", `⏭️ ${consumer.name} priced out of ${kind} — best quote $${fmtUsd(amount)} > WTP $${fmtUsd(WTP())}`, {
        kind,
        quote: fmtUsd(amount),
      });
      return;
    }

    const auth = consumer.firewall.authorize(amount);
    if (!auth.ok) {
      this.firewallBlocks++;
      this.log("firewall_block", `🛡️ ${consumer.name}'s treasury firewall blocked a $${fmtUsd(amount)} spend — ${auth.reason}`, {
        agent: consumer.name,
        reason: auth.reason,
      });
      return;
    }

    await usdcApprove(consumer.wallet, dep().usdc, dep().jobBoard, amount);
    const deadline = (await publicClient.getBlock()).timestamp + 3600n;
    const jobId = await A.postJob(consumer.wallet, {
      workerId: worker.agentId,
      validatorId: validator.agentId,
      brokerId: broker.agentId,
      brokerFeeBps: BROKER_FEE_BPS,
      validatorFeeBps: VALIDATOR_FEE_BPS,
      amount,
      deadline,
      specHash: deliverableHash(`${task.kind}:${task.input.join(",")}`),
    });
    consumer.firewall.record(amount);
    consumer.spent += amount;
    consumer.jobsPosted++;
    this.recordPrice(task.kind, amount, true);
    this.pending.push({ jobId, task, consumer, worker, validator, broker, amount, state: "Open" });
    this.jobKinds.set(jobId.toString(), task.kind);
    // bound memory for a 24/7 run: keep only recent job kinds (the event buffer prunes old jobs anyway)
    if (this.jobKinds.size > 2000) this.jobKinds.delete(this.jobKinds.keys().next().value as string);
    this.log("job_posted", `${consumer.name} hired ${worker.name} for a ${task.kind} job · escrow funded (via ${broker.name})`, {
      jobId: jobId.toString(),
      worker: worker.name,
      consumer: consumer.name,
      kind: task.kind,
    });
  }

  /** Advance every pending job one step: Open→submit deliverable, Submitted→validate (settle). */
  async advanceJobs(): Promise<void> {
    for (const ctx of [...this.pending]) {
      if (ctx.state === "Open") {
        const answer = deliver(ctx.task, ctx.worker.honest);
        ctx.answer = answer;
        await A.submitJob(ctx.worker.wallet, ctx.jobId, deliverableHash(answer));
        ctx.state = "Submitted";
      } else {
        // The validator INDEPENDENTLY re-executes the task and submits its answer hash;
        // the contract derives the verdict by comparing it to the worker's deliverable.
        const validatorAnswerHash = deliverableHash(solve(ctx.task));
        await A.validateJob(ctx.validator.wallet, ctx.jobId, validatorAnswerHash);
        const passed = verify(ctx.task, ctx.answer!); // same verdict the chain just derived
        if (passed) {
          // mirror the on-chain fee split (JobBoard.validate): broker gets brokerFeeBps, validator
          // gets validatorFeeBps, the worker receives the remainder — every party's earnings are REAL.
          const brokerFee = (ctx.amount * BigInt(BROKER_FEE_BPS)) / 10000n;
          const validatorFee = (ctx.amount * BigInt(VALIDATOR_FEE_BPS)) / 10000n;
          const workerPay = ctx.amount - brokerFee - validatorFee;
          ctx.worker.jobsDone++;
          ctx.worker.earned += workerPay;
          ctx.broker.jobsDone++;
          ctx.broker.earned += brokerFee;
          ctx.validator.jobsDone++;
          ctx.validator.earned += validatorFee;
          this.lastSpotlight = { jobId: ctx.jobId.toString(), client: ctx.consumer.name, worker: ctx.worker.name, kind: ctx.task.kind, amount: fmtUsd(ctx.amount), statusCode: 3, passed: true };
          this.log("job_completed", `${ctx.worker.name} settled ${ctx.task.kind} job · $${fmtUsd(workerPay)} released from escrow`, {
            jobId: ctx.jobId.toString(),
            worker: ctx.worker.name,
            kind: ctx.task.kind,
          });
        } else {
          const slashed = ctx.amount / 2n;
          ctx.worker.jobsFailed++;
          ctx.validator.jobsDone++; // the validator correctly caught the fraud — a successful validation
          this.totalSlashed += slashed;
          this.slashEvents++;
          this.lastSpotlight = { jobId: ctx.jobId.toString(), client: ctx.consumer.name, worker: ctx.worker.name, kind: ctx.task.kind, amount: fmtUsd(ctx.amount), statusCode: 4, passed: false };
          this.log("job_rejected", `${ctx.worker.name} delivered TAMPERED ${ctx.task.kind} — rejected by ${ctx.validator.name} · bond slashed $${fmtUsd(slashed)}`, {
            jobId: ctx.jobId.toString(),
            worker: ctx.worker.name,
            kind: ctx.task.kind,
            slashed: fmtUsd(slashed),
          });
        }
        this.pending = this.pending.filter((p) => p !== ctx);
      }
    }
  }

  /** Producers stream metered feeds to consumers; batched settlement every 5 ticks. */
  async runStreams(): Promise<void> {
    const producer = this.society.byRole("producer")[0];
    if (!producer) return;
    if (this.streams.length === 0) {
      for (const consumer of this.society.byRole("consumer")) {
        const id = `feed:${producer.name}->${consumer.name}`;
        const stream = this.flow.openStream(id, consumer.wallet, producer.address, STREAM_RATE(), STREAM_BUDGET());
        this.streams.push({ stream, consumer, producer });
      }
    }
    for (const s of this.streams) {
      try {
        await s.stream.deliver(1n);
      } catch {
        /* fail-closed at budget */
      }
    }
    if (this.tickN % 5 === 0) {
      for (const s of this.streams) {
        const owed = s.stream.owed();
        if (owed <= 0n) continue;
        // stream spend goes through the consumer's treasury firewall too (single chokepoint)
        const auth = s.consumer.firewall.authorize(owed);
        if (!auth.ok) {
          this.firewallBlocks++;
          this.log("firewall_block", `🛡️ ${s.consumer.name} blocked a $${fmtUsd(owed)} stream settle — ${auth.reason}`, {
            agent: s.consumer.name,
            reason: auth.reason,
          });
          continue;
        }
        try {
          const r = await s.stream.settle();
          if (r) {
            s.consumer.firewall.record(r.amount);
            s.consumer.spent += r.amount;
            s.producer.earned += r.amount;
            s.producer.streamsRun++;
            this.log("stream_settled", `${s.producer.name} metered feed batch settled · $${fmtUsd(r.amount)}`, {
              amount: r.amount.toString(),
            });
          }
        } catch {
          /* nothing owed / halted */
        }
      }
    }
  }

  /** A consumer buys a one-off data point from the producer over the x402 boundary (mode-aware: local
   *  in-process x402 over real on-chain USDC; Circle Gateway on Arc). Makes the x402/Circle path LIVE. */
  async runX402Sales(): Promise<void> {
    if (this.tickN % 3 !== 0) return;
    const producer = this.society.byRole("producer")[0];
    const consumers = this.society.byRole("consumer");
    if (!producer || consumers.length === 0) return;

    // Local settles via real on-chain x402; the Arc (Circle Gateway) path needs the producer's facilitator
    // endpoint (PRODUCER_X402_URL). If it's missing on Arc, SKIP with a VISIBLE log — never fail silently.
    const arcEndpoint = process.env.PRODUCER_X402_URL;
    if (SETTLEMENT_MODE === "arc" && !arcEndpoint) {
      if (this.tickN === 3) {
        this.log("x402_sale", `🛰️ x402 Gateway sales skipped on Arc — set PRODUCER_X402_URL to a producer Gateway endpoint to enable (jobs + streams still settle on-chain)`, {});
      }
      return;
    }

    const consumer = consumers[this.tickN % consumers.length];
    const price = usd(0.01);
    const auth = consumer.firewall.authorize(price);
    if (!auth.ok) {
      this.firewallBlocks++;
      this.log("firewall_block", `🛡️ ${consumer.name} blocked an x402 buy — ${auth.reason}`, { agent: consumer.name });
      return;
    }
    try {
      await x402Buy(consumer.wallet, producer.address, price, () => ({ feed: producer.name, point: this.tickN }), arcEndpoint);
      consumer.firewall.record(price);
      consumer.spent += price;
      producer.earned += price;
      this.x402Sales += 1;
      this.x402Volume += price;
      this.log("x402_sale", `🛰️ ${consumer.name} bought a data point from ${producer.name} over x402 — $${fmtUsd(price)} [${SETTLEMENT_MODE}]`, {
        amount: price.toString(),
      });
    } catch (e) {
      // surface the failure rather than swallowing it
      this.log("x402_sale", `⚠️ x402 purchase failed (${consumer.name} → ${producer.name}): ${String((e as Error)?.message ?? e).slice(0, 100)}`, {});
    }
  }

  /** One economic tick. */
  async tick(): Promise<void> {
    this.tickN++;
    for (const consumer of this.society.byRole("consumer")) {
      await this.postNeed(consumer);
    }
    await this.advanceJobs();
    await this.runStreams();
    await this.runX402Sales();
    await this.runCredit();
  }

  /** Reputation-backed credit cycle: a top-reputation worker borrows working capital to expand its bond
   *  (capacity), and borrowers repay from earnings — the lender profits on the interest. */
  async runCredit(): Promise<void> {
    // BORROW: every 6 ticks, the highest-reputation debt-free worker takes a working-capital loan.
    if (this.tickN % 6 === 0) {
      const cands: { w: Agent; score: bigint }[] = [];
      for (const w of this.society.byRole("worker")) {
        const [score, debt] = await Promise.all([A.scoreOf(w.agentId), A.debtOf(w.address)]);
        if (score >= CREDIT_MIN_REP && debt === 0n) cands.push({ w, score });
      }
      if (cands.length) {
        cands.sort((a, b) => Number(b.score - a.score));
        const { w, score } = cands[0];
        const principal = BORROW_PRINCIPAL();
        const owed = (principal * 10500n) / 10000n; // + 5% fee
        const [limit, avail] = await Promise.all([A.creditLimit(w.agentId), A.availableBond(w.address)]);
        if (limit >= owed && avail >= (principal * 2000n) / 10000n) {
          try {
            await A.borrow(w.wallet, principal);
            await usdcApprove(w.wallet, dep().usdc, dep().bond, principal);
            await A.postBond(w.wallet, principal); // invest the credit into more collateral/capacity
            w.borrowed = await A.debtOf(w.address);
            this.creditLoans += 1;
            this.log("credit", `🏦 ${w.name} borrowed $${fmtUsd(principal)} against reputation (${score}) to expand capacity`, {
              agent: w.name,
            });
          } catch {
            /* limit/liquidity race */
          }
        }
      }
    }
    // REPAY: offset by 3 ticks, a borrower with enough earnings repays in full (+interest → lender yield).
    if (this.tickN % 6 === 3) {
      for (const w of this.society.byRole("worker")) {
        const debt = await A.debtOf(w.address);
        if (debt === 0n) continue;
        const bal = await usdcBalance(dep().usdc, w.address);
        if (bal >= debt) {
          try {
            await usdcApprove(w.wallet, dep().usdc, dep().lendingPool, debt);
            await A.repay(w.wallet, debt);
            w.borrowed = 0n;
            this.creditRepaid += 1;
            this.log("credit", `🏦 ${w.name} repaid its loan (+interest) — lender profits`, { agent: w.name });
          } catch {
            /* nothing */
          }
        }
        break; // at most one repay per tick
      }
    }
  }

  // ---- demo hooks ----

  /** Force a fraud job to the fraudster so the slash beat fires on cue. */
  async injectFraud(): Promise<void> {
    const grift = this.society.agents.find((a) => !a.honest);
    const consumer = this.society.byRole("consumer")[0];
    if (grift && consumer) await this.postNeed(consumer, grift);
  }

  /** Simulate a hijacked agent attempting to drain funds — the firewall must deny it. */
  hijackAttempt(consumerName: string): { ok: boolean; reason?: string } {
    const c = this.society.byName(consumerName) ?? this.society.byRole("consumer")[0];
    const huge = usd(100000);
    const res = c.firewall.authorize(huge);
    if (!res.ok) {
      this.firewallBlocks++;
      this.log("firewall_block", `🛡️ HIJACK BLOCKED — ${c.name} tried to spend $${fmtUsd(huge)} — ${res.reason}`, {
        agent: c.name,
        reason: res.reason,
      });
    }
    return res;
  }

  // ---- metrics ----

  async snapshot() {
    const econ = await A.economy();
    const credit = await A.creditMarket();
    const now = Date.now();
    this.txTimestamps = this.txTimestamps.filter((t) => t > now - 60000);
    const leaderboard = await Promise.all(
      this.society.agents.map(async (a) => ({
        name: a.name,
        role: a.role,
        skill: a.skill,
        honest: a.honest,
        score: Number(await A.scoreOf(a.agentId)),
        bond: a.role === "worker" || a.role === "producer" ? fmtUsd(await A.bondOf(a.address)) : null,
        earned: fmtUsd(a.earned),
        jobsDone: a.jobsDone,
        jobsFailed: a.jobsFailed,
      }))
    );
    leaderboard.sort((a, b) => b.score - a.score);

    // the "one job end-to-end" spotlight: the newest in-flight job if any, else the last settled one
    const top = this.pending[this.pending.length - 1];
    const spotlight = top
      ? {
          jobId: top.jobId.toString(),
          client: top.consumer.name,
          worker: top.worker.name,
          kind: top.task.kind,
          amount: fmtUsd(top.amount),
          statusCode: top.state === "Open" ? 1 : 2,
          passed: null as boolean | null,
        }
      : this.lastSpotlight;

    return {
      tick: this.tickN,
      txPerMin: this.txTimestamps.length, // value-moving on-chain transactions in the last 60s
      gdp: fmtUsd(econ.totalSettled),
      // Honest volume split: GDP/internal is self-generated (agents are both sides); external is from
      // non-agent wallets paying in over x402 (0 in the closed demo, but the path + field are real).
      internalVolume: fmtUsd(econ.totalSettled),
      externalVolume: fmtUsd(this.externalVolume),
      settlementMode: SETTLEMENT_MODE,
      jobsCompleted: Number(econ.jobsCompleted),
      jobsRejected: Number(econ.jobsRejected),
      jobsExpired: Number(econ.jobsExpired),
      jobsTotal: Number(econ.jobsTotal),
      slashed: fmtUsd(this.totalSlashed),
      slashEvents: this.slashEvents,
      firewallBlocks: this.firewallBlocks,
      x402Sales: this.x402Sales,
      x402Volume: fmtUsd(this.x402Volume),
      marketRates: Object.fromEntries([...this.marketRates].map(([k, v]) => [k, fmtUsd(v)])),
      priceHistory: this.priceHistory.slice(-40),
      pricedOut: this.pricedOut,
      credit: {
        deposits: fmtUsd(credit.totalDeposits),
        borrowed: fmtUsd(credit.totalBorrowed),
        interestEarned: fmtUsd(credit.interestEarned),
        defaults: Number(credit.defaults),
        liquidity: fmtUsd(credit.liquidity),
        loans: this.creditLoans,
        repaid: this.creditRepaid,
      },
      pending: this.pending.length,
      agents: this.society.agents.length,
      spotlight,
      leaderboard,
    };
  }

  /** Full on-chain profile of one agent (for the agent-detail view — a surface built in the same brand). */
  async agentDetail(name: string) {
    const a = this.society.byName(name);
    if (!a) return null;
    const collateralized = a.role === "worker" || a.role === "producer";
    const [score, bondTotal, avail, locked, debt, limit] = await Promise.all([
      A.scoreOf(a.agentId),
      collateralized ? A.bondOf(a.address) : Promise.resolve(0n),
      collateralized ? A.availableBond(a.address) : Promise.resolve(0n),
      collateralized ? A.lockedBond(a.address) : Promise.resolve(0n),
      A.debtOf(a.address),
      a.role === "worker" ? A.creditLimit(a.agentId) : Promise.resolve(0n),
    ]);
    return {
      name: a.name,
      role: a.role,
      skill: a.skill,
      honest: a.honest,
      agentId: a.agentId.toString(),
      address: a.address,
      score: Number(score),
      earned: fmtUsd(a.earned),
      jobsDone: a.jobsDone,
      jobsFailed: a.jobsFailed,
      bond: collateralized ? { total: fmtUsd(bondTotal), available: fmtUsd(avail), locked: fmtUsd(locked) } : null,
      debt: fmtUsd(debt),
      creditLimit: a.role === "worker" ? fmtUsd(limit) : null,
    };
  }

  /** End-to-end trace of a single job (demo beat 3): on-chain final state + its event timeline. */
  async jobTrace(jobId: bigint) {
    const nameOf = (id: bigint) => this.society.agents.find((a) => a.agentId === id)?.name ?? `#${id}`;
    let onchain: any = null;
    try {
      const j = await A.getJob(jobId);
      onchain = {
        status: j.status,
        client: nameOf(j.clientId),
        worker: nameOf(j.workerId),
        validator: nameOf(j.validatorId),
        broker: j.brokerId ? nameOf(j.brokerId) : null,
        amount: fmtUsd(j.amount),
      };
    } catch {
      /* unknown job */
    }
    const timeline = this.events.filter((e) => e.data && String(e.data.jobId) === String(jobId));
    const kind = this.jobKinds.get(String(jobId)) ?? timeline.find((e) => e.data?.kind)?.data.kind ?? null;
    return { jobId: jobId.toString(), kind, onchain, timeline };
  }
}
