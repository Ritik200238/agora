// Postgres backend for the store — durable persistence that survives Render redeploys (the free tier's
// filesystem is ephemeral). Activated only when DATABASE_URL is set (e.g. a free Supabase Postgres); otherwise
// the store falls back to the atomic JSON file. Kept behind the same interface: in-memory is the read model,
// this is the durable write-behind + load-on-boot. Two tiny jsonb tables, no ORM.
import { Pool } from "pg";
import type { RegisteredService } from "./store";

export interface StoreSnapshot {
  services: Record<string, RegisteredService>;
  external: { volumeUnits: string; sales: number };
}

export class PgBackend {
  private pool: Pool;
  // Resolves true if the connection + tables are good, false if not. NEVER rejects — a bad database must
  // degrade the app to in-memory, never crash it (a floating rejection here would take the whole site down).
  private ready: Promise<boolean>;

  /** `poolOverride` lets tests inject an in-memory pg pool (pg-mem); production passes only the URL. */
  constructor(connectionString: string, poolOverride?: Pool) {
    const isLocal = /@(localhost|127\.0\.0\.1)/.test(connectionString);
    this.pool =
      poolOverride ??
      new Pool({
        connectionString,
        ssl: isLocal ? undefined : { rejectUnauthorized: false }, // Supabase/managed PG require TLS
        max: 4,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
      });
    this.pool.on("error", (e) => console.error("pg pool error:", e.message)); // swallow idle-client errors
    this.ready = this.ensureTables()
      .then(() => true)
      .catch((e) => {
        console.error("Postgres unavailable — running in-memory this boot:", (e as Error).message);
        return false;
      });
  }

  private async ensureTables(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS agora_services (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())`
    );
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS agora_meta (key text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())`
    );
  }

  /** Load the full state into memory on boot. Throws if the DB is unavailable (caller falls back to memory). */
  async load(): Promise<StoreSnapshot> {
    if (!(await this.ready)) throw new Error("postgres unavailable");
    const svc = await this.pool.query<{ id: string; data: RegisteredService }>(`SELECT id, data FROM agora_services`);
    const meta = await this.pool.query<{ data: { volumeUnits: string; sales: number } }>(
      `SELECT data FROM agora_meta WHERE key = 'external'`
    );
    const services: Record<string, RegisteredService> = {};
    for (const row of svc.rows) services[row.id] = row.data;
    return { services, external: meta.rows[0]?.data ?? { volumeUnits: "0", sales: 0 } };
  }

  /** Upsert a single service (write-behind on every registration / call / slash). No-op if DB is down. */
  async saveService(svc: RegisteredService): Promise<void> {
    if (!(await this.ready)) return;
    await this.pool.query(
      `INSERT INTO agora_services (id, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = $2::jsonb, updated_at = now()`,
      [svc.id, JSON.stringify(svc)]
    );
  }

  /** Upsert the cumulative external-traction counter. No-op if DB is down. */
  async saveExternal(ext: { volumeUnits: string; sales: number }): Promise<void> {
    if (!(await this.ready)) return;
    await this.pool.query(
      `INSERT INTO agora_meta (key, data, updated_at) VALUES ('external', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET data = $1::jsonb, updated_at = now()`,
      [JSON.stringify(ext)]
    );
  }

  async ping(): Promise<void> {
    if (!(await this.ready)) throw new Error("postgres unavailable");
    await this.pool.query("SELECT 1");
  }
}
