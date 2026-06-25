import { decodeEventLog } from "viem";
import { publicClient, activeChain, type Wallet } from "./chain";
import { ABIS } from "./abis";
import { dep } from "./config";

/** Send a contract write and wait for the receipt. */
async function send(wallet: Wallet, address: `0x${string}`, abi: any[], functionName: string, args: any[]) {
  const hash = await wallet.writeContract({
    account: wallet.account,
    chain: activeChain,
    address,
    abi,
    functionName,
    args,
  });
  return publicClient.waitForTransactionReceipt({ hash });
}

function read(address: `0x${string}`, abi: any[], functionName: string, args: any[] = []) {
  return publicClient.readContract({ address, abi, functionName, args });
}

// ---------- Identity (ERC-8004) ----------
export const registerAgent = (w: Wallet, role: string, uri: string) =>
  send(w, dep().identity, ABIS.IdentityRegistry, "register", [role, uri]);
export const agentOf = (addr: `0x${string}`) =>
  read(dep().identity, ABIS.IdentityRegistry, "agentOf", [addr]) as Promise<bigint>;
export const ownerOfAgent = (id: bigint) =>
  read(dep().identity, ABIS.IdentityRegistry, "ownerOf", [id]) as Promise<`0x${string}`>;
export const roleOf = (id: bigint) =>
  read(dep().identity, ABIS.IdentityRegistry, "role", [id]) as Promise<string>;
export const metadataOf = (id: bigint) =>
  read(dep().identity, ABIS.IdentityRegistry, "metadataURI", [id]) as Promise<string>;

// ---------- Reputation (ERC-8004) ----------
export const scoreOf = (id: bigint) =>
  read(dep().reputation, ABIS.ReputationRegistry, "scoreOf", [id]) as Promise<bigint>;
export async function statsOf(id: bigint) {
  const [score, jobs, completed, failed] = (await read(
    dep().reputation,
    ABIS.ReputationRegistry,
    "statsOf",
    [id]
  )) as readonly [bigint, bigint, bigint, bigint];
  return { score, jobs, completed, failed };
}

// ---------- Reputation bond (collateral) ----------
export const postBond = (w: Wallet, amount: bigint) =>
  send(w, dep().bond, ABIS.ReputationBond, "postBond", [amount]);
export const withdrawBond = (w: Wallet, amount: bigint) =>
  send(w, dep().bond, ABIS.ReputationBond, "withdraw", [amount]);
export const bondOf = (addr: `0x${string}`) =>
  read(dep().bond, ABIS.ReputationBond, "bondOf", [addr]) as Promise<bigint>;

// ---------- JobBoard (ERC-8183 escrow lifecycle) ----------
export interface PostJobParams {
  workerId: bigint;
  validatorId: bigint;
  brokerId: bigint; // 0n = none
  brokerFeeBps: number;
  validatorFeeBps: number;
  amount: bigint;
  deadline: bigint; // unix seconds
  specHash: `0x${string}`;
}

/** Post a job (escrow USDC) and return the new jobId (parsed from the JobPosted event). */
export async function postJob(w: Wallet, p: PostJobParams): Promise<bigint> {
  const receipt = await send(w, dep().jobBoard, ABIS.JobBoard, "postJob", [
    p.workerId,
    p.validatorId,
    p.brokerId,
    p.brokerFeeBps,
    p.validatorFeeBps,
    p.amount,
    p.deadline,
    p.specHash,
  ]);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== dep().jobBoard.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: ABIS.JobBoard, data: log.data, topics: log.topics });
      if (ev.eventName === "JobPosted") return (ev.args as any).jobId as bigint;
    } catch {
      /* not our event */
    }
  }
  throw new Error("JobPosted event not found in receipt");
}

export const submitJob = (w: Wallet, jobId: bigint, deliverable: `0x${string}`) =>
  send(w, dep().jobBoard, ABIS.JobBoard, "submit", [jobId, deliverable]);
export const validateJob = (w: Wallet, jobId: bigint, passed: boolean) =>
  send(w, dep().jobBoard, ABIS.JobBoard, "validate", [jobId, passed]);
export const expireJob = (w: Wallet, jobId: bigint) =>
  send(w, dep().jobBoard, ABIS.JobBoard, "expire", [jobId]);

export const JOB_STATUS = ["None", "Open", "Submitted", "Completed", "Rejected", "Expired"] as const;
export async function getJob(jobId: bigint) {
  const j = (await read(dep().jobBoard, ABIS.JobBoard, "getJob", [jobId])) as any;
  return {
    clientId: j.clientId as bigint,
    workerId: j.workerId as bigint,
    validatorId: j.validatorId as bigint,
    brokerId: j.brokerId as bigint,
    amount: j.amount as bigint,
    deadline: j.deadline as bigint,
    status: JOB_STATUS[Number(j.status)],
    statusCode: Number(j.status),
  };
}

/** On-chain economy counters used by the dashboard for "GDP". */
export async function economy() {
  const jb = dep().jobBoard;
  const [totalSettled, jobsCompleted, jobsRejected, jobsExpired, nextJobId] = await Promise.all([
    read(jb, ABIS.JobBoard, "totalSettled") as Promise<bigint>,
    read(jb, ABIS.JobBoard, "jobsCompleted") as Promise<bigint>,
    read(jb, ABIS.JobBoard, "jobsRejected") as Promise<bigint>,
    read(jb, ABIS.JobBoard, "jobsExpired") as Promise<bigint>,
    read(jb, ABIS.JobBoard, "nextJobId") as Promise<bigint>,
  ]);
  return { totalSettled, jobsCompleted, jobsRejected, jobsExpired, jobsTotal: nextJobId - 1n };
}
