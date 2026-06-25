import { recoverMessageAddress } from "viem";
import { activeChain, type Wallet } from "../shared/chain";
import { type Settlement } from "./settlement";

/**
 * FlowMeter — the payment heart of Agora.
 *
 * A per-unit / per-second metered stream secured by consumer-signed PROOF-OF-FLOW receipts. Each receipt
 * is bound to the stream id, the PRODUCER (recipient), the RATE, and the CHAIN — so a receipt cannot be
 * replayed for a different producer/rate/stream — and the owed amount is RE-DERIVED as units*rate (never a
 * caller-asserted figure). Spend is hard-capped by `budget` (fail-closed). At settle, the signature is
 * recovered and checked against the stream's AUTHORIZED consumer (not a self-asserted field). Owed value is
 * settled in batches through the pluggable Settlement backend (mirrors Circle Gateway's batched model).
 *
 * Caveat (honest): this proves the consumer co-signed receipt of N units at a bound rate; it does not by
 * itself prove the producer delivered *correct content* (that is a separate validation concern). The budget
 * cap + per-unit co-signing bound the blast radius.
 */

export interface FlowReceipt {
  streamId: string;
  producer: `0x${string}`;
  ratePerUnit: bigint;
  chainId: number;
  cumulativeUnits: bigint;
  cumulativeAmount: bigint;
  signer: `0x${string}`;
  signature: `0x${string}`;
}

function receiptMessage(r: {
  streamId: string;
  producer: `0x${string}`;
  ratePerUnit: bigint;
  chainId: number;
  units: bigint;
  amount: bigint;
}): string {
  return [
    "agora-flowmeter:v2",
    `stream=${r.streamId}`,
    `producer=${r.producer.toLowerCase()}`,
    `rate=${r.ratePerUnit}`,
    `chain=${r.chainId}`,
    `units=${r.units}`,
    `amount=${r.amount}`,
  ].join("|");
}

export class MeteredStream {
  cumulativeUnits = 0n;
  cumulativeAmount = 0n; // always re-derived as cumulativeUnits * ratePerUnit
  settledAmount = 0n;
  receipts: FlowReceipt[] = [];
  halted = false;
  readonly chainId = activeChain.id;

  constructor(
    public readonly id: string,
    private readonly consumer: Wallet,
    public readonly producer: `0x${string}`,
    public readonly ratePerUnit: bigint,
    public readonly budget: bigint,
    private readonly settlement: Settlement
  ) {}

  /** Producer delivers `units`; consumer co-signs a receipt bound to (stream, producer, rate, chain). */
  async deliver(units: bigint): Promise<FlowReceipt> {
    if (this.halted) throw new Error(`stream ${this.id} is halted`);
    const newUnits = this.cumulativeUnits + units;
    const newAmount = newUnits * this.ratePerUnit; // RE-DERIVED, never asserted
    if (newAmount > this.budget) {
      this.halted = true;
      throw new Error(`FLOWMETER: budget exceeded on ${this.id} — stream halted (fail-closed)`);
    }
    const message = receiptMessage({
      streamId: this.id,
      producer: this.producer,
      ratePerUnit: this.ratePerUnit,
      chainId: this.chainId,
      units: newUnits,
      amount: newAmount,
    });
    const signature = (await this.consumer.signMessage({ account: this.consumer.account, message })) as `0x${string}`;

    this.cumulativeUnits = newUnits;
    this.cumulativeAmount = newAmount;
    const receipt: FlowReceipt = {
      streamId: this.id,
      producer: this.producer,
      ratePerUnit: this.ratePerUnit,
      chainId: this.chainId,
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

  /** Batched settlement: re-derive the receipt from the stream's authorized fields, verify the signature
   *  was produced by THIS stream's consumer, then settle the owed delta to the bound producer. */
  async settle(): Promise<{ amount: bigint; ref: string } | null> {
    if (this.receipts.length === 0) return null;
    const last = this.receipts[this.receipts.length - 1];
    // Anchor settlement to the VERIFIED receipt's units (re-derived), not a mutable cumulative field.
    const verifiedAmount = last.cumulativeUnits * this.ratePerUnit;
    const owed = verifiedAmount - this.settledAmount;
    if (owed <= 0n) return null;

    const expected = receiptMessage({
      streamId: this.id,
      producer: this.producer,
      ratePerUnit: this.ratePerUnit,
      chainId: this.chainId,
      units: last.cumulativeUnits,
      amount: verifiedAmount,
    });
    const recovered = await recoverMessageAddress({ message: expected, signature: last.signature });
    if (recovered.toLowerCase() !== this.consumer.account.address.toLowerCase()) {
      throw new Error(`FLOWMETER: receipt not signed by the authorized consumer on ${this.id}`);
    }
    const { ref } = await this.settlement.pay(this.consumer, this.producer, owed, `stream:${this.id}`);
    this.settledAmount = verifiedAmount;
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
