// Outbound calls to SELLER-SUPPLIED URLs. Anyone can register a service URL, and the server then POSTs to it and
// relays the response — a textbook SSRF primitive. This module makes that safe:
//   • only public unicast IPs are reachable (no loopback, private, link-local/cloud-metadata, CGNAT, multicast…);
//   • the check runs on the address actually being CONNECTED to (custom DNS lookup), so DNS rebinding — resolve
//     public at registration, private at call time — doesn't get through, and IP-literal hosts are checked too;
//   • redirects are not followed (a public URL can't bounce us to an internal one);
//   • the deadline covers the whole exchange and the body is read with a hard byte cap, so a seller streaming
//     gigabytes (or trickling bytes forever) can't exhaust memory or pin a request.
import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["2001:db8::", 32], ["100::", 64],
] as const) BLOCKED.addSubnet(net, bits, "ipv6");

/** True only for addresses a public seller endpoint could legitimately live on. */
export function isPublicAddress(addr: string): boolean {
  const fam = isIP(addr);
  if (fam === 4) return !BLOCKED.check(addr, "ipv4");
  if (fam === 6) {
    const lower = addr.toLowerCase();
    // IPv4-mapped / NAT64 forms embed an IPv4 address — judge that instead
    const embedded = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (embedded) return isPublicAddress(embedded[1]);
    if (/^(?:::ffff:|64:ff9b::)[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) {
      const [hi, lo] = lower.split(":").slice(-2).map((h) => parseInt(h, 16));
      return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return !BLOCKED.check(addr, "ipv6");
  }
  return false;
}

/** Private targets are allowed only when explicitly opted in (local dev + tests run sellers on localhost). */
const privateAllowed = () => process.env.AGORA_ALLOW_PRIVATE_SELLER_URLS === "1";

/** DNS lookup that refuses to hand the socket any non-public address. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return (callback as any)(err);
    const list = addresses as { address: string; family: number }[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad) return (callback as any)(Object.assign(new Error(`seller host resolves to a non-public address (${bad.address})`), { code: "EBLOCKED" }));
    if ((options as any).all) return (callback as any)(null, list);
    return (callback as any)(null, list[0].address, list[0].family);
  });
};

/** Static checks on a seller URL (scheme, credentials, IP-literal host). Returns an error message or null. */
export function checkSellerUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "url must be a valid http(s) URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "url must use http or https";
  if (u.username || u.password) return "url must not contain credentials";
  if (privateAllowed()) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return "url must point at a public host";
  if (isIP(host) && !isPublicAddress(host)) return "url must point at a public address";
  return null;
}

export interface EgressResult {
  ok: boolean;
  status?: number;
  text?: string;
  error?: string;
}

/** POST JSON to a seller URL under the rules above. `trusted` skips the address guard (our own house services). */
export function sellerPost(url: string, payload: unknown, opts: { timeoutMs?: number; maxBytes?: number; trusted?: boolean } = {}): Promise<EgressResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 256_000;
  const guard = !opts.trusted && !privateAllowed();
  return new Promise((resolve) => {
    const bad = guard ? checkSellerUrl(url) : null;
    if (bad) return resolve({ ok: false, error: bad });
    const u = new URL(url);
    const body = Buffer.from(JSON.stringify(payload));
    const mod = u.protocol === "https:" ? https : http;
    let settled = false;
    const done = (r: EgressResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const req = mod.request(
      u,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": body.length, accept: "application/json" },
        ...(guard ? { lookup: guardedLookup } : {}),
        agent: false, // fresh socket per call — no pooled connection to a previously-resolved address
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.destroy();
          return done({ ok: false, status, error: `seller returned a redirect (HTTP ${status}) — not followed` });
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          return done({ ok: false, status, error: "seller response too large" });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            return done({ ok: false, status, error: "seller response too large" });
          }
          chunks.push(c);
        });
        res.on("end", () => done({ ok: status >= 200 && status < 300, status, text: Buffer.concat(chunks).toString("utf8"), ...(status >= 200 && status < 300 ? {} : { error: `seller returned HTTP ${status}` }) }));
        res.on("error", (e) => done({ ok: false, status, error: e.message.slice(0, 120) }));
      }
    );
    const timer = setTimeout(() => {
      req.destroy();
      done({ ok: false, error: `seller timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);
    req.on("error", (e) => done({ ok: false, error: String(e.message).slice(0, 120) }));
    req.end(body);
  });
}
