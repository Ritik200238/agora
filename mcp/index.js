#!/usr/bin/env node
// agora-pay MCP server — gives ANY AI agent (Claude, Cursor, Codex, custom) a budget-capped wallet and a
// trust-checked, pay-per-use marketplace on Arc, in one config line. The agent decides what's worth paying
// for; the tab enforces a hard budget it can never exceed; every call settles in USDC on Arc.
//
// Config (Claude Desktop / Cursor / Claude Code):
//   { "mcpServers": { "agora-pay": { "command": "npx", "args": ["-y", "agora-pay-mcp"] } } }
// Point it at any Agora gateway with AGORA_URL (defaults to the hosted demo).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const AGORA_URL = (process.env.AGORA_URL || "https://agora-j52a.onrender.com").replace(/\/$/, "");
let activeTab = null;

async function api(method, path, body) {
  const r = await fetch(AGORA_URL + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let data;
  try {
    data = JSON.parse(txt);
  } catch {
    data = txt;
  }
  return { status: r.status, data };
}
const out = (o) => ({ content: [{ type: "text", text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

const server = new McpServer({ name: "agora-pay", version: "0.1.0" });

server.tool(
  "open_tab",
  "Open a budget-capped wallet (a 'tab') on Agora so you can pay per-call for services on Arc in USDC. The cap is a HARD limit — you can never spend more than capUsdc total. Do this first, before calling services.",
  { capUsdc: z.number().describe("total budget in USDC for this tab (0.001–5), e.g. 0.05") },
  async ({ capUsdc }) => {
    const { status, data } = await api("POST", "/x402/tab", { capUsdc });
    if (status !== 200) return out({ error: data?.error || data });
    activeTab = data.tabId;
    return out({ tabId: data.tabId, budgetUsdc: data.capUsdc, note: "Hard spending cap. Every call settles in USDC on Arc." });
  }
);

server.tool(
  "list_services",
  "Discover services you can pay for on Agora. Each has a price and a TRUST verdict (TRUSTED / NEUTRAL / RISKY / AVOID) from its on-chain track record. Before paying, weigh price vs. value for your task, and prefer TRUSTED services — avoid RISKY/AVOID unless the user insists.",
  {},
  async () => {
    const { data } = await api("GET", "/x402/services");
    const services = (data.services || []).map((s) => ({
      id: s.id,
      kind: s.kind,
      priceUsdc: s.priceUsdc,
      trust: s.verdict,
      desc: s.desc || s.name,
      example: s.example,
    }));
    return out({ services, settlement: data.settlement, tip: "Only pay when the result is worth the price for your task." });
  }
);

server.tool(
  "check_trust",
  "Get the on-chain trust profile + verdict for a service BEFORE you pay it: price, success rate, and a TRUSTED/AVOID verdict. Use this when unsure about a service.",
  { target: z.string().describe("a service id (e.g. svc_… or a built-in like 'price')") },
  async ({ target }) => {
    const { status, data } = await api("GET", "/x402/services/" + encodeURIComponent(target));
    if (status !== 200) return out({ error: "no trust record for '" + target + "'" });
    return out(data);
  }
);

server.tool(
  "call_service",
  "Pay for and call a service. The price is deducted from your tab (never exceeding the cap), and you are only charged if the service actually delivers. Returns the result, what you paid, the on-chain tx, and your remaining budget.",
  {
    service: z.string().describe("the service id to call"),
    input: z.record(z.string(), z.any()).optional().describe("the input object the service expects, e.g. { asset: 'bitcoin' }"),
    tabId: z.string().optional().describe("tab to pay from; defaults to your open tab"),
  },
  async ({ service, input, tabId }) => {
    const tab = tabId || activeTab;
    if (!tab) return out({ error: "open a tab first with open_tab" });
    const { status, data } = await api("POST", `/x402/tab/${tab}/call`, { service, input: input || {} });
    if (status !== 200) return out({ error: data?.error || data, charged: data?.charged });
    return out({ result: data.result, paidUsdc: data.paidUsdc, tx: data.tx, remainingBudgetUsdc: data.tab?.remainingUsdc });
  }
);

server.tool(
  "get_bill",
  "See your tab's spending so far: budget, spent, remaining, and each call you made.",
  { tabId: z.string().optional().describe("defaults to your open tab") },
  async ({ tabId }) => {
    const tab = tabId || activeTab;
    if (!tab) return out({ error: "no open tab — call open_tab first" });
    const { data } = await api("GET", "/x402/tab/" + tab);
    return out(data);
  }
);

await server.connect(new StdioServerTransport());
console.error(`agora-pay MCP server running · gateway ${AGORA_URL}`);
