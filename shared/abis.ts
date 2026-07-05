import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./config";

/** Load a compiled contract ABI from Hardhat artifacts (run `npm run compile` first). */
function abi(name: string): any[] {
  const p = join(ROOT, "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  return JSON.parse(readFileSync(p, "utf8")).abi;
}

export const ABIS = {
  MockUSDC: abi("MockUSDC"), // superset of ERC-20 (used as the USDC interface)
  IdentityRegistry: abi("IdentityRegistry"),
  ReputationRegistry: abi("ReputationRegistry"),
  ValidationRegistry: abi("ValidationRegistry"),
  ReputationBond: abi("ReputationBond"),
  ServiceBond: abi("ServiceBond"),
  InsurancePool: abi("InsurancePool"),
  JobBoard: abi("JobBoard"),
  LendingPool: abi("LendingPool"),
} as const;
