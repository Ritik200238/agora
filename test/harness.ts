import { spawn, execSync, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const RPC = "http://127.0.0.1:8545";

async function rpcUp(): Promise<boolean> {
  try {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export interface Chain {
  spawned: boolean;
  stop: () => void;
}

/** Start (or reuse) a local Hardhat node, then deploy Agora onto it. */
export async function startChain(): Promise<Chain> {
  let node: ChildProcess | null = null;
  let spawned = false;

  if (!(await rpcUp())) {
    console.log("• starting hardhat node…");
    node = spawn("npx", ["hardhat", "node"], { shell: true, stdio: "ignore" });
    spawned = true;
    for (let i = 0; i < 80; i++) {
      if (await rpcUp()) break;
      await sleep(500);
    }
    if (!(await rpcUp())) throw new Error("hardhat node failed to start");
  } else {
    console.log("• reusing already-running hardhat node");
  }

  console.log("• deploying contracts…");
  execSync("npx hardhat run scripts/deploy.js --network localhost", { stdio: "inherit" });

  const stop = () => {
    if (!spawned || !node?.pid) return;
    try {
      if (process.platform === "win32") {
        execSync(`taskkill /pid ${node.pid} /T /F`, { stdio: "ignore" });
      } else {
        node.kill("SIGKILL");
      }
    } catch {
      /* already gone */
    }
  };
  return { spawned, stop };
}
