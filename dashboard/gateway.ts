// Agora Pay-Per-Use Gateway — the PUBLIC edge of the economy.
//
// This is what turns Agora from a closed simulation into a real product: anyone (a human via the
// /pay UI, or an external AI agent via the SDK) can pay TINY USDC PER CALL for real services over
// the x402 protocol. Two payment models, both settling REAL USDC on-chain:
//
//   1. Tabs (Dexter-style, browser-tryable): open a capped "tab" (pre-funded demo credit on the local
//      chain), then pay-per-call against it. The server custodies the tab wallet; the contract-enforced
//      cap means an agent can never overspend. Every call is a real on-chain USDC transfer.
//   2. Raw x402 (for external agents with their own funded wallet): GET a service → 402 + price terms →
//      transfer USDC yourself → POST { payment: txHash, input } → get the result. Verified on-chain.
//
// Every purchase here is counted as REAL externalVolume (distinct from the agents' internal wash volume).
import express, { type Express } from "express";
import { resolveMx } from "node:dns/promises";
import { keccak256, toHex, parseAbiItem, decodeEventLog, parseEther } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { publicClient, walletFor, activeChain, type Wallet } from "../shared/chain";
import { dep, SETTLEMENT_MODE } from "../shared/config";
import { usd, fmtUsd, usdcMint, usdcTransfer } from "../shared/usdc";
import * as A from "../shared/contracts";
import { rateLimit } from "./ratelimit";
import { store, type RegisteredService } from "./store";
import { renderServicePage, renderNotFound, renderRobots, renderSitemap, publicBase, type PageService } from "./pages";
import type { Economy } from "../orchestrator/economy";
import type { Society } from "../agents/society";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

// --- REAL data oracle: live crypto prices from CoinGecko (free, no key). Cached to respect rate limits.
//     If the real source is unavailable it THROWS — the caller is never charged and never served fake data. ---
const PRICE_TTL_MS = 30_000;
const PRICE_ASSETS = ["bitcoin", "ethereum", "solana", "usd-coin", "tether", "dogecoin", "arbitrum", "chainlink"];
const priceCache = new Map<string, { usd: number; at: number }>();
async function fetchPrice(assetIn: unknown) {
  const asset = String(assetIn || "bitcoin").toLowerCase().trim();
  if (!PRICE_ASSETS.includes(asset)) throw new Error(`unknown asset '${asset}' — try: ${PRICE_ASSETS.join(", ")}`);
  const now = Date.now();
  const c = priceCache.get(asset);
  if (c && now - c.at < PRICE_TTL_MS) return { asset, usd: c.usd, source: "coingecko", cached: true, asOf: new Date(c.at).toISOString() };
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(asset)}&vs_currencies=usd`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`price source unavailable (HTTP ${res.status})`);
  const j: any = await res.json();
  const usd = j?.[asset]?.usd;
  if (typeof usd !== "number") throw new Error(`no live price for '${asset}'`);
  priceCache.set(asset, { usd, at: now });
  return { asset, usd, source: "coingecko", cached: false, asOf: new Date(now).toISOString() };
}

// --- REAL weather: current conditions from Open-Meteo (free, no key). Throws if the source is down so the
//     buyer is never charged for a failed fetch. ---
const WMO: Record<number, string> = { 0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "rime fog", 51: "light drizzle", 53: "drizzle", 55: "dense drizzle", 61: "light rain", 63: "rain", 65: "heavy rain", 71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers", 81: "rain showers", 82: "violent rain showers", 95: "thunderstorm", 96: "thunderstorm w/ hail", 99: "thunderstorm w/ hail" };
const weatherCache = new Map<string, { data: any; at: number }>();
async function fetchWeather(cityIn: unknown) {
  const city = String(cityIn || "").trim();
  if (!city) throw new Error("weather requires input.city (e.g. { city: \"Tokyo\" })");
  const now = Date.now();
  const cached = weatherCache.get(city.toLowerCase());
  if (cached && now - cached.at < 300_000) return { ...cached.data, cached: true };
  const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`, { headers: { accept: "application/json" } });
  if (!g.ok) throw new Error(`geocoding unavailable (HTTP ${g.status})`);
  const loc = (await g.json() as any)?.results?.[0];
  if (!loc) throw new Error(`unknown city '${city}'`);
  const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`, { headers: { accept: "application/json" } });
  if (!w.ok) throw new Error(`weather source unavailable (HTTP ${w.status})`);
  const cur = (await w.json() as any)?.current;
  if (!cur) throw new Error("no live weather data");
  const data = { city: loc.name, country: loc.country, tempC: cur.temperature_2m, humidity: cur.relative_humidity_2m, windKph: cur.wind_speed_10m, conditions: WMO[cur.weather_code] ?? `code ${cur.weather_code}`, source: "open-meteo", asOf: new Date(now).toISOString() };
  weatherCache.set(city.toLowerCase(), { data, at: now });
  return data;
}

// --- REAL FX: live currency conversion from open.er-api.com (free, no key), cached per base currency. ---
const fxCache = new Map<string, { rates: Record<string, number>; at: number }>();
async function fetchFx(input: any) {
  const from = String(input?.from ?? "USD").toUpperCase().trim();
  const to = String(input?.to ?? "EUR").toUpperCase().trim();
  const amount = Number(input?.amount ?? 1);
  if (!Number.isFinite(amount)) throw new Error("fx requires a numeric input.amount");
  const now = Date.now();
  let c = fxCache.get(from);
  if (!c || now - c.at > 3_600_000) {
    const res = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`fx source unavailable (HTTP ${res.status})`);
    const j: any = await res.json();
    if (j?.result !== "success" || !j?.rates) throw new Error(`unknown base currency '${from}'`);
    c = { rates: j.rates, at: now };
    fxCache.set(from, c);
  }
  const rate = c.rates[to];
  if (typeof rate !== "number") throw new Error(`unknown target currency '${to}'`);
  return { from, to, amount, rate, result: +(amount * rate).toFixed(6), source: "er-api", asOf: new Date(c.at).toISOString() };
}

// --- REAL email deliverability: a live DNS MX lookup (no key). Returns a structured verdict (never throws
//     on bad input — a "not deliverable" answer is still a valid delivery the buyer asked for). ---
async function validateEmail(input: any) {
  const email = String(input?.email ?? "").trim();
  const m = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(email);
  if (!m) return { email, valid: false, deliverable: false, reason: "invalid syntax" };
  const domain = m[1].toLowerCase();
  let mx: { exchange: string; priority: number }[] = [];
  try {
    mx = await resolveMx(domain);
  } catch {
    mx = [];
  }
  const hasMx = mx.length > 0;
  return { email, valid: true, domain, hasMx, deliverable: hasMx, mx: mx.sort((a, b) => a.priority - b.priority).slice(0, 3).map((r) => r.exchange) };
}

// ---- the real, useful services the gateway sells (pay-per-call, rule-based, no API keys) ----
interface Service {
  id: string;
  price: bigint;
  desc: string;
  example: any;
  run: (input: any, eco: Economy) => any;
}

function makeServices(): Record<string, Service> {
  const list: Service[] = [
    {
      id: "feed",
      price: usd(0.000001), // $0.000001 — the hackathon's headline nanopayment
      desc: "One live reading from the economy's data feed (its current on-chain GDP).",
      example: {},
      run: (_input, eco) => ({ metric: "gdp_usdc", value: eco.lastGdp, tick: eco.tickN }),
    },
    {
      id: "price",
      price: usd(0.0001), // $0.0001 per real price read — a genuine reason to pay
      desc: "Live USD price of a crypto asset — REAL market data (CoinGecko). input: { asset }.",
      example: { asset: "bitcoin" },
      run: (input) => fetchPrice(input?.asset),
    },
    {
      id: "fx",
      price: usd(0.0001), // $0.0001 — live currency conversion (real reference data, the #1 x402 category)
      desc: "Live currency conversion — REAL FX rates. input: { from, to, amount }.",
      example: { from: "USD", to: "EUR", amount: 100 },
      run: (input) => fetchFx(input),
    },
    {
      id: "weather",
      price: usd(0.0002), // $0.0002 — real current weather for a city
      desc: "Current weather for a city — REAL data (Open-Meteo). input: { city }.",
      example: { city: "Tokyo" },
      run: (input) => fetchWeather(input?.city),
    },
    {
      id: "email",
      price: usd(0.0002), // $0.0002 — real deliverability check before an agent emails a lead
      desc: "Email deliverability check via a live DNS MX lookup. input: { email }.",
      example: { email: "founder@stripe.com" },
      run: (input) => validateEmail(input),
    },
    {
      id: "trust",
      price: usd(0.001), // $0.001 to check an agent before you risk money dealing with it
      desc: "Agent Reputation / Trust Oracle — on-chain trust profile + verdict BEFORE you deal. input: { agent }.",
      example: { agent: "Maxer-1" },
      run: (input, eco) => trustProfile(input?.agent, eco),
    },
    {
      id: "hash",
      price: usd(0.0001), // $0.0001
      desc: "Keccak-256 of your input string.",
      example: { data: "hello arc" },
      run: (input) => {
        const data = String(input?.data ?? "");
        return { input: data, keccak256: keccak256(toHex(data)) };
      },
    },
    {
      id: "stats",
      price: usd(0.0005), // $0.0005
      desc: "Text statistics: characters, words, sentences, lines.",
      example: { text: "Pay per call. No subscription." },
      run: (input) => {
        const t = String(input?.text ?? "");
        return {
          chars: t.length,
          words: t.trim() ? t.trim().split(/\s+/).length : 0,
          sentences: (t.match(/[.!?]+/g) || []).length,
          lines: t ? t.split(/\n/).length : 0,
        };
      },
    },
    {
      id: "compute",
      price: usd(0.001), // $0.001
      desc: "Objective compute over numbers: op = sort | sum | max.",
      example: { op: "sum", nums: [3, 1, 4, 1, 5] },
      run: (input) => {
        const nums = Array.isArray(input?.nums) ? input.nums.map(Number).filter((n: number) => Number.isFinite(n)) : [];
        if (!nums.length) throw new Error("compute requires nums: number[]");
        const op = String(input?.op ?? "sum");
        if (op === "sort") return { op, result: [...nums].sort((a, b) => a - b) };
        if (op === "max") return { op, result: Math.max(...nums) };
        return { op: "sum", result: nums.reduce((a: number, b: number) => a + b, 0) };
      },
    },
  ];
  return Object.fromEntries(list.map((s) => [s.id, s]));
}

// --- Agent Reputation / Trust Oracle — the on-chain trust profile of an agent BEFORE you deal with it.
//     This is the thing only WE have: a live ERC-8004 reputation + slashable-bond + credit graph.
//     "Should I trust agent X?" answered from real on-chain signals, with a verdict. ---
async function trustProfile(ref: unknown, eco: Economy) {
  const society = eco.society;
  const s = String(ref ?? "").trim();
  if (!s) throw new Error("trust requires input.agent (a name, agentId, or 0x address)");
  let agentId = 0n;
  let address: `0x${string}` | undefined;
  let name: string | undefined;
  const byName = society.byName(s);
  if (byName) {
    agentId = byName.agentId; address = byName.address; name = byName.name;
  } else if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
    address = s as `0x${string}`;
    agentId = await A.agentOf(address);
    name = society.agents.find((a) => a.address.toLowerCase() === s.toLowerCase())?.name;
  } else if (/^\d+$/.test(s)) {
    agentId = BigInt(s);
    const a = society.agents.find((x) => x.agentId === agentId);
    address = a?.address; name = a?.name;
  } else throw new Error(`could not resolve agent '${s}' (use a name, agentId, or 0x address)`);
  if (!agentId || agentId === 0n) throw new Error(`no on-chain identity for '${s}'`);
  if (!address) address = await A.ownerOfAgent(agentId);

  const role = await A.roleOf(agentId).catch(() => "unknown");
  const stats = await A.statsOf(agentId); // { score, jobs, completed, failed }
  const collateralized = role === "worker" || role === "producer";
  const [bond, avail, locked, debt, limit] = await Promise.all([
    collateralized ? A.bondOf(address) : Promise.resolve(0n),
    collateralized ? A.availableBond(address) : Promise.resolve(0n),
    collateralized ? A.lockedBond(address) : Promise.resolve(0n),
    A.debtOf(address),
    role === "worker" ? A.creditLimit(agentId) : Promise.resolve(0n),
  ]);

  const score = Number(stats.score);
  const completed = Number(stats.completed);
  const failed = Number(stats.failed);
  const bonded = Number(fmtUsd(bond));
  // trust score (0..100) derived from REAL on-chain signals: reputation, failures, bonded collateral
  let trust = 50 + score * 0.3 - failed * 25 + Math.min(bonded, 50) * 0.4;
  if (score < 0) trust -= 30;
  trust = Math.max(0, Math.min(100, Math.round(trust)));
  const verdict = trust >= 75 ? "TRUSTED" : trust >= 40 ? "NEUTRAL" : trust >= 15 ? "RISKY" : "AVOID";

  const reasons: string[] = [];
  if (score > 0) reasons.push(`+${score} on-chain reputation`);
  else if (score < 0) reasons.push(`NEGATIVE reputation (${score}) — previously slashed for fraud`);
  else reasons.push("no reputation history yet");
  if (bonded > 0) reasons.push(`$${bonded.toFixed(2)} bonded collateral (skin in the game)`);
  reasons.push(`${completed} job(s) completed, ${failed} failed`);
  if (Number(fmtUsd(locked)) > 0) reasons.push(`$${fmtUsd(locked)} locked in active jobs`);
  if (Number(fmtUsd(debt)) > 0) reasons.push(`$${fmtUsd(debt)} outstanding credit`);

  return {
    agent: name ?? `#${agentId}`,
    agentId: agentId.toString(),
    address,
    role,
    reputation: score,
    jobs: { completed, failed },
    bond: collateralized ? { total: fmtUsd(bond), available: fmtUsd(avail), locked: fmtUsd(locked) } : null,
    credit: { debt: fmtUsd(debt), limit: role === "worker" ? fmtUsd(limit) : null },
    trustScore: trust,
    verdict,
    reasons,
    recommendation: verdict === "TRUSTED" ? "safe to deal" : verdict === "AVOID" ? "do NOT deal" : "proceed with caution",
  };
}

// --- multi-tenant registry: any dev lists their own HTTP service; we proxy + settle payment directly. ---
/** POST the buyer's input to the seller's URL (timeout + size cap; no internal headers forwarded). */
async function proxyCall(url: string, input: any): Promise<{ ok: boolean; data?: any; error?: string }> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input }), signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return { ok: false, error: `seller returned HTTP ${resp.status}` };
    const text = await resp.text();
    if (text.length > 256_000) return { ok: false, error: "seller response too large" };
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: true, data: text };
    }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 120) };
  }
}
/** The warranty check: did the seller deliver what it promised? Empty/garbage output that comes back with a
 *  200 is NOT a valid delivery — the buyer must not be charged for it. If the seller declared `requires`
 *  (top-level fields it promises to return), every one must be present and non-null; otherwise we just
 *  require a non-empty response. Objective + automatable, so "never charged for junk" needs no human. */
function validateDelivery(data: any, requires?: string[]): { ok: boolean; reason?: string } {
  const isEmpty =
    data == null ||
    (typeof data === "string" && data.trim() === "") ||
    (typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 0);
  if (isEmpty) return { ok: false, reason: "empty response" };
  if (requires && requires.length) {
    if (typeof data !== "object" || Array.isArray(data)) return { ok: false, reason: `expected an object with fields: ${requires.join(", ")}` };
    const missing = requires.filter((k) => data[k] === undefined || data[k] === null || data[k] === "");
    if (missing.length) return { ok: false, reason: `missing promised field(s): ${missing.join(", ")}` };
  }
  return { ok: true };
}

/** Trust for a registered service from its real ledger (success rate, volume, age) + on-chain bonded stake.
 *  The bond is the moat: staked USDC is skin in the game a plain rating can't fake, and it lifts an
 *  otherwise-unproven service above neutral because a bad actor would lose that money to a slash. */
function registeredTrust(s: RegisteredService, bondUnits: bigint = 0n): { trustScore: number; verdict: string; bonded: boolean } {
  const bondedUsd = Number(fmtUsd(bondUnits));
  const bondBoost = Math.min(bondedUsd, 50) * 0.5; // up to +25 for $50+ staked behind the service
  let t: number;
  if (s.calls === 0) {
    t = 50 + bondBoost; // unproven: real stake substitutes for a track record
  } else {
    const successRate = (s.calls - s.failures) / s.calls;
    const ageDays = (Date.now() - new Date(s.createdAt).getTime()) / 86_400_000;
    t = 40 + successRate * 40 + Math.min(s.calls, 100) * 0.15 + Math.min(ageDays, 20) + bondBoost;
  }
  t = Math.max(0, Math.min(100, Math.round(t)));
  return { trustScore: t, verdict: t >= 75 ? "TRUSTED" : t >= 40 ? "NEUTRAL" : t >= 15 ? "RISKY" : "AVOID", bonded: bondedUsd > 0 };
}
/** Public (buyer-facing) view of a registered service, including its live on-chain bond. */
function publicService(s: RegisteredService, bondUnits: bigint = 0n) {
  const slashed = BigInt(s.slashedUnits ?? "0");
  return {
    id: s.id,
    kind: "registered" as const,
    name: s.name,
    priceUsdc: fmtUsd(BigInt(s.priceUnits)),
    priceUnits: s.priceUnits,
    desc: s.desc,
    example: s.exampleInput,
    payTo: s.payTo,
    requires: s.requires ?? [], // fields the seller promises to return (warranty contract)
    warranted: true, // every marketplace call is covered: never charged for junk + insured
    bondUsdc: fmtUsd(bondUnits), // real USDC the seller has staked behind this service
    stats: {
      calls: s.calls,
      failures: s.failures,
      revenueUsdc: fmtUsd(BigInt(s.revenueUnits)),
      slashedUsdc: fmtUsd(slashed),
      successRate: s.calls ? +(((s.calls - s.failures) / s.calls) * 100).toFixed(1) : null,
    },
    ...registeredTrust(s, bondUnits),
  };
}

interface Tab {
  id: string;
  wallet: Wallet;
  cap: bigint;
  spent: bigint;
  items: { service: string; priceUsdc: string; priceUnits: string; tx: string; at: string }[];
  createdAt: string;
}

interface Claim {
  id: string;
  tabId: string;
  buyer: `0x${string}`; // refunded here (the tab's wallet)
  service: string;
  seller: `0x${string}`;
  amount: bigint;
  tx: string; // the original payment being disputed
  reason: string;
  status: "open" | "paid" | "rejected";
  createdAt: string;
  resolvedAt?: string;
  payoutTx?: string;
}

/** Mount the public pay-per-use gateway at /x402 on the given Express app. */
export function mountGateway(app: Express, eco: Economy, society: Society): void {
  const services = makeServices();
  const producer = society.byRole("producer")[0];
  const payTo = producer.address; // the API vendor (a real agent that earns the fees)
  const faucet = society.faucet;
  const canMintDemo = SETTLEMENT_MODE !== "arc"; // MockUSDC.mint + free gas exist only on the local chain
  const consumed = new Set<string>(); // per-tx replay protection for the raw x402 path
  const tabs = new Map<string, Tab>();
  const claims = new Map<string, Claim>(); // buyer-protection disputes (paid out of the insurance pool)

  // When a bonded service turns out to be genuinely bad — ≥50% of its calls fail over a meaningful sample —
  // the gateway slashes a penalty from its on-chain stake to the treasury. The failure gate (≥4 calls) means a
  // single transient blip never slashes; a service that's actually broken bleeds until the seller fixes or
  // unbonds it. The buyer is never charged for a failure regardless — this just gives the bond real teeth.
  async function maybeSlashBadService(svc: RegisteredService, price: bigint) {
    try {
      const fresh = store.getService(svc.id);
      if (!fresh || fresh.calls < 4) return null;
      if (fresh.failures / fresh.calls < 0.5) return null;
      const bond = await A.serviceBondOf(fresh.payTo).catch(() => 0n);
      if (bond <= 0n) return null;
      const penalty = price * 100n < bond ? price * 100n : bond; // 100× the call price, capped at the stake
      if (penalty <= 0n) return null;
      await A.serviceBondSlash(faucet, fresh.payTo, penalty, `${fresh.failures}/${fresh.calls} calls failed`);
      store.recordSlash(fresh.id, penalty);
      console.log(`⚔️  slashed ${fmtUsd(penalty)} USDC from failing service ${fresh.id} (${fresh.failures}/${fresh.calls} failed)`);
      return { slashedUsdc: fmtUsd(penalty), bondRemainingUsdc: fmtUsd(bond - penalty), reason: `${fresh.failures}/${fresh.calls} calls failed` };
    } catch (e) {
      console.error("service slash skipped:", (e as Error)?.message);
      return null;
    }
  }

  const r = express.Router();

  // --- discovery: built-in + registered third-party services (each with a trust verdict + live bond) ---
  r.get("/services", async (_req, res) => {
    const registered = store.listServices();
    const bonds = await Promise.all(registered.map((s) => A.serviceBondOf(s.payTo).catch(() => 0n)));
    const totalBonded = bonds.reduce((a, b) => a + b, 0n);
    const [totalSlashed, insurancePool, insurancePaid] = await Promise.all([
      A.serviceBondTotalSlashed().catch(() => 0n),
      A.insuranceAvailable().catch(() => 0n),
      A.insuranceTotalPaidOut().catch(() => 0n),
    ]);
    res.json({
      payTo,
      token: dep().usdc,
      chainId: activeChain.id,
      settlement: SETTLEMENT_MODE,
      demoTabsEnabled: canMintDemo,
      serviceBond: dep().serviceBond, // stake here to bond your service (skin in the game)
      insurancePoolContract: dep().insurancePool,
      marketplace: {
        bondedServices: bonds.filter((b) => b > 0n).length,
        totalBondedUsdc: fmtUsd(totalBonded), // real USDC staked across the marketplace
        totalSlashedUsdc: fmtUsd(totalSlashed), // real USDC seized from bad services
      },
      insurance: {
        poolUsdc: fmtUsd(insurancePool), // the buyer-protection fund (financed by slashed bad actors)
        paidOutUsdc: fmtUsd(insurancePaid), // real refunds already made to wronged buyers
      },
      services: [
        ...Object.values(services).map((s) => ({
          id: s.id,
          kind: "builtin" as const,
          priceUsdc: fmtUsd(s.price),
          priceUnits: s.price.toString(),
          desc: s.desc,
          example: s.example,
          bonded: true, // house services are backed by the Agora operator
          trustScore: 90,
          verdict: "TRUSTED",
        })),
        ...registered.map((s, i) => publicService(s, bonds[i])),
      ],
    });
  });

  // --- SELLER DOOR: any dev lists their own HTTP service. Paid DIRECTLY on-chain per successful call. ---
  r.post("/services/register", rateLimit(10), (req, res) => {
    const b = req.body || {};
    const name = String(b.name ?? "").trim();
    const url = String(b.url ?? "").trim();
    const desc = String(b.desc ?? "").trim();
    const payTo = String(b.payTo ?? "").trim();
    const priceNum = Number(b.priceUsdc);
    if (!name || name.length > 60) return res.status(400).json({ error: "name required (<= 60 chars)" });
    if (!/^https?:\/\/.{3,}/.test(url)) return res.status(400).json({ error: "url must be a valid http(s) endpoint that accepts POST { input }" });
    if (!(priceNum > 0) || priceNum > 1) return res.status(400).json({ error: "priceUsdc must be in (0, 1]" });
    if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) return res.status(400).json({ error: "payTo must be a 0x wallet address (you get paid here)" });
    const requires = Array.isArray(b.requires) ? b.requires.map((k: any) => String(k)).filter((k: string) => k && k.length <= 40).slice(0, 12) : undefined;
    const id = "svc_" + keccak256(toHex(`${url}|${name}|${payTo}`)).slice(2, 12);
    const svc = store.registerService({
      id,
      name,
      url,
      priceUnits: usd(priceNum).toString(),
      desc: desc.slice(0, 200),
      payTo: payTo as `0x${string}`,
      exampleInput: b.exampleInput ?? {},
      createdAt: new Date().toISOString(),
      calls: 0,
      failures: 0,
      revenueUnits: "0",
      requires,
    });
    res.json({
      ok: true,
      service: publicService(svc),
      callWith: `POST /x402/tab/<tabId>/call  { "service": "${id}", "input": ... }`,
      bondWith: { contract: dep().serviceBond, method: "bond(uint256 usdcUnits) — approve first, from payTo", why: "stake USDC to earn a BONDED badge + trust boost; a service that repeatedly fails gets slashed" },
      note: "You're paid directly on-chain to payTo on every SUCCESSFUL call — no custody, no withdrawal. Buyers aren't charged if your endpoint fails. Bond USDC to stand out as trustworthy.",
    });
  });

  // service detail (built-in or registered) + trust + live on-chain bond
  r.get("/services/:id", async (req, res) => {
    const reg = store.getService(req.params.id);
    if (reg) {
      const bond = await A.serviceBondOf(reg.payTo).catch(() => 0n);
      return res.json(publicService(reg, bond));
    }
    const b = services[req.params.id];
    if (b) return res.json({ id: b.id, kind: "builtin", priceUsdc: fmtUsd(b.price), desc: b.desc, example: b.example, bonded: true, trustScore: 90, verdict: "TRUSTED" });
    return res.status(404).json({ error: "unknown service" });
  });

  // --- Tabs: open a capped, pre-funded spending channel (demo credit on the local chain) ---
  r.post("/tab", rateLimit(15), async (req, res) => {
    if (!canMintDemo)
      return res.status(400).json({ error: "demo tabs run only on the local chain; on Arc, fund your own wallet at https://faucet.circle.com and use the raw x402 flow" });
    const capUsdc = req.body?.capUsdc != null ? Number(req.body.capUsdc) : 0.1;
    if (!(capUsdc > 0) || capUsdc > 5) return res.status(400).json({ error: "capUsdc must be a number in (0, 5]" });
    const cap = usd(capUsdc);
    try {
      const wallet = walletFor(generatePrivateKey());
      const addr = wallet.account.address;
      // fund the tab: demo USDC credit + a little gas (local ETH) so it can send the pay-per-call transfers
      await faucet.sendTransaction({ account: faucet.account, chain: activeChain, to: addr, value: parseEther("1") });
      await usdcMint(faucet, dep().usdc, addr, cap);
      const id = "tab_" + addr.slice(2, 10);
      tabs.set(id, { id, wallet, cap, spent: 0n, items: [], createdAt: new Date().toISOString() });
      res.json({
        tabId: id,
        address: addr,
        capUsdc: fmtUsd(cap),
        spentUsdc: "0",
        remainingUsdc: fmtUsd(cap),
        note: "Demo credit (local test USDC). On Arc this is real USDC you fund yourself.",
      });
    } catch (e) {
      res.status(500).json({ error: "could not open tab: " + String((e as Error)?.message ?? e) });
    }
  });

  // pay-per-call against a tab — works for BOTH built-in and registered (third-party) services.
  // Cap enforced BEFORE paying; the seller is paid on-chain only on a SUCCESSFUL delivery.
  r.post("/tab/:id/call", async (req, res) => {
    const tab = tabs.get(req.params.id);
    if (!tab) return res.status(404).json({ error: "unknown tab" });
    const serviceId = String(req.body?.service ?? "");
    const builtin = services[serviceId];
    const registered = builtin ? undefined : store.getService(serviceId);
    if (!builtin && !registered) return res.status(404).json({ error: "unknown service", builtin: Object.keys(services) });
    const price = builtin ? builtin.price : BigInt(registered!.priceUnits);
    const sellerPayTo = builtin ? payTo : registered!.payTo;
    if (tab.spent + price > tab.cap)
      return res.status(402).json({ error: "tab cap reached — an agent can never overspend its tab", capUsdc: fmtUsd(tab.cap), spentUsdc: fmtUsd(tab.spent) });

    // produce the result FIRST (pay-only-on-success — a failed seller call never charges the buyer)
    let result: any;
    if (builtin) {
      try {
        result = await builtin.run(req.body?.input, eco);
      } catch (e) {
        return res.status(400).json({ error: String((e as Error)?.message ?? e), charged: false });
      }
    } else {
      const proxied = await proxyCall(registered!.url, req.body?.input);
      if (!proxied.ok) {
        store.recordCall(registered!.id, price, false); // a failure dents the seller's trust score
        const sellerSlashed = await maybeSlashBadService(registered!, price); // …and, if it's bonded + truly bad, its stake
        return res.status(502).json({ error: "seller service failed — you were NOT charged: " + proxied.error, charged: false, ...(sellerSlashed ? { sellerSlashed } : {}) });
      }
      // WARRANTY: a 200 carrying empty/garbage output is NOT a valid delivery — never charge for junk.
      const delivered = validateDelivery(proxied.data, registered!.requires);
      if (!delivered.ok) {
        store.recordCall(registered!.id, price, false);
        const sellerSlashed = await maybeSlashBadService(registered!, price);
        return res.status(502).json({ error: `seller delivered invalid output (${delivered.reason}) — you were NOT charged`, charged: false, warranty: "invalid-delivery", ...(sellerSlashed ? { sellerSlashed } : {}) });
      }
      result = proxied.data;
    }

    // pay the provider on-chain (the seller for registered, the house producer for built-ins)
    let tx: string;
    try {
      const rcpt = await usdcTransfer(tab.wallet, dep().usdc, sellerPayTo, price);
      tx = rcpt.transactionHash;
    } catch (e) {
      return res.status(500).json({ error: "payment failed: " + String((e as Error)?.message ?? e) });
    }
    tab.spent += price;
    tab.items.push({ service: serviceId, priceUsdc: fmtUsd(price), priceUnits: price.toString(), tx, at: new Date().toISOString() });
    eco.recordExternalSale(price, serviceId, tab.id);
    store.addExternal(price);
    if (registered) store.recordCall(registered.id, price, true);
    res.json({
      service: serviceId,
      kind: registered ? "registered" : "builtin",
      paidUsdc: fmtUsd(price),
      tx,
      result,
      tab: { capUsdc: fmtUsd(tab.cap), spentUsdc: fmtUsd(tab.spent), remainingUsdc: fmtUsd(tab.cap - tab.spent), calls: tab.items.length },
    });
  });

  // the running bill for a tab (cap / spent / line items)
  r.get("/tab/:id", (req, res) => {
    const tab = tabs.get(req.params.id);
    if (!tab) return res.status(404).json({ error: "unknown tab" });
    res.json({
      tabId: tab.id,
      address: tab.wallet.account.address,
      capUsdc: fmtUsd(tab.cap),
      spentUsdc: fmtUsd(tab.spent),
      remainingUsdc: fmtUsd(tab.cap - tab.spent),
      calls: tab.items.length,
      items: tab.items,
    });
  });

  // --- BUYER PROTECTION: dispute a charged call; if upheld, the buyer is refunded from the insurance pool ---
  // (Auto-guarantee already covers objective junk — you're never charged for empty/invalid output. This
  //  covers the SUBJECTIVE case: the output passed validation but was still wrong. MVP adjudication is
  //  operator-reviewed; staked-juror arbitration is the documented next step.)
  r.post("/claim", rateLimit(20), (req, res) => {
    const tab = tabs.get(String(req.body?.tabId ?? ""));
    if (!tab) return res.status(404).json({ error: "unknown tab" });
    const tx = String(req.body?.tx ?? "");
    const item = tab.items.find((i) => i.tx.toLowerCase() === tx.toLowerCase());
    if (!item) return res.status(404).json({ error: "no charged call with that tx on this tab" });
    if ([...claims.values()].some((c) => c.tx.toLowerCase() === tx.toLowerCase()))
      return res.status(409).json({ error: "a claim already exists for this call" });
    const registered = store.getService(item.service);
    const seller = registered ? registered.payTo : payTo;
    const id = "clm_" + keccak256(toHex(`${tab.id}|${tx}`)).slice(2, 12);
    const claim: Claim = {
      id,
      tabId: tab.id,
      buyer: tab.wallet.account.address,
      service: item.service,
      seller,
      amount: BigInt(item.priceUnits),
      tx,
      reason: String(req.body?.reason ?? "").slice(0, 200) || "buyer disputes the delivery",
      status: "open",
      createdAt: new Date().toISOString(),
    };
    claims.set(id, claim);
    res.json({ ok: true, claim: { id, status: claim.status, amountUsdc: fmtUsd(claim.amount), service: claim.service }, note: "Filed. If upheld, you're refunded from the buyer-protection pool and the seller is slashed." });
  });

  // transparency: list claims
  r.get("/claims", (_req, res) =>
    res.json({
      claims: [...claims.values()].map((c) => ({ id: c.id, service: c.service, amountUsdc: fmtUsd(c.amount), status: c.status, reason: c.reason, createdAt: c.createdAt, resolvedAt: c.resolvedAt, payoutTx: c.payoutTx })),
    })
  );

  // operator resolves a claim → refund from the insurance pool + slash the seller to replenish it
  r.post("/admin/claim/:id/resolve", rateLimit(30), async (req, res) => {
    const claim = claims.get(String(req.params.id));
    if (!claim) return res.status(404).json({ error: "unknown claim" });
    if (claim.status !== "open") return res.status(409).json({ error: `claim already ${claim.status}` });
    if (req.body?.approve === false) {
      claim.status = "rejected";
      claim.resolvedAt = new Date().toISOString();
      return res.json({ ok: true, claim: { id: claim.id, status: claim.status } });
    }
    try {
      // 1) make the buyer whole from the buyer-protection pool
      const rcpt = await A.insurancePayout(faucet, claim.buyer, claim.amount, `claim ${claim.id} on ${claim.service}`);
      // 2) slash the seller to replenish the pool (registered + bonded sellers only) + dent their trust
      if (store.getService(claim.service)) {
        const bond = await A.serviceBondOf(claim.seller).catch(() => 0n);
        if (bond > 0n) {
          const penalty = claim.amount > bond ? bond : claim.amount;
          await A.serviceBondSlash(faucet, claim.seller, penalty, `upheld claim ${claim.id}`).catch(() => {});
          store.recordSlash(claim.service, penalty);
        }
      }
      claim.status = "paid";
      claim.resolvedAt = new Date().toISOString();
      claim.payoutTx = rcpt.transactionHash;
      res.json({ ok: true, claim: { id: claim.id, status: claim.status, refundedUsdc: fmtUsd(claim.amount), payoutTx: claim.payoutTx } });
    } catch (e) {
      res.status(500).json({ error: "payout failed: " + String((e as Error)?.message ?? e) });
    }
  });

  // --- Raw x402 (for external agents with their own funded wallet) ---
  // GET /x402/:service -> 402 Payment Required + terms
  r.get("/:service", async (req, res) => {
    const svc = services[req.params.service];
    if (!svc) return res.status(404).json({ error: "unknown service", services: Object.keys(services) });
    const head = await publicClient.getBlockNumber();
    res.status(402).json({
      error: "payment required",
      terms: {
        service: svc.id,
        priceUsdc: fmtUsd(svc.price),
        priceUnits: svc.price.toString(),
        payTo,
        token: dep().usdc,
        chainId: activeChain.id,
        sinceBlock: head.toString(),
        how: "transfer >= priceUnits USDC to payTo, then POST { payment: <txHash>, input } to this URL",
      },
    });
  });

  // POST /x402/:service { payment: txHash, input } -> verify on-chain, then serve
  r.post("/:service", async (req, res) => {
    const svc = services[req.params.service];
    if (!svc) return res.status(404).json({ error: "unknown service", services: Object.keys(services) });
    const payment = req.body?.payment;
    if (!payment) return res.status(402).json({ error: "payment required: POST { payment: <txHash>, input }" });

    const v = await verifyPayment(String(payment), svc.price, payTo, consumed);
    if (!v.ok) return res.status(402).json({ error: v.reason });

    let result: any;
    try {
      result = await svc.run(req.body?.input, eco);
    } catch (e) {
      return res.status(400).json({ error: String((e as Error)?.message ?? e) });
    }
    eco.recordExternalSale(svc.price, svc.id, "agent:" + String(payment).slice(0, 10));
    store.addExternal(svc.price);
    res.json({ service: svc.id, paidUsdc: fmtUsd(svc.price), result });
  });

  app.use("/x402", r);

  // --- server-rendered, indexable pages (the $0 discovery channel: Google/agent crawlers → live services) ---
  async function resolvePageService(id: string): Promise<PageService | null> {
    const reg = store.getService(id);
    if (reg) {
      const bond = await A.serviceBondOf(reg.payTo).catch(() => 0n);
      return publicService(reg, bond) as PageService;
    }
    const b = services[id];
    if (b) return { id: b.id, kind: "builtin", name: b.id[0].toUpperCase() + b.id.slice(1), desc: b.desc, priceUsdc: fmtUsd(b.price), example: b.example, bonded: true, trustScore: 90, verdict: "TRUSTED" };
    return null;
  }
  app.get("/s/:id", rateLimit(120), async (req, res) => {
    const base = publicBase(req);
    const svc = await resolvePageService(String(req.params.id));
    if (!svc) return res.status(404).type("html").send(renderNotFound(base));
    res.type("html").send(renderServicePage(svc, base));
  });
  app.get("/sitemap.xml", (req, res) => {
    const ids = [...Object.keys(services), ...store.listServices().map((s) => s.id)];
    res.type("application/xml").send(renderSitemap(publicBase(req), ids));
  });
  app.get("/robots.txt", (req, res) => res.type("text/plain").send(renderRobots(publicBase(req))));

  console.log(`• pay-per-use gateway mounted at /x402 (${Object.keys(services).length} services, payTo ${payTo.slice(0, 8)}…); SEO pages at /s/:id + /sitemap.xml`);
}

/** Verify a real on-chain USDC payment: a transfer to payTo of >= price, mined recently, not already used. */
async function verifyPayment(
  txHash: string,
  price: bigint,
  payTo: `0x${string}`,
  consumed: Set<string>
): Promise<{ ok: boolean; reason?: string }> {
  const key = txHash.toLowerCase();
  if (consumed.has(key)) return { ok: false, reason: "payment already used (replay rejected)" };
  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch {
    return { ok: false, reason: "payment tx not found" };
  }
  const head = await publicClient.getBlockNumber();
  if (head - receipt.blockNumber > 500n) return { ok: false, reason: "payment too old — the replay window has closed" };
  let paid = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== dep().usdc.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
      const a = ev.args as { to: `0x${string}`; value: bigint };
      if (a.to.toLowerCase() === payTo.toLowerCase()) paid += a.value;
    } catch {
      /* not a transfer */
    }
  }
  if (paid < price) return { ok: false, reason: `insufficient payment: paid ${paid} units, need ${price}` };
  consumed.add(key);
  return { ok: true };
}
