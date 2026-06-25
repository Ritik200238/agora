import { EventEmitter } from "node:events";
import { publicClient } from "../shared/chain";
import { dep } from "../shared/config";
import { usd, fmtUsd, usdcApprove } from "../shared/usdc";
import * as A from "../shared/contracts";
import { ChainSettlement } from "../rail/settlement";
import { FlowMeter, MeteredStream } from "../rail/flowmeter";
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
    | "firewall_block"
    | "tick";
  msg: string;
  data?: any;
}

const JOB_AMOUNT = () => usd(1);
const STREAM_RATE = () => usd(0.002);
const STREAM_BUDGET = () => usd(5);
const BROKER_FEE_BPS = 500; // 5%
const VALIDATOR_FEE_BPS = 300; // 3%

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
  streams: { stream: MeteredStream; consumer: Agent; producer: Agent }[] = [];
  tickN = 0;
  salt = 1;
  totalSlashed = 0n;
  slashEvents = 0;
  firewallBlocks = 0;

  constructor(public readonly society: Society) {
    this.flow = new FlowMeter(new ChainSettlement());
  }

  private log(kind: AgoraEvent["kind"], msg: string, data?: any) {
    const e: AgoraEvent = { t: this.tickN, kind, msg, data };
    this.events.push(e);
    if (this.events.length > 800) this.events.shift();
    this.emitter.emit("event", e);
  }

  /** Broker: pick the least-loaded worker whose reputation is non-negative (fraudsters excluded). */
  private async selectWorker(skill: string): Promise<Agent | undefined> {
    const workers = this.society.byRole("worker").filter((w) => w.skill === skill);
    if (workers.length === 0) return undefined;
    const scored = await Promise.all(workers.map(async (w) => ({ w, score: await A.scoreOf(w.agentId) })));
    const eligible = scored.filter((s) => s.score >= 0n);
    const pool = eligible.length ? eligible : scored;
    pool.sort((a, b) => a.w.jobsDone - b.w.jobsDone || Number(a.w.agentId - b.w.agentId));
    return pool[0].w;
  }

  /** A consumer posts a job (escrow). `force` pins the worker (used to inject a fraud job). */
  async postNeed(consumer: Agent, force?: Agent): Promise<void> {
    const broker = this.society.byRole("broker")[0];
    const validator = this.society.byRole("validator")[0];
    const kind: TaskKind = force ? (force.skill as TaskKind) : TASK_KINDS[this.salt % TASK_KINDS.length];
    const task = makeTask(this.salt++, kind);
    const worker = force ?? (await this.selectWorker(kind));
    if (!worker || !broker || !validator) return;

    const amount = JOB_AMOUNT();
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
    this.pending.push({ jobId, task, consumer, worker, validator, broker, amount, state: "Open" });
    this.log("job_posted", `${consumer.name} → ${worker.name} · ${task.kind} · $${fmtUsd(amount)} (via ${broker.name})`, {
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
          ctx.worker.jobsDone++;
          ctx.worker.earned += ctx.amount;
          this.log("job_completed", `✓ ${ctx.worker.name} delivered ${ctx.task.kind} — validated & paid $${fmtUsd(ctx.amount)}`, {
            worker: ctx.worker.name,
            kind: ctx.task.kind,
          });
        } else {
          ctx.worker.jobsFailed++;
          this.totalSlashed += ctx.amount / 2n;
          this.slashEvents++;
          this.log("job_rejected", `⚠️ ${ctx.worker.name} delivered TAMPERED ${ctx.task.kind} — REJECTED · client refunded · bond SLASHED`, {
            worker: ctx.worker.name,
            kind: ctx.task.kind,
            slashed: fmtUsd(ctx.amount / 2n),
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
        try {
          const r = await s.stream.settle();
          if (r) {
            s.producer.earned += r.amount;
            s.producer.streamsRun++;
            this.log("stream_settled", `📡 ${s.producer.name} → ${s.consumer.name} feed settled $${fmtUsd(r.amount)}`, {
              amount: r.amount.toString(),
            });
          }
        } catch {
          /* nothing owed / halted */
        }
      }
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
    return {
      tick: this.tickN,
      gdp: fmtUsd(econ.totalSettled),
      jobsCompleted: Number(econ.jobsCompleted),
      jobsRejected: Number(econ.jobsRejected),
      jobsExpired: Number(econ.jobsExpired),
      jobsTotal: Number(econ.jobsTotal),
      slashed: fmtUsd(this.totalSlashed),
      slashEvents: this.slashEvents,
      firewallBlocks: this.firewallBlocks,
      pending: this.pending.length,
      agents: this.society.agents.length,
      leaderboard,
    };
  }
}
