// Generate (or reuse) the Arc deployer key: saves PRIVATE_KEY to .env (gitignored) and prints ONLY the
// public address to fund at https://faucet.circle.com. Idempotent — re-running keeps the same key.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const path = ".env";
let env = existsSync(path) ? readFileSync(path, "utf8") : "";

const existing = env.match(/^PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m);
let pk: `0x${string}`;
if (existing) {
  pk = existing[1] as `0x${string}`;
} else {
  pk = generatePrivateKey();
  env = /^PRIVATE_KEY=/m.test(env)
    ? env.replace(/^PRIVATE_KEY=.*$/m, `PRIVATE_KEY=${pk}`)
    : (env && !env.endsWith("\n") ? env + "\n" : env) + `PRIVATE_KEY=${pk}\n`;
  writeFileSync(path, env);
}

const account = privateKeyToAccount(pk);
console.log("\n  Fund THIS address with Arc Testnet USDC at https://faucet.circle.com :\n");
console.log("    " + account.address + "\n");
console.log("  (private key saved to .env — gitignored, never printed or committed)\n");
