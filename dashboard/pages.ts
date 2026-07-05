// Server-rendered, indexable pages for the marketplace — the $0 discovery channel.
// Each listed service gets a real crawlable page at /s/:id with unique <title>/<meta>/OpenGraph + schema.org
// JSON-LD, so search engines and agent crawlers can find "pay-per-use <thing> on Arc" and land on a live,
// buyable service. (The dashboard SPA is client-rendered; these pages are full HTML in the response body.)

const BRAND_CSS = `
  :root{--paper:#FAFAF7;--card:#fff;--ink:#0A0A0A;--ink2:#1D1D1F;--label:#6B7280;--mute:#9CA3AF;--line:#E5E7EB;--green:#059669;--green2:#10B981;--rust:#C2410C;--mono:'JetBrains Mono',ui-monospace,Menlo,monospace;--disp:'Space Grotesk',-apple-system,'Segoe UI',sans-serif}
  *{box-sizing:border-box;margin:0;padding:0}body{background:var(--paper);color:var(--ink);font-family:var(--disp);line-height:1.55}
  a{color:var(--green);text-decoration:none}a:hover{text-decoration:underline}
  .lab{font-family:var(--mono);font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--label)}
  .wrap{max-width:760px;margin:0 auto;padding:40px 30px 72px}
  header{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
  .brand{display:flex;align-items:center;gap:12px}.word{font-size:21px;font-weight:700;letter-spacing:-.04em}.word .dot{color:var(--green)}
  .pill{font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;border:1px solid var(--line);border-radius:7px;padding:8px 12px;color:var(--ink2);background:var(--card)}
  h1{font-size:clamp(26px,5vw,38px);font-weight:700;letter-spacing:-.035em;line-height:1.08;margin:26px 0 6px}
  .price{font-family:var(--mono);font-size:17px;font-weight:600;color:var(--green)}
  .desc{font-size:16px;color:var(--ink2);margin:14px 0}
  .meta{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}
  .badge{font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;border:1px solid var(--line);border-radius:5px;padding:4px 8px;color:var(--label)}
  .badge.TRUSTED{color:var(--green);border-color:#B8E6D2}.badge.RISKY,.badge.AVOID{color:var(--rust);border-color:#E7C3AE}
  .badge.BONDED{color:var(--green);border-color:#B8E6D2;background:#F0FBF6;font-weight:600}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-top:18px}
  .row{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid #F1F1EC;font-size:14px}
  .row:last-child{border-bottom:0}.row .k{color:var(--label)}.row .v{font-family:var(--mono);color:var(--ink2);text-align:right;word-break:break-all}
  pre{font-family:var(--mono);font-size:12.5px;background:#161616;color:#E7E7E1;border-radius:10px;padding:16px;margin-top:14px;overflow-x:auto;white-space:pre-wrap;word-break:break-word}
  .cta{display:inline-block;margin-top:20px;background:var(--ink);color:var(--paper);border-radius:9px;padding:12px 18px;font-weight:600;font-size:14px}.cta:hover{text-decoration:none;opacity:.92}
  .foot{margin-top:34px}
  @media(max-width:560px){.wrap{padding:28px 20px}}
`;

const LOGO = `<svg width="24" height="24" viewBox="0 0 30 30" fill="none"><path d="M2.2 9V2.2H9M21 2.2H27.8V9M27.8 21V27.8H21M9 27.8H2.2V21" stroke="#0A0A0A" stroke-width="2.3"/><rect x="8.4" y="16.2" width="5.4" height="5.4" fill="#059669"/></svg>`;
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 30 30'%3E%3Cpath d='M2.2 9V2.2H9M21 2.2H27.8V9M27.8 21V27.8H21M9 27.8H2.2V21' stroke='%230A0A0A' stroke-width='2.3' fill='none'/%3E%3Crect x='8.4' y='16.2' width='5.4' height='5.4' fill='%23059669'/%3E%3C/svg%3E";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** A buyer/crawler-facing service record (shape produced by the gateway's publicService / builtin view). */
export interface PageService {
  id: string;
  kind: string;
  name?: string;
  desc?: string;
  priceUsdc: string;
  example?: any;
  payTo?: string;
  bonded?: boolean;
  bondUsdc?: string;
  trustScore?: number;
  verdict?: string;
  stats?: { calls: number; failures: number; revenueUsdc: string; slashedUsdc?: string; successRate: number | null };
}

function page(head: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="${FAVICON}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
${head}<style>${BRAND_CSS}</style></head><body><div class="wrap">
<header><a class="brand" href="/">${LOGO}<span class="word">agora<span class="dot">.</span></span></a>
<a class="pill" href="/registry">All services →</a></header>
${body}
<div class="foot lab">Agents plug in via MCP: <span style="color:var(--ink2)">npx agora-pay-mcp</span> · <a href="/registry">marketplace</a> · <a href="https://github.com/Ritik200238/agora">source</a></div>
</div></body></html>`;
}

/** Full, crawlable HTML for one service. `base` is the public origin (for canonical + OG URLs). */
export function renderServicePage(s: PageService, base: string): string {
  const price = `$${(+s.priceUsdc).toFixed(+s.priceUsdc < 0.01 ? 6 : 2)}`;
  const url = `${base}/s/${encodeURIComponent(s.id)}`;
  const name = s.name || s.id;
  const title = `${name} — pay-per-use on Arc (${price}/call) · Agora`;
  const metaDesc = (s.desc ? s.desc + " " : "") + `Pay ${price} per call in USDC on Arc — no subscription, no account. ${s.bonded ? "On-chain bonded. " : ""}Trust verdict: ${s.verdict || "—"}.`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Service",
    name,
    description: s.desc || metaDesc,
    url,
    provider: { "@type": "Organization", name: "Agora", url: base },
    offers: { "@type": "Offer", price: s.priceUsdc, priceCurrency: "USDC", url, availability: "https://schema.org/InStock" },
    ...(s.stats?.calls != null ? { interactionStatistic: { "@type": "InteractionCounter", interactionType: "https://schema.org/UseAction", userInteractionCount: s.stats.calls } } : {}),
  };
  const head = `<title>${esc(title)}</title>
<meta name="description" content="${esc(metaDesc)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(metaDesc)}"><meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(metaDesc)}">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;

  const rows: string[] = [
    `<div class="row"><span class="k">Price per call</span><span class="v" style="color:var(--green)">${esc(price)} USDC</span></div>`,
    `<div class="row"><span class="k">Type</span><span class="v">${esc(s.kind)}</span></div>`,
  ];
  if (s.payTo) rows.push(`<div class="row"><span class="k">Paid to</span><span class="v">${esc(s.payTo)}</span></div>`);
  if (s.bonded) rows.push(`<div class="row"><span class="k">Bonded stake</span><span class="v" style="color:var(--green)">${s.bondUsdc != null && +s.bondUsdc > 0 ? "$" + esc(s.bondUsdc) : "backed by operator"}</span></div>`);
  if (s.stats?.calls != null) rows.push(`<div class="row"><span class="k">Usage</span><span class="v">${s.stats.calls} calls${s.stats.successRate != null ? ` · ${s.stats.successRate}% ok` : ""}</span></div>`);
  if (s.stats && +(s.stats.slashedUsdc || 0) > 0) rows.push(`<div class="row"><span class="k">Slashed</span><span class="v" style="color:var(--rust)">$${esc(s.stats.slashedUsdc)}</span></div>`);

  const example = s.example && Object.keys(s.example).length ? s.example : { input: "…" };
  const body = `
<div class="meta"><span class="badge">${esc(s.kind)}</span>
<span class="badge ${esc(s.verdict || "")}">${esc(s.verdict || "—")}${s.trustScore != null ? " · " + s.trustScore : ""}</span>
${s.bonded ? `<span class="badge BONDED">◆ bonded${s.bondUsdc != null && +s.bondUsdc > 0 ? " $" + esc(s.bondUsdc) : ""}</span>` : ""}</div>
<h1>${esc(name)}</h1>
<div class="price">${esc(price)} <span class="lab" style="color:var(--mute)">per call · USDC on Arc</span></div>
<p class="desc">${esc(s.desc || "A pay-per-use service on the Agora marketplace.")}</p>
<div class="card">${rows.join("")}</div>
<p class="lab" style="margin-top:22px">Call it from any agent</p>
<pre>// 1. give your agent a wallet (one line)
npx agora-pay-mcp

// 2. or pay directly over x402
POST /x402/tab/&lt;tabId&gt;/call
${esc(JSON.stringify({ service: s.id, input: example }, null, 2))}</pre>
<a class="cta" href="/registry">Browse the marketplace →</a>`;
  return page(head, body);
}

/** A branded 404 for an unknown service id. */
export function renderNotFound(base: string): string {
  return page(
    `<title>Service not found · Agora</title><meta name="robots" content="noindex">`,
    `<h1>No such service</h1><p class="desc">This service id isn't listed on the marketplace.</p><a class="cta" href="/registry">Browse live services →</a>`
  );
}

/** robots.txt pointing crawlers at the sitemap. */
export function renderRobots(base: string): string {
  return `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`;
}

/** sitemap.xml of the static pages + every listed service. */
export function renderSitemap(base: string, serviceIds: string[]): string {
  const urls = ["/", "/registry", "/pay", ...serviceIds.map((id) => `/s/${encodeURIComponent(id)}`)];
  const body = urls
    .map((u) => `  <url><loc>${esc(base + u)}</loc><changefreq>${u.startsWith("/s/") ? "daily" : "weekly"}</changefreq></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

/** Resolve the public origin for canonical/OG links: explicit env, else the request host. */
export function publicBase(req: { protocol: string; get: (h: string) => string | undefined }): string {
  if (process.env.AGORA_PUBLIC_URL) return process.env.AGORA_PUBLIC_URL.replace(/\/$/, "");
  const host = req.get("host") || "localhost";
  const proto = /localhost|127\.0\.0\.1/.test(host) ? "http" : "https";
  return `${proto}://${host}`;
}
