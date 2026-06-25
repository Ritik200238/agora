import { recoverMessageAddress } from "viem";
import { type Wallet } from "../shared/chain";
import { type Settlement } from "./settlement";

/**
 * FlowMeter — the payment heart of Agora.
 *
 * A per-unit / per-second metered stream secured by consumer-signed PROOF-OF-FLOW receipts:
 * the producer delivers work, the consumer signs a receipt acknowledging cumulative delivered
 * units, and the meter advances ONLY on signed receipts. Spend is hard-capped by `budget`
 * (fail-closed: a runaway producer cannot bill past the authorized budget). Owed value is settled
 * in BATCHES through the pluggable Settlement backend (mirrors Circle Gateway's batched model).
 */

export interface FlowReceipt {
  streamId: string;
  cumulativeUnits: bigint;
  cumulativeAmount: bigint; // USDC (6dp)
  signer: `0x${string}`;
  signature: `0x${string}`;
}

function receiptMessage(id: string, units: bigint, amount: bigint): string {
  return `agora-flowmeter:v1:${id}:units=${units}:amount=${amount}`;
}

export class MeteredStream {
  cumulativeUnits = 0n;
  cumulativeAmount = 0n; // signed/authorized by consumer
  settledAmount = 0n;
  receipts: FlowReceipt[] = [];
  halted = false;

  constructor(
    public readonly id: string,
    private readonly consumer: Wallet,
    public readonly producer: `0x${string}`,
    public readonly ratePerUnit: bigint, // USDC (6dp) per unit
    public readonly budget: bigint, // rate-authorization ceiling
    private readonly settlement: Settlement
  ) {}

  /** Producer delivers `units`; consumer co-signs a proof-of-flow receipt. Fail-closed at budget. */
  async deliver(units: bigint): Promise<FlowReceipt> {
    if (this.halted) throw new Error(`stream ${this.id} is halted`);
    const newUnits = this.cumulativeUnits + units;
    const newAmount = newUnits * this.ratePerUnit;
    if (newAmount > this.budget) {
      this.halted = true;
      throw new Error(`FLOWMETER: budget exceeded on ${this.id} — stream halted (fail-closed)`);
    }
    const signature = (await this.consumer.signMessage({
      account: this.consumer.account,
      message: receiptMessage(this.id, newUnits, newAmount),
    })) as `0x${string}`;

    this.cumulativeUnits = newUnits;
    this.cumulativeAmount = newAmount;
    const receipt: FlowReceipt = {
      streamId: this.id,
      cumulativeUnits: newUnits,
      cumulativeAmount: newAmount,
      signer: this.consumer.account.address,
      signature,
    };
    this.receipts.push(receipt);
    return receipt;
  }

  owed(): bigint {
    return this.cumulativeAmount - this.settledAmount;
  }

  /** Batched settlement: verify the latest proof-of-flow receipt, then settle the owed delta. */
  async settle(): Promise<{ amount: bigint; ref: string } | null> {
    const owed = this.owed();
    if (owed <= 0n) return null;
    const last = this.receipts[this.receipts.length - 1];
    const recovered = await recoverMessageAddress({
      message: receiptMessage(this.id, last.cumulativeUnits, last.cumulativeAmount),
      signature: last.signature,
    });
    if (recovered.toLowerCase() !== last.signer.toLowerCase()) {
      throw new Error(`FLOWMETER: invalid proof-of-flow receipt on ${this.id}`);
    }
    const { ref } = await this.settlement.pay(this.consumer, this.producer, owed, `stream:${this.id}`);
    this.settledAmount = this.cumulativeAmount;
    return { amount: owed, ref };
  }
}

export class FlowMeter {
  readonly streams = new Map<string, MeteredStream>();
  constructor(private readonly settlement: Settlement) {}

  openStream(
    id: string,
    consumer: Wallet,
    producer: `0x${string}`,
    ratePerUnit: bigint,
    budget: bigint
  ): MeteredStream {
    const s = new MeteredStream(id, consumer, producer, ratePerUnit, budget, this.settlement);
    this.streams.set(id, s);
    return s;
  }
}
