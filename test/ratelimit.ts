// Unit test for the per-IP rate limiter: the client IP must come from the proxy chain's trusted (right-hand)
// end, so a caller can't dodge limits by sending its own X-Forwarded-For. `npx tsx test/ratelimit.ts`.
import express from "express";
import { rateLimit } from "../dashboard/ratelimit";

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
}
const PORT = 4083;
const hit = (xff?: string) =>
  fetch(`http://127.0.0.1:${PORT}/x`, { headers: xff ? { "x-forwarded-for": xff } : {} }).then((r) => r.status);
// what the live Render chain looks like: <client-supplied…>, <client>, <cloudflare>, <render-lb>
const viaRender = (client: string, spoof = "") => `${spoof ? spoof + ", " : ""}${client}, 104.23.160.251, 10.197.206.233`;

async function main() {
  const app = express();
  app.get("/x", rateLimit(2), (_req, res) => res.json({ ok: true }));
  const server = await new Promise<any>((r) => { const s = app.listen(PORT, () => r(s)); });
  try {
    console.log("\n[rate limit behind Render's proxy chain (3 hops)]");
    process.env.TRUST_PROXY_HOPS = "3";
    const a = [await hit(viaRender("1.1.1.1")), await hit(viaRender("1.1.1.1")), await hit(viaRender("1.1.1.1"))];
    check("the real client is limited after `max` requests", a.join() === "200,200,429", a.join());
    const spoofed = [await hit(viaRender("1.1.1.1", "9.9.9.1")), await hit(viaRender("1.1.1.1", "9.9.9.2, 9.9.9.3"))];
    check("rotating a spoofed X-Forwarded-For does NOT reset the limit", spoofed.every((s) => s === 429), spoofed.join());
    check("a different real client has its own budget", (await hit(viaRender("2.2.2.2"))) === 200);

    console.log("\n[no proxy (local/dev): the header is ignored entirely]");
    process.env.TRUST_PROXY_HOPS = "0";
    const local = [await hit("3.3.3.3"), await hit("4.4.4.4"), await hit("5.5.5.5")];
    check("with no trusted proxy, forged headers can't mint fresh identities", local.join() === "200,200,429", local.join());
  } finally {
    server.close();
  }
  console.log(fails === 0 ? "\n✅ RATE LIMIT PASSED — limits key on the real client IP, not a client-supplied header." : `\n❌ ${fails} RATE LIMIT CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
