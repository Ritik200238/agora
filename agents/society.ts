import { Agent, type AgentConfig, type Role } from "./agent";
import { walletFor, type Wallet } from "../shared/chain";
import { HARDHAT_KEYS } from "../shared/local-accounts";
import { dep } from "../shared/config";
import { usd, usdcMint, usdcApprove } from "../shared/usdc";
import * as A from "../shared/contracts";

export interface Society {
  agents: Agent[];
  faucet: Wallet;
  byRole(r: Role): Agent[];
  byName(n: string): Agent | undefined;
}

/** The default Agora cast: consumers, a broker, specialized workers, a validator, a producer,
 *  and one fraudster (`honest:false`) used to demonstrate automatic slashing. */
export const DEFAULT_CAST: AgentConfig[] = [
  { name: "Atlas", role: "consumer", keyIndex: 1, honest: true, skill: "" },
  { name: "Beacon", role: "consumer", keyIndex: 2, honest: true, skill: "" },
  { name: "Hermes", role: "broker", keyIndex: 3, honest: true, skill: "" },
  { name: "Sorter-1", role: "worker", keyIndex: 4, honest: true, skill: "sort" },
  { name: "Summer-1", role: "worker", keyIndex: 5, honest: true, skill: "sum" },
  { name: "Maxer-1", role: "worker", keyIndex: 6, honest: true, skill: "max" },
  { name: "Themis", role: "validator", keyIndex: 7, honest: true, skill: "" },
  { name: "Oracle", role: "producer", keyIndex: 8, honest: true, skill: "feed" },
  { name: "Sorter-2", role: "worker", keyIndex: 9, honest: true, skill: "sort" },
  { name: "Summer-2", role: "worker", keyIndex: 10, honest: true, skill: "sum" },
  { name: "Grift", role: "worker", keyIndex: 11, honest: false, skill: "sum" }, // the fraudster
];

const AGENT_BUDGET = () => usd(500);
const AGENT_RATECAP = () => usd(50);
const AGENT_FUNDING = () => usd(500);
const BOND_AMOUNT = () => usd(50);

/** Build the society: instantiate agents, register passports on-chain, fund + bond them. */
export async function buildSociety(cast: AgentConfig[] = DEFAULT_CAST): Promise<Society> {
  const faucet = walletFor(HARDHAT_KEYS[0]);
  const D = dep();
  const agents = cast.map((c) => new Agent(c, AGENT_BUDGET(), AGENT_RATECAP()));

  // register + fund
  for (const a of agents) {
    await A.registerAgent(a.wallet, a.role, `agora://agent/${a.name}`);
    a.agentId = await A.agentOf(a.address);
    await usdcMint(faucet, D.usdc, a.address, AGENT_FUNDING());
  }

  // give each worker a per-skill base quote (varied → real price differences drive discovery)
  for (const a of agents) {
    if (a.role === "worker") a.baseRate = usd(0.8) + usd(0.1) * BigInt(a.cfg.keyIndex % 5);
  }

  // workers + producers post a reputation bond (reputation-as-collateral)
  for (const a of agents) {
    if (a.role === "worker" || a.role === "producer") {
      await usdcApprove(a.wallet, D.usdc, D.bond, BOND_AMOUNT());
      await A.postBond(a.wallet, BOND_AMOUNT());
    }
  }

  return {
    agents,
    faucet,
    byRole: (r) => agents.filter((a) => a.role === r),
    byName: (n) => agents.find((a) => a.name === n),
  };
}
