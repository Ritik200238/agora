import type { Request, Response, NextFunction } from "express";

/** Tiny in-memory per-IP rate limiter (no deps) — protects the public gateway + admin endpoints from
 *  abuse/DoS on a public deploy. `max` requests per `windowMs` per client IP; over that → 429. */
export function rateLimit(max: number, windowMs = 60_000) {
  const hits = new Map<string, { n: number; t: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const fwd = (req.headers["x-forwarded-for"] as string) || "";
    const ip = fwd.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    if (hits.size > 5000) hits.clear(); // bound memory on a long-running deploy
    const h = hits.get(ip);
    if (!h || now - h.t > windowMs) {
      hits.set(ip, { n: 1, t: now });
      return next();
    }
    if (h.n >= max) {
      res.set("Retry-After", String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: "rate limit exceeded — slow down" });
    }
    h.n++;
    return next();
  };
}
