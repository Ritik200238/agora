// Seed the marketplace with REAL, useful, bonded house services so a first visitor lands on a working
// marketplace — not an empty page. Everything here is real: the endpoints do genuine work, the listings go
// through the same seller path any third party uses, and each is backed by a real USDC stake in ServiceBond
// (so it carries the same slash risk). We're simply the first sellers on our own marketplace.
//
// Local/demo chain only. On Arc (real funds) the seed is skipped — sellers bring their own stake there.
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { walletFor, activeChain } from "../shared/chain";
import { privateKeyToAccount } from "viem/accounts";
import { parseEther } from "viem";
import { dep, SETTLEMENT_MODE } from "../shared/config";
import { usd, usdcMint, usdcApprove } from "../shared/usdc";
import * as A from "../shared/contracts";
import { store } from "./store";
import type { Society } from "../agents/society";

const BOND_EACH = usd(2); // $2 staked behind each house service

interface HouseSvc {
  id: string;
  key: `0x${string}`; // its own payout wallet (distinct bond per service)
  name: string;
  path: string;
  priceUsdc: number;
  desc: string;
  example: any;
  requires: string[]; // output fields it promises (the warranty contract)
  run: (input: any) => any; // always returns a result (never throws) — bad input ≠ a service failure
}

const HOUSE: HouseSvc[] = [
  {
    id: "svc_house_uuid",
    key: "0x1111111111111111111111111111111111111111111111111111111111111111",
    name: "UUID Generator",
    path: "/house/uuid",
    priceUsdc: 0.0002,
    desc: "Generate up to 50 RFC-4122 v4 UUIDs. input: { count }.",
    example: { count: 3 },
    requires: ["uuids"],
    run: (i) => {
      const count = Math.min(Math.max(Math.floor(Number(i?.count) || 1), 1), 50);
      return { count, uuids: Array.from({ length: count }, () => randomUUID()) };
    },
  },
  {
    id: "svc_house_slug",
    key: "0x2222222222222222222222222222222222222222222222222222222222222222",
    name: "Slugify",
    path: "/house/slug",
    priceUsdc: 0.0001,
    desc: "Turn any text into a clean URL slug. input: { text }.",
    example: { text: "Hello Arc World!" },
    requires: ["slug"],
    run: (i) => {
      const text = String(i?.text ?? "");
      const slug = text.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      return { text, slug };
    },
  },
  {
    id: "svc_house_json",
    key: "0x3333333333333333333333333333333333333333333333333333333333333333",
    name: "JSON Validator",
    path: "/house/json",
    priceUsdc: 0.0002,
    desc: "Validate + pretty-print JSON. input: { json }.",
    example: { json: '{"a":1,"b":[2,3]}' },
    requires: ["valid"],
    run: (i) => {
      const raw = typeof i?.json === "string" ? i.json : JSON.stringify(i?.json ?? null);
      try {
        const parsed = JSON.parse(raw);
        return { valid: true, pretty: JSON.stringify(parsed, null, 2), keys: parsed && typeof parsed === "object" ? Object.keys(parsed).length : 0 };
      } catch (e) {
        return { valid: false, error: String((e as Error)?.message ?? e) };
      }
    },
  },
];

/** Mount the real house-service endpoints. They always return 200 with a structured result. */
export function mountHouseEndpoints(app: Express): void {
  for (const h of HOUSE) {
    app.post(h.path, (req, res) => res.json(h.run(req.body?.input)));
  }
}

/** Register + bond the house services on boot (local/demo chain only). Idempotent + non-fatal. */
export async function seedMarketplace(society: Society, port: number): Promise<number> {
  if (SETTLEMENT_MODE === "arc") return 0; // never touch real funds — sellers bond their own on Arc
  let seeded = 0;
  const faucet = society.faucet;
  for (const h of HOUSE) {
    try {
      const acct = privateKeyToAccount(h.key);
      const wallet = walletFor(h.key);
      // fund the house seller: gas + USDC to stake
      await faucet.sendTransaction({ account: faucet.account, chain: activeChain, to: acct.address, value: parseEther("1") });
      await usdcMint(faucet, dep().usdc, acct.address, usd(5));
      // list it through the real registry (preserve real usage stats across restarts)
      const prev = store.getService(h.id);
      store.registerService({
        id: h.id,
        name: h.name,
        url: `http://127.0.0.1:${port}${h.path}`, // server calls itself over loopback: reliable, no egress
        priceUnits: usd(h.priceUsdc).toString(),
        desc: h.desc,
        payTo: acct.address,
        exampleInput: h.example,
        createdAt: prev?.createdAt ?? new Date().toISOString(),
        calls: prev?.calls ?? 0,
        failures: prev?.failures ?? 0,
        revenueUnits: prev?.revenueUnits ?? "0",
        slashedUnits: prev?.slashedUnits ?? "0",
        requires: h.requires,
      });
      // stake real USDC behind it (top up to BOND_EACH)
      const already = await A.serviceBondOf(acct.address).catch(() => 0n);
      if (already < BOND_EACH) {
        await usdcApprove(wallet, dep().usdc, dep().serviceBond, BOND_EACH - already);
        await A.serviceBondPost(wallet, BOND_EACH - already);
      }
      seeded++;
    } catch (e) {
      console.error(`seed ${h.id} skipped:`, (e as Error)?.message);
    }
  }
  if (seeded) console.log(`• seeded ${seeded} bonded house services on the marketplace`);
  return seeded;
}
