// Unit test for seller egress (SSRF guard): the server must never be steerable into internal addresses, must not
// follow redirects, and must cap slow/huge responses. Runs offline against local servers. `npx tsx test/egress.ts`.
import http from "node:http";
import { isPublicAddress, checkSellerUrl, sellerPost } from "../dashboard/egress";

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
}
const PORT = 4085;
const local = `http://127.0.0.1:${PORT}`;

async function main() {
  delete process.env.AGORA_ALLOW_PRIVATE_SELLER_URLS; // production behaviour
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") return res.end(JSON.stringify({ ok: true }));
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      return res.end();
    }
    if (req.url === "/huge") {
      res.writeHead(200); // no content-length: must be cut off while streaming
      const chunk = Buffer.alloc(64 * 1024, 97);
      let sent = 0;
      const pump = () => {
        while (sent < 4 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return res.once("drain", pump);
        }
        res.end();
      };
      res.on("error", () => {});
      return pump();
    }
    if (req.url === "/slow") {
      res.writeHead(200); // headers arrive fast, body trickles — the deadline must still fire
      const t = setInterval(() => res.write(" "), 200);
      res.on("close", () => clearInterval(t));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
  try {
    console.log("\n[address classification]");
    const internal = ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe"];
    const external = ["8.8.8.8", "1.1.1.1", "104.23.160.251", "2606:4700:4700::1111"];
    check("internal/metadata/mapped addresses are all non-public", internal.every((a) => !isPublicAddress(a)), internal.filter(isPublicAddress).join(",") || "none leaked");
    check("ordinary public addresses are allowed", external.every(isPublicAddress));

    console.log("\n[registration-time URL checks]");
    const refused = ["http://127.0.0.1:4000/x", "http://localhost/x", "http://169.254.169.254/latest", "http://[::1]/x", "http://[::ffff:127.0.0.1]/x", "ftp://example.com/x", "http://user:pw@example.com/x", "http://metadata.google.internal/x"];
    check("internal, non-http and credentialed URLs are refused", refused.every((u) => checkSellerUrl(u) !== null), refused.filter((u) => checkSellerUrl(u) === null).join(",") || "all refused");
    check("a normal public https URL is accepted", checkSellerUrl("https://api.example.com/v1/run") === null);

    console.log("\n[call-time enforcement]");
    const direct = await sellerPost(`${local}/ok`, {});
    check("calling a loopback seller is blocked", !direct.ok && /public/.test(direct.error ?? ""), direct.error);
    const rebound = await sellerPost(`http://localhost.:${PORT}/ok`, {}); // slips past the static name check; DNS → 127.0.0.1
    check("a hostname that RESOLVES to loopback is blocked at connect time", !rebound.ok && /non-public/.test(rebound.error ?? ""), rebound.error);
    const house = await sellerPost(`${local}/ok`, {}, { trusted: true });
    check("our own trusted house service on loopback still works", house.ok && house.text === '{"ok":true}');

    console.log("\n[response handling]");
    const redir = await sellerPost(`${local}/redirect`, {}, { trusted: true });
    check("redirects are not followed", !redir.ok && redir.status === 302 && /not followed/.test(redir.error ?? ""), redir.error);
    const huge = await sellerPost(`${local}/huge`, {}, { trusted: true });
    check("a streamed oversize body is cut off at the cap", !huge.ok && /too large/.test(huge.error ?? ""), huge.error);
    const t0 = Date.now();
    const slow = await sellerPost(`${local}/slow`, {}, { trusted: true, timeoutMs: 1000 });
    check("a trickling body hits the overall deadline", !slow.ok && /timed out/.test(slow.error ?? "") && Date.now() - t0 < 3000, `${slow.error} after ${Date.now() - t0}ms`);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
  console.log(fails === 0 ? "\n✅ EGRESS PASSED — seller URLs can't reach internal addresses, redirect, or exhaust the server." : `\n❌ ${fails} EGRESS CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
