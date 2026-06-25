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
  blocks = 0; // how many spends this firewall denied

  constructor(
    public readonly budget: bigint,
    public readonly rateCap: bigint
  ) {}

  authorize(amount: bigint): { ok: boolean; reason?: string } {
    if (this.halted) {
      this.blocks++;
      return { ok: false, reason: `halted: ${this.haltReason}` };
    }
    if (amount > this.rateCap) {
      this.blocks++;
      return { ok: false, reason: `exceeds rate cap (${amount} > ${this.rateCap})` };
    }
    if (this.spent + amount > this.budget) {
      this.blocks++;
      return { ok: false, reason: "exceeds remaining budget" };
    }
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
