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
  private ready: Promise<void>;

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
      });
    this.pool.on("error", (e) => console.error("pg pool error:", e.message));
    this.ready = this.ensureTables();
  }

  private async ensureTables(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS agora_services (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())`
    );
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS agora_meta (key text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now())`
    );
  }

  /** Load the full state into memory on boot. */
  async load(): Promise<StoreSnapshot> {
    await this.ready;
    const svc = await this.pool.query<{ id: string; data: RegisteredService }>(`SELECT id, data FROM agora_services`);
    const meta = await this.pool.query<{ data: { volumeUnits: string; sales: number } }>(
      `SELECT data FROM agora_meta WHERE key = 'external'`
    );
    const services: Record<string, RegisteredService> = {};
    for (const row of svc.rows) services[row.id] = row.data;
    return { services, external: meta.rows[0]?.data ?? { volumeUnits: "0", sales: 0 } };
  }

  /** Upsert a single service (write-behind on every registration / call / slash). */
  async saveService(svc: RegisteredService): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO agora_services (id, data, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = $2::jsonb, updated_at = now()`,
      [svc.id, JSON.stringify(svc)]
    );
  }

  /** Upsert the cumulative external-traction counter. */
  async saveExternal(ext: { volumeUnits: string; sales: number }): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO agora_meta (key, data, updated_at) VALUES ('external', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET data = $1::jsonb, updated_at = now()`,
      [JSON.stringify(ext)]
    );
  }

  async ping(): Promise<void> {
    await this.ready;
    await this.pool.query("SELECT 1");
  }
}
