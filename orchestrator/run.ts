// Boots a local chain, builds the agent society, and runs the self-running economy.
//   npm run economy            → runs forever (Ctrl-C to stop)
//   TICKS=20 npm run economy   → runs 20 ticks then prints a final snapshot and exits
import { startChain } from "../test/harness";
import { buildSociety } from "../agents/society";
import { Economy } from "./economy";
import { setTimeout as sleep } from "node:timers/promises";

async function main() {
  const TICKS = process.env.TICKS ? parseInt(process.env.TICKS) : Infinity;
  const DELAY = process.env.TICK_MS ? parseInt(process.env.TICK_MS) : 700;
  const finite = Number.isFinite(TICKS);

  const chain = await startChain();
  process.on("SIGINT", () => {
    chain.stop();
    process.exit(0);
  });

  try {
    console.log("• building agent society…");
    const society = await buildSociety();
    const eco = new Economy(society);
    eco.emitter.on("event", (e) => {
      if (e.kind !== "tick") console.log(`  [t${e.t}] ${e.msg}`);
    });
    console.log(`• booting economy: ${society.agents.length} agents\n`);

    for (let i = 0; i < TICKS; i++) {
      await eco.tick();
      if (eco.tickN === 4) await eco.injectFraud(); // scripted fraud→slash beat
      if (eco.tickN === 8) eco.hijackAttempt("Nova-1"); // scripted hijack→firewall beat
      if (!finite) await sleep(DELAY);
      if (eco.tickN % 5 === 0) {
        const s = await eco.snapshot();
        console.log(
          `\n— tick ${s.tick} — GDP $${s.gdp} · ${s.jobsCompleted}✓ ${s.jobsRejected}✗ · slashed $${s.slashed} · firewall-blocks ${s.firewallBlocks}\n`
        );
      }
    }

    const final = await eco.snapshot();
    console.log("\n=== FINAL SNAPSHOT ===");
    console.log(JSON.stringify(final, null, 2));
  } finally {
    if (finite) chain.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
