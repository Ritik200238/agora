/**
 * SpendFirewall — the Treasury / CFO edge.
 *
 * Fail-closed budget governance for every spending agent: a per-agent total budget, a per-action
 * rate cap, and a hard halt. A buggy or HIJACKED agent physically cannot drain the economy — any
 * spend over the rate cap or remaining budget is denied before it ever reaches the chain.
 */
export class SpendFirewall {
  spent = 0n;
  halted = false;
  haltReason = "";
  blocks = 0; // all denied spends (any reason)
  anomalies = 0; // denials that look like an attack (over rate cap / acting while halted)

  constructor(
    public readonly budget: bigint,
    public readonly rateCap: bigint,
    /** Anomaly cutoff: after this many ANOMALOUS denials, the agent is hard-halted (dead-man behaviour). */
    public readonly anomalyThreshold: number = 3
  ) {}

  private deny(reason: string, anomalous: boolean): { ok: false; reason: string } {
    this.blocks++;
    if (anomalous) {
      this.anomalies++;
      // An agent that keeps trying to overspend (buggy or hijacked) is cut off entirely.
      if (!this.halted && this.anomalies >= this.anomalyThreshold) {
        this.halt(`anomaly cutoff: ${this.anomalies} anomalous spends`);
      }
    }
    return { ok: false, reason };
  }

  authorize(amount: bigint): { ok: boolean; reason?: string } {
    if (this.halted) return this.deny(`halted: ${this.haltReason}`, true);
    if (amount > this.rateCap) return this.deny(`exceeds rate cap (${amount} > ${this.rateCap})`, true);
    // Benign: simply out of budget — does NOT count toward the anomaly halt.
    if (this.spent + amount > this.budget) return this.deny("exceeds remaining budget", false);
    return { ok: true };
  }

  record(amount: bigint): void {
    this.spent += amount;
  }

  halt(reason: string): void {
    this.halted = true;
    this.haltReason = reason;
  }

  remaining(): bigint {
    return this.budget > this.spent ? this.budget - this.spent : 0n;
  }
}
