// Canonical end-to-end test: boots a real chain, runs the full self-running economy, and asserts
// every key invariant against REAL on-chain state. No stubs, no fakes. `npm run test:e2e`.
import { startChain } from "./harness";
import { buildSociety } from "../agents/society";
import { Economy } from "../orchestrator/economy";
import * as A from "../shared/contracts";
import { usd, fmtUsd } from "../shared/usdc";

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
}

async function main() {
  const TICKS = Number(process.env.TICKS || 20);
  const chain = await startChain();
  try {
    console.log("• building society + booting economy…");
    const society = await buildSociety();
    const eco = new Economy(society);

    for (let i = 0; i < TICKS; i++) {
      await eco.tick();
      if (eco.tickN === 4) await eco.injectFraud();
      if (eco.tickN === 8) eco.hijackAttempt("Atlas");
    }

    const snap = await eco.snapshot();
    const econ = await A.economy();
    const fraud = society.agents.find((a) => !a.honest)!;
    const fraudScore = await A.scoreOf(fraud.agentId);
    const fraudBond = await A.bondOf(fraud.address);
    const producer = society.byRole("producer")[0];
    const topWorker = snap.leaderboard.filter((a) => a.role === "worker")[0];

    console.log("\nfinal:", {
      ticks: eco.tickN,
      gdp: "$" + snap.gdp,
      completed: snap.jobsCompleted,
      rejected: snap.jobsRejected,
      slashed: "$" + snap.slashed,
      firewallBlocks: snap.firewallBlocks,
    });

    console.log("\n[assertions — all against real on-chain state]");
    check("GDP > 0 (USDC actually settled on-chain)", econ.totalSettled > 0n, "$" + snap.gdp);
    check("jobs completed > 0", econ.jobsCompleted > 0n, String(econ.jobsCompleted));
    check("at least one fraud rejection+slash", eco.slashEvents >= 1 && econ.jobsRejected >= 1n, `slashEvents=${eco.slashEvents}`);
    check("fraudster reputation is negative on-chain", fraudScore < 0n, `score=${fraudScore}`);
    check("fraudster bond was slashed (< $50)", fraudBond < usd(50), `bond=$${fmtUsd(fraudBond)}`);
    check("fraudster frozen out (0 successful jobs)", fraud.jobsDone === 0, `done=${fraud.jobsDone} failed=${fraud.jobsFailed}`);
    check("treasury firewall blocked the hijack", eco.firewallBlocks >= 1, `blocks=${eco.firewallBlocks}`);
    check("producer earned from FlowMeter streams", producer.earned > 0n, "$" + fmtUsd(producer.earned));
    check("an honest worker has positive reputation", topWorker && topWorker.score > 0, `top=${topWorker?.name} score=${topWorker?.score}`);
    check(
      "on-chain job accounting is consistent",
      econ.jobsCompleted + econ.jobsRejected + econ.jobsExpired <= econ.jobsTotal,
      `${econ.jobsCompleted}+${econ.jobsRejected}+${econ.jobsExpired} <= ${econ.jobsTotal}`
    );
    check("leaderboard covers every agent", snap.leaderboard.length === society.agents.length, `${snap.leaderboard.length}/${society.agents.length}`);
  } finally {
    chain.stop();
  }

  console.log(
    fails === 0
      ? "\n✅ E2E PASSED — Agora boots and runs a self-sustaining agent economy end-to-end on a real chain."
      : `\n❌ ${fails} E2E CHECK(S) FAILED`
  );
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
