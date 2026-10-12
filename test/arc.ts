// LIVE test against real Arc Testnet + Circle's Gateway facilitator (spends a few cents of testnet USDC).
// Needs PRIVATE_KEY (the funded operator) in .env. Not part of CI — run with `npm run test:arc`.
import "dotenv/config";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { ArcRail, ArcTabFunder } from "../dashboard/arcrail";
import { arcMarket } from "../dashboard/market";
import { ARC_RPC } from "../shared/arc";

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const opKey = process.env.PRIVATE_KEY as `0x${string}` | undefined;
  if (!opKey) {
    console.log("⏭️  ARC LIVE TEST SKIPPED — set PRIVATE_KEY (a funded Arc Testnet key) to run it.");
    process.exit(0);
  }
  const operator = privateKeyToAccount(opKey).address;

  console.log("\n[Circle Gateway rail on real Arc]");
  const rail = await new ArcRail(opKey).init();
  check("facilitator supports Arc (verifying contract + USDC loaded)", true);

  // the on-chain reserve floor holds even with budget to spare (restarts reset the in-memory budget, not this)
  const guarded = new ArcTabFunder(opKey, 50_000n, undefined, undefined, 10n ** 15n); // floor far above any balance
  const blocked = await guarded.open(10_000n).then(() => "FUNDED", (e) => String(e?.message ?? e));
  check("tab funding stops at the operator's on-chain reserve floor", /reserve/.test(blocked), blocked.slice(0, 70));

  const funder = new ArcTabFunder(opKey, 50_000n); // $0.05 budget for this run
  const t0 = Date.now();
  const tab = await funder.open(10_000n); // $0.01 cap
  check("a demo tab opens: funded on Arc + real Gateway deposit, handed out only once credited", /^0x[0-9a-f]{64}$/i.test(tab.depositTx), `deposit ${tab.depositTx.slice(0, 12)}… ready in ${Date.now() - t0}ms`);
  const buyer = new GatewayClient({ chain: "arcTestnet", privateKey: tab.privateKey, rpcUrl: ARC_RPC });
  const bal0 = BigInt((await buyer.getBalances()).gateway.available);
  check("the tab's Gateway balance is its cap", bal0 === 10_000n, `available=${bal0}`);

  const res = "https://agora.test/x402/arc/feed";
  // 1) a $0.000001 call that delivers → settled
  const reqs = rail.requirements(1n, operator);
  const p1 = await rail.sign(tab.privateKey, reqs, res, "feed");
  const c1 = await rail.charge(p1, reqs, async () => ({ ok: true, result: { v: 1 } }));
  check("a $0.000001 call verifies, runs and SETTLES via Circle", c1.ok && !!(c1 as any).transfer, c1.ok ? `transfer ${c1.transfer}` : JSON.stringify((c1 as any).body));

  // 2) a call whose delivery fails → never settled → buyer not charged
  const reqs2 = rail.requirements(1_000n, operator);
  const p2 = await rail.sign(tab.privateKey, reqs2, res, "feed");
  const c2 = await rail.charge(p2, reqs2, async () => ({ ok: false, status: 502, body: { error: "seller failed" } }));
  check("a failed delivery is NOT settled", !c2.ok && (c2 as any).charged === false && c2.status === 502);

  // 3) replaying the settled authorization is refused
  let replayRan = false;
  const c3 = await rail.charge(p1, reqs, async () => { replayRan = true; return { ok: true, result: { v: 2 } }; });
  check("replaying a settled payment is refused before the service runs", !c3.ok && !replayRan, !c3.ok ? String((c3 as any).body?.error ?? "") : "SERVED TWICE");
  // …and even a fresh rail (no local memory, e.g. after a restart) can never settle it twice: Circle burns the nonce
  const c3b = await new ArcRail(opKey).init().then((r2) => r2.charge(p1, reqs, async () => ({ ok: true, result: {} })));
  check("Circle refuses the replay at settlement even without local memory", !c3b.ok, String((c3b as any).body?.reason ?? (c3b as any).body?.error ?? ""));

  // 3b) a payer with NO Gateway balance is refused BEFORE the service runs (sellers never work for free)
  const broke = generatePrivateKey();
  const pb = await rail.sign(broke, reqs, res, "feed");
  let ran = false;
  const cb = await rail.charge(pb, reqs, async () => { ran = true; return { ok: true, result: {} }; });
  check("an unfunded payer is refused before the seller's service runs", !cb.ok && cb.status === 402 && !ran, !cb.ok ? String((cb as any).body?.error) : "SERVED");

  // 4) terms mismatch (pay $0.000001, claim a $0.001 resource) is refused before verification
  const c4 = await rail.charge(p1, reqs2, async () => ({ ok: true, result: {} }));
  check("a payment for different terms is refused", !c4.ok && c4.status === 402);

  await sleep(3000);
  const bal1 = BigInt((await buyer.getBalances()).gateway.available);
  check("the buyer paid exactly the one delivered call (failed call cost nothing)", bal0 - bal1 === 1n, `balance ${bal0} → ${bal1}`);

  console.log("\n[marketplace contracts on Arc]");
  const m = arcMarket(opKey);
  const [pool, slashed, bond] = await Promise.all([m.insuranceAvailable(), m.totalSlashed(), m.bondOf(operator)]);
  check("ServiceBond + InsurancePool are live on Arc and readable", pool >= 0n && slashed >= 0n && bond >= 0n, `pool=${pool} slashed=${slashed}`);

  console.log(fails === 0 ? "\n✅ ARC LIVE PASSED — real nanopayments on Arc via Circle Gateway, charged only on delivery." : `\n❌ ${fails} ARC LIVE CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("ARC LIVE TEST CRASHED:", (e as any)?.shortMessage || (e as Error)?.message || e);
  process.exit(1);
});
