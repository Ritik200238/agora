import { walletFor, type Wallet } from "../shared/chain";
import { HARDHAT_KEYS } from "../shared/local-accounts";
import { SpendFirewall } from "./treasury";

export type Role = "consumer" | "worker" | "broker" | "validator" | "producer";

export interface AgentConfig {
  name: string;
  role: Role;
  keyIndex: number; // index into the local key set (>=1; 0 is the faucet/deployer)
  honest: boolean; // false = fraudster (delivers tampered work)
  skill: string; // e.g. "sum" | "sort" | "max" | "feed"
}

/**
 * An autonomous economic actor: an on-chain passport + wallet, a role + skill, a treasury
 * spend-firewall, and running P&L. Behavior (discover/negotiate/hire/deliver/validate) lives
 * in the orchestrator loop, which calls these agents each tick.
 */
export class Agent {
  readonly wallet: Wallet;
  readonly address: `0x${string}`;
  agentId = 0n;
  readonly firewall: SpendFirewall;

  // running stats (mirror on-chain reality; surfaced on the dashboard)
  earned = 0n;
  spent = 0n;
  jobsPosted = 0;
  jobsDone = 0;
  jobsFailed = 0;
  streamsRun = 0;

  // economics
  baseRate = 0n; // per-skill base quote (workers); set by the society; drives price discovery
  borrowed = 0n; // outstanding credit-market debt (workers)

  constructor(public readonly cfg: AgentConfig, budget: bigint, rateCap: bigint) {
    this.wallet = walletFor(HARDHAT_KEYS[cfg.keyIndex]);
    this.address = this.wallet.account.address;
    this.firewall = new SpendFirewall(budget, rateCap);
  }

  get name(): string {
    return this.cfg.name;
  }
  get role(): Role {
    return this.cfg.role;
  }
  get skill(): string {
    return this.cfg.skill;
  }
  get honest(): boolean {
    return this.cfg.honest;
  }
}
