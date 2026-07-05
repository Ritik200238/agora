// Round-trips the Postgres backend against an in-memory Postgres (pg-mem): tables are created, services +
// the external counter are upserted, and a fresh load returns exactly what was written (idempotent upserts,
// jsonb round-trip). This proves the SQL logic; the live connection (SSL/pooler) is verified on the real
// Supabase at deploy time. `npm run test:pg`.
import { newDb } from "pg-mem";
import { PgBackend } from "../dashboard/pgstore";
import type { RegisteredService } from "../dashboard/store";

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
}

const svc = (over: Partial<RegisteredService> = {}): RegisteredService => ({
  id: "svc_test_1",
  name: "Test Svc",
  url: "http://127.0.0.1:1/x",
  priceUnits: "2000",
  desc: "d",
  payTo: "0x1111111111111111111111111111111111111111",
  exampleInput: { a: 1 },
  createdAt: "2026-07-05T00:00:00.000Z",
  calls: 0,
  failures: 0,
  revenueUnits: "0",
  slashedUnits: "0",
  ...over,
});

async function main() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const be = new PgBackend("postgres://mem", new Pool() as any);

  console.log("\n[pg backend — durable persistence round-trip (pg-mem)]");

  // empty load
  const empty = await be.load();
  check("loads empty state before any writes", Object.keys(empty.services).length === 0 && empty.external.sales === 0);

  // insert a service + external counter
  await be.saveService(svc({ calls: 3, revenueUnits: "6000" }));
  await be.saveExternal({ volumeUnits: "6000", sales: 3 });
  const loaded = await be.load();
  check("a saved service round-trips exactly (jsonb)", loaded.services["svc_test_1"]?.calls === 3 && loaded.services["svc_test_1"]?.revenueUnits === "6000" && loaded.services["svc_test_1"]?.payTo === "0x1111111111111111111111111111111111111111");
  check("the external counter round-trips", loaded.external.volumeUnits === "6000" && loaded.external.sales === 3);

  // upsert (same id) overwrites, doesn't duplicate
  await be.saveService(svc({ calls: 5, revenueUnits: "10000", slashedUnits: "200" }));
  const loaded2 = await be.load();
  check("re-saving the same id UPSERTS (no duplicate row)", Object.keys(loaded2.services).length === 1 && loaded2.services["svc_test_1"]?.calls === 5 && loaded2.services["svc_test_1"]?.slashedUnits === "200");

  // second distinct service coexists
  await be.saveService(svc({ id: "svc_test_2", name: "Two" }));
  const loaded3 = await be.load();
  check("distinct services coexist", Object.keys(loaded3.services).length === 2 && !!loaded3.services["svc_test_2"]);

  // external upsert overwrites the single row
  await be.saveExternal({ volumeUnits: "9999", sales: 7 });
  const loaded4 = await be.load();
  check("external upsert overwrites (single row)", loaded4.external.volumeUnits === "9999" && loaded4.external.sales === 7);

  console.log(fails === 0 ? "\n✅ PG BACKEND PASSED — durable upsert + load round-trips correctly." : `\n❌ ${fails} PG CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
