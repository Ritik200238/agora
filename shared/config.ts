import "dotenv/config";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Which deployment/network the runtime targets. "localhost" (default) or "arcTestnet". */
export const AGORA_NETWORK = process.env.AGORA_NETWORK || "localhost";

/** Settlement backend for the FlowMeter rail. */
export const SETTLEMENT_MODE = (process.env.SETTLEMENT ||
  (AGORA_NETWORK === "arcTestnet" ? "arc" : "local")) as "local" | "arc";

export const USDC_DECIMALS = 6;

export interface Deployment {
  network: string;
  chainId: number;
  usdc: `0x${string}`;
  usdcIsMock: boolean;
  identity: `0x${string}`;
  reputation: `0x${string}`;
  validation: `0x${string}`;
  bond: `0x${string}`;
  jobBoard: `0x${string}`;
  lendingPool: `0x${string}`;
  serviceBond: `0x${string}`;
  gatewayOperator?: string;
  deployer: string;
}

let _dep: Deployment | null = null;

/** Lazily load deployments/<network>.json (must exist — run scripts/deploy.js first). */
export function dep(network = AGORA_NETWORK): Deployment {
  if (_dep) return _dep;
  const p = join(ROOT, "deployments", `${network}.json`);
  try {
    _dep = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    throw new Error(
      `No deployment found at ${p}. Deploy first: npm run deploy:local (or deploy:arc).`
    );
  }
  return _dep!;
}
