// Runtime smoke test: proves the TS runtime + payment rail work against a REAL chain.
// Registers agents, runs a pass-job, a fraud-job (slash), and a FlowMeter stream — all on-chain.
import { startChain } from "./harness";
import { HARDHAT_KEYS } from "../shared/local-accounts";
import { walletFor, publicClient } from "../shared/chain";
import { dep } from "../shared/config";
import { usd, fmtUsd, usdcMint, usdcApprove, usdcBalance } from "../shared/usdc";
import * as A from "../shared/contracts";
import { ChainSettlement } from "../rail/settlement";
import { FlowMeter } from "../rail/flowmeter";
import { x402Service, x402Pay } from "../rail/x402";

const H32 = (b: string) => ("0x" + b.repeat(32)) as `0x${string}`;

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures++;
}

async function main() {
  const chain = await startChain();
  try {
    const D = dep();
    const deployer = walletFor(HARDHAT_KEYS[0]); // owner / faucet
    const client = walletFor(HARDHAT_KEYS[1]);
    const worker = walletFor(HARDHAT_KEYS[2]);
    const validator = walletFor(HARDHAT_KEYS[3]);
    const fraud = walletFor(HARDHAT_KEYS[4]);
    const producer = walletFor(HARDHAT_KEYS[5]);
    const consumer = walletFor(HARDHAT_KEYS[6]);

    console.log("\n[1] register agents");
    await A.registerAgent(client, "consumer", "ipfs://client");
    await A.registerAgent(worker, "worker", "ipfs://worker");
    await A.registerAgent(validator, "validator", "ipfs://validator");
    await A.registerAgent(fraud, "worker", "ipfs://fraud");
    await A.registerAgent(producer, "producer", "ipfs://producer");
    await A.registerAgent(consumer, "consumer", "ipfs://consumer");
    const workerId = await A.agentOf(worker.account.address);
    const validatorId = await A.agentOf(validator.account.address);
    const fraudId = await A.agentOf(fraud.account.address);
    check("agents registered with passports", workerId > 0n && fraudId > 0n && validatorId > 0n);

    console.log("[2] fund + bond");
    await usdcMint(deployer, D.usdc, client.account.address, usd(1000));
    await usdcMint(deployer, D.usdc, worker.account.address, usd(100));
    await usdcMint(deployer, D.usdc, fraud.account.address, usd(100));
    await usdcMint(deployer, D.usdc, consumer.account.address, usd(100));
    await usdcApprove(worker, D.usdc, D.bond, usd(50));
    await A.postBond(worker, usd(50));
    await usdcApprove(fraud, D.usdc, D.bond, usd(20));
    await A.postBond(fraud, usd(20));
    check("bonds posted", (await A.bondOf(fraud.account.address)) === usd(20));

    const deadline = (await publicClient.getBlock()).timestamp + 3600n;

    console.log("[3] honest job → pass → payout + reputation");
    await usdcApprove(client, D.usdc, D.jobBoard, usd(10));
    const job1 = await A.postJob(client, {
      workerId, validatorId, brokerId: 0n, brokerFeeBps: 0, validatorFeeBps: 300,
      amount: usd(10), deadline, specHash: H32("11"),
    });
    const w0 = await usdcBalance(D.usdc, worker.account.address);
    await A.submitJob(worker, job1, H32("22"));
    await A.validateJob(validator, job1, H32("22")); // validator's recomputed hash matches → pass
    check("worker paid on pass", (await usdcBalance(D.usdc, worker.account.address)) > w0);
    check("worker reputation +10", (await A.scoreOf(workerId)) === 10n);
    check("job1 status Completed", (await A.getJob(job1)).status === "Completed");

    console.log("[4] fraud job → fail → bond slashed + reputation tanked");
    await usdcApprove(client, D.usdc, D.jobBoard, usd(8));
    const job2 = await A.postJob(client, {
      workerId: fraudId, validatorId, brokerId: 0n, brokerFeeBps: 0, validatorFeeBps: 0,
      amount: usd(8), deadline, specHash: H32("33"),
    });
    const fb0 = await A.bondOf(fraud.account.address);
    await A.submitJob(fraud, job2, H32("44"));
    await A.validateJob(validator, job2, H32("99")); // recomputed hash differs → fail → slash
    check("fraud bond slashed", (await A.bondOf(fraud.account.address)) < fb0);
    check("fraud reputation negative", (await A.scoreOf(fraudId)) < 0n);
    check("job2 status Rejected", (await A.getJob(job2)).status === "Rejected");

    console.log("[5] FlowMeter stream → metered, proof-of-flow, batched settle");
    const meter = new FlowMeter(new ChainSettlement());
    const stream = meter.openStream("feed-1", consumer, producer.account.address, usd(0.001), usd(1));
    for (let i = 0; i < 10; i++) await stream.deliver(1n); // 10 units * 0.001 = 0.01 USDC
    const p0 = await usdcBalance(D.usdc, producer.account.address);
    const settled = await stream.settle();
    check("flowmeter settled producer", settled !== null && (await usdcBalance(D.usdc, producer.account.address)) - p0 === usd(0.01));
    let halted = false;
    try {
      for (let i = 0; i < 2000; i++) await stream.deliver(1n);
    } catch {
      halted = true;
    }
    check("flowmeter fail-closed at budget", halted);

    console.log("[6] x402 service boundary → pay-to-use, on-chain verified");
    const feed = x402Service({
      payTo: producer.account.address,
      price: usd(0.01),
      produce: () => ({ metric: 42, ts: 1 }),
    });
    const probe = await feed();
    check("x402 returns 402 + terms before payment", probe.status === 402 && !!probe.body.terms);
    const x0 = await usdcBalance(D.usdc, producer.account.address);
    const data = await x402Pay(consumer, feed);
    check("x402 served after payment", data?.metric === 42);
    check("x402 producer received fee", (await usdcBalance(D.usdc, producer.account.address)) - x0 === usd(0.01));

    const econ = await A.economy();
    console.log("\neconomy:", {
      GDP_usdc: fmtUsd(econ.totalSettled),
      completed: econ.jobsCompleted.toString(),
      rejected: econ.jobsRejected.toString(),
      total: econ.jobsTotal.toString(),
    });
    check("economy GDP > 0", econ.totalSettled > 0n);
  } finally {
    chain.stop();
  }

  console.log(failures === 0 ? "\n✅ ALL RUNTIME CHECKS PASSED" : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
