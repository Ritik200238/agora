// Persistent store for the multi-tenant gateway — the service registry + cumulative real external volume.
// Two interchangeable backends behind ONE synchronous read interface (in-memory is the read model):
//   • DATABASE_URL set  → Postgres (e.g. a free Supabase) — durable across Render redeploys. Load-on-boot,
//                          write-behind on every mutation. Call `await store.init()` once before serving.
//   • DATABASE_URL unset → an atomic JSON file (zero deps; fine for local/dev). Loaded synchronously.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PgBackend } from "./pgstore";

export interface RegisteredService {
  id: string;
  name: string;
  url: string; // the seller's own HTTP endpoint we proxy to
  priceUnits: string; // USDC atomic units (6dp) as a string
  desc: string;
  payTo: `0x${string}`; // the seller's wallet — paid DIRECTLY per call, no custody
  exampleInput: any;
  createdAt: string;
  calls: number;
  failures: number;
  revenueUnits: string; // cumulative earned, atomic units as string
  slashedUnits?: string; // cumulative stake slashed for misbehaviour, atomic units as string
}

interface StoreData {
  services: Record<string, RegisteredService>;
  external: { volumeUnits: string; sales: number }; // cumulative REAL external payins (persisted traction)
}

const DIR = process.env.AGORA_DATA_DIR || join(process.cwd(), ".data");
const FILE = join(DIR, "store.json");
const empty = (): StoreData => ({ services: {}, external: { volumeUnits: "0", sales: 0 } });

export class Store {
  private data: StoreData;
  private pg: PgBackend | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private backend: "file" | "postgres" = "file";
  private ok = true; // for postgres: true only once the load actually succeeds

  constructor() {
    const url = process.env.DATABASE_URL;
    if (url) {
      // Postgres mode: data loads asynchronously via init(); start empty until then.
      this.data = empty();
      try {
        this.pg = new PgBackend(url);
        this.backend = "postgres";
        this.ok = false;
        console.log("• store backend: Postgres (durable) — loading on init()");
      } catch (e) {
        console.error("Postgres init failed, falling back to file:", (e as Error).message);
        this.pg = null;
        this.data = this.readFile();
      }
    } else {
      this.data = this.readFile();
    }
  }

  /** Load durable state into memory. Call once on boot before serving requests. No-op in file mode. */
  async init(): Promise<void> {
    if (!this.pg) return;
    try {
      this.data = await this.pg.load();
      this.ok = true;
      console.log(`• store loaded from Postgres: ${Object.keys(this.data.services).length} services, ${this.data.external.sales} external sales`);
    } catch (e) {
      this.ok = false;
      console.error("Postgres load failed (continuing with empty state):", (e as Error).message);
    }
  }

  /** Health signal for /api/info — lets us verify durable persistence is actually live. */
  health() {
    return { backend: this.backend, ok: this.ok, services: Object.keys(this.data.services).length, externalSales: this.data.external.sales };
  }

  private readFile(): StoreData {
    try {
      return existsSync(FILE) ? { ...empty(), ...JSON.parse(readFileSync(FILE, "utf8")) } : empty();
    } catch {
      return empty();
    }
  }

  /** Atomic file write (temp + rename), debounced so bursts don't thrash the disk. File mode only. */
  private persistFile() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
        const tmp = FILE + ".tmp";
        writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        renameSync(tmp, FILE);
      } catch (e) {
        console.error("store persist failed:", (e as Error).message);
      }
    }, 250);
  }

  private saveService(svc: RegisteredService) {
    if (this.pg) this.pg.saveService(svc).catch((e) => console.error("pg saveService:", (e as Error).message));
    else this.persistFile();
  }
  private saveExternal() {
    if (this.pg) this.pg.saveExternal(this.data.external).catch((e) => console.error("pg saveExternal:", (e as Error).message));
    else this.persistFile();
  }

  // ---- registry ----
  registerService(svc: RegisteredService) {
    this.data.services[svc.id] = svc;
    this.saveService(svc);
    return svc;
  }
  getService(id: string): RegisteredService | undefined {
    return this.data.services[id];
  }
  listServices(): RegisteredService[] {
    return Object.values(this.data.services);
  }
  /** Record the outcome of a proxied call: bump calls/failures/revenue. */
  recordCall(id: string, priceUnits: bigint, success: boolean) {
    const s = this.data.services[id];
    if (!s) return;
    s.calls += 1;
    if (!success) s.failures += 1;
    else s.revenueUnits = (BigInt(s.revenueUnits) + priceUnits).toString();
    this.saveService(s);
  }
  /** Record USDC stake slashed from a misbehaving service (for transparency in the marketplace). */
  recordSlash(id: string, units: bigint) {
    const s = this.data.services[id];
    if (!s) return;
    s.slashedUnits = (BigInt(s.slashedUnits ?? "0") + units).toString();
    this.saveService(s);
  }

  // ---- persisted external traction (survives restarts) ----
  getExternal() {
    return { volumeUnits: BigInt(this.data.external.volumeUnits), sales: this.data.external.sales };
  }
  addExternal(units: bigint) {
    this.data.external.volumeUnits = (BigInt(this.data.external.volumeUnits) + units).toString();
    this.data.external.sales += 1;
    this.saveExternal();
  }
}

export const store = new Store();
