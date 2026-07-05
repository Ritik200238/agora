// Persistent store for the multi-tenant gateway — the service registry + cumulative real external volume.
// Backend: an atomic JSON file (zero native deps, works on Render/local/Codespaces; survives restarts).
// For scale, set DATABASE_URL and swap the backend behind this same interface (documented upgrade).
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

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
  private saveTimer: NodeJS.Timeout | null = null;

  constructor() {
    try {
      this.data = existsSync(FILE) ? { ...empty(), ...JSON.parse(readFileSync(FILE, "utf8")) } : empty();
    } catch {
      this.data = empty();
    }
  }

  /** Atomic write (temp file + rename), debounced so bursts of calls don't thrash the disk. */
  private persist() {
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

  // ---- registry ----
  registerService(svc: RegisteredService) {
    this.data.services[svc.id] = svc;
    this.persist();
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
    this.persist();
  }

  // ---- persisted external traction (survives restarts) ----
  getExternal() {
    return { volumeUnits: BigInt(this.data.external.volumeUnits), sales: this.data.external.sales };
  }
  addExternal(units: bigint) {
    this.data.external.volumeUnits = (BigInt(this.data.external.volumeUnits) + units).toString();
    this.data.external.sales += 1;
    this.persist();
  }
}

export const store = new Store();
