// Live economy dashboard: boots the chain + society + economy and serves a real-time UI.
//   npm run dashboard            → http://localhost:4000  (runs forever)
//   SELFTEST=1 npm run dashboard → boots, runs a few ticks, self-checks the API, exits
import express, { type Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startChain } from "../test/harness";
import { buildSociety } from "../agents/society";
import { Economy } from "../orchestrator/economy";
import { mountGateway } from "./gateway";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? +process.env.PORT : 4000;
const TICK_MS = process.env.TICK_MS ? +process.env.TICK_MS : 1500;
const SELFTEST = !!process.env.SELFTEST;

async function main() {
  const chain = await startChain();
  console.log("• building agent society…");
  const society = await buildSociety();
  const eco = new Economy(society);

  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, "public")));

  const sseClients: Response[] = [];
  app.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    res.write(`event: hello\ndata: {}\n\n`);
    sseClients.push(res);
    req.on("close", () => {
      const i = sseClients.indexOf(res);
      if (i >= 0) sseClients.splice(i, 1);
    });
  });
  eco.emitter.on("event", (e) => {
    const payload = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of sseClients) c.write(payload);
  });

  app.get("/api/info", (_req, res) =>
    res.json({ network: process.env.AGORA_NETWORK || "localhost", agents: society.agents.length, tickMs: TICK_MS })
  );
  app.get("/api/snapshot", async (_req, res) => res.json(await eco.snapshot()));
  app.get("/api/job/:id", async (req, res) => {
    try {
      res.json(await eco.jobTrace(BigInt(req.params.id)));
    } catch {
      res.status(400).json({ error: "bad job id" });
    }
  });
  app.get("/api/agent/:name", async (req, res) => {
    const d = await eco.agentDetail(req.params.name);
    if (!d) return res.status(404).json({ error: "unknown agent" });
    res.json(d);
  });
  app.post("/api/inject-fraud", async (_req, res) => {
    await eco.injectFraud();
    res.json({ ok: true });
  });
  app.post("/api/hijack", (_req, res) => res.json(eco.hijackAttempt("Nova-1")));

  // the PUBLIC pay-per-use gateway — real external agents/users pay tiny USDC per call (→ externalVolume)
  mountGateway(app, eco, society);

  await new Promise<void>((resolve) => app.listen(PORT, resolve));
  console.log(`\n🏛️  Agora dashboard live → http://localhost:${PORT}\n`);

  const pushSnapshot = async () => {
    const snap = await eco.snapshot();
    const payload = `event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`;
    for (const c of sseClients) c.write(payload);
    return snap;
  };

  const tickOnce = async () => {
    await eco.tick();
    if (eco.tickN === 4) await eco.injectFraud(); // scripted fraud→slash beat
    if (eco.tickN === 9) eco.hijackAttempt("Nova-1"); // scripted hijack→firewall beat
    if (eco.tickN % 2 === 0) await pushSnapshot();
  };

  if (SELFTEST) {
    for (let i = 0; i < 6; i++) await tickOnce();
    const r = await fetch(`http://localhost:${PORT}/api/snapshot`);
    const snap = await r.json();
    const html = await (await fetch(`http://localhost:${PORT}/`)).text();
    const trace = await (await fetch(`http://localhost:${PORT}/api/job/1`)).json();
    const ok =
      typeof snap.gdp === "string" &&
      typeof snap.txPerMin === "number" &&
      !!snap.credit &&
      !!snap.marketRates &&
      Array.isArray(snap.leaderboard) &&
      snap.leaderboard.length === society.agents.length &&
      trace.jobId === "1" &&
      !!trace.onchain &&
      html.includes("Agora");
    console.log("SELFTEST snapshot:", { gdp: snap.gdp, txPerMin: snap.txPerMin, credit: snap.credit, trace: trace.onchain?.status });
    console.log(ok ? "✅ DASHBOARD SELFTEST PASSED" : "❌ DASHBOARD SELFTEST FAILED");
    chain.stop();
    process.exit(ok ? 0 : 1);
  } else {
    const loop = async () => {
      try {
        await tickOnce();
      } catch (e) {
        console.error("tick error:", e);
      }
      setTimeout(loop, TICK_MS);
    };
    loop();
    process.on("SIGINT", () => {
      chain.stop();
      process.exit(0);
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
