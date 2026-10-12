import type { Request, Response, NextFunction } from "express";

/** How many proxies we sit behind. Each proxy APPENDS the address it saw to X-Forwarded-For, and a client can
 *  PREPEND anything it likes — so only the right-hand entries are trustworthy, and the real client is the one
 *  `hops` from the right. Measured on the live Render deploy (via /api/whoami with a spoofed header):
 *  `<spoofed…>, <client>, <cloudflare>, <render-lb>` arriving over loopback → 3 hops. Override with
 *  TRUST_PROXY_HOPS; with no proxy (local/dev/tests) we use the socket address and ignore the header. */
function proxyHops(): number {
  const env = process.env.TRUST_PROXY_HOPS;
  if (env != null && env !== "" && Number.isInteger(+env) && +env >= 0) return +env;
  return process.env.RENDER ? 3 : 0;
}

/** The caller's real IP — never the client-controlled left end of X-Forwarded-For. */
export function clientIp(req: Request): string {
  const hops = proxyHops();
  if (hops > 0) {
    const chain = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (chain.length >= hops) return chain[chain.length - hops];
  }
  return req.socket.remoteAddress || "unknown";
}

const MAX_TRACKED = 5000;

/** Tiny in-memory per-IP rate limiter (no deps) — protects the public gateway + admin endpoints from
 *  abuse/DoS on a public deploy. `max` requests per `windowMs` per client IP; over that → 429. */
export function rateLimit(max: number, windowMs = 60_000) {
  const hits = new Map<string, { n: number; t: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = clientIp(req);
    const now = Date.now();
    if (hits.size >= MAX_TRACKED) {
      // bound memory without wiping live counters (a full clear would let a flood of fresh IPs reset everyone):
      // drop expired windows first, then the oldest entries (Map iterates in insertion order)
      for (const [k, h] of hits) if (now - h.t > windowMs) hits.delete(k);
      for (const k of hits.keys()) {
        if (hits.size < MAX_TRACKED) break;
        hits.delete(k);
      }
    }
    const h = hits.get(ip);
    if (!h || now - h.t > windowMs) {
      hits.delete(ip); // re-insert so insertion order tracks window start
      hits.set(ip, { n: 1, t: now });
      return next();
    }
    if (h.n >= max) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((windowMs - (now - h.t)) / 1000))));
      return res.status(429).json({ error: "rate limit exceeded — slow down" });
    }
    h.n++;
    return next();
  };
}
