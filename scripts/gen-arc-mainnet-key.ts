// Generate (or reuse) a DEDICATED Arc MAINNET operator key — never the testnet key: this one holds real USDC.
// Saves MAINNET_PRIVATE_KEY to .env (gitignored) and prints ONLY the public address to fund. Idempotent.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const path = ".env";
let env = existsSync(path) ? readFileSync(path, "utf8") : "";
const existing = env.match(/^MAINNET_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m);
let pk: `0x${string}`;
if (existing) pk = existing[1] as `0x${string}`;
else {
  pk = generatePrivateKey();
  env = (env && !env.endsWith("\n") ? env + "\n" : env) + `MAINNET_PRIVATE_KEY=${pk}\n`;
  writeFileSync(path, env);
}
console.log("\n  Arc MAINNET operator address (fund with real USDC on Arc, chain 5042):\n");
console.log("    " + privateKeyToAccount(pk).address + "\n");
console.log("  (private key saved to .env as MAINNET_PRIVATE_KEY — gitignored, never printed or committed)\n");
