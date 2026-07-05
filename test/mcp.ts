// End-to-end test of the Agora MCP server (the agent door): spawn it, connect an MCP client, and drive
// the exact tools an AI agent uses — open a budget, discover, trust-check, pay for a service, read the
// bill — all against a live gateway. Proves any Claude/Cursor agent can transact on Arc. `npm run test:mcp`.
import express from "express";
import { startChain } from "./harness";
import { buildSociety } from "../agents/society";
import { Economy } from "../orchestrator/economy";
import { mountGateway } from "../dashboard/gateway";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
}
const PORT = 4088;
const base = `http://localhost:${PORT}`;
const parse = (res: any) => {
  const t = res?.content?.[0]?.text ?? "{}";
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

async function main() {
  const chain = await startChain();
  let server: any, client: any, transport: any;
  try {
    const society = await buildSociety();
    const eco = new Economy(society);
    for (let i = 0; i < 2; i++) await eco.tick();
    const app = express();
    app.use(express.json());
    app.post("/seller-rev", (req, res) => res.json({ reversed: String(req.body?.input?.text ?? "").split("").reverse().join("") }));
    mountGateway(app, eco, society);
    server = await new Promise<any>((r) => { const s = app.listen(PORT, () => r(s)); });
    // register a third-party service so discovery shows a real seller
    await fetch(`${base}/x402/services/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Reverse", url: `${base}/seller-rev`, priceUsdc: 0.001, desc: "reverses text", payTo: privateKeyToAccount(generatePrivateKey()).address }),
    });

    // spawn the MCP server as a subprocess + connect a client (exactly how Claude/Cursor loads it)
    transport = new StdioClientTransport({ command: "node", args: ["mcp/index.js"], env: { ...process.env, AGORA_URL: base } as Record<string, string> });
    client = new Client({ name: "agora-mcp-test", version: "1.0.0" });
    await client.connect(transport);

    console.log("\n[Agora MCP — the tools an AI agent actually uses]");
    const tools = (await client.listTools()).tools.map((t: any) => t.name);
    check("MCP exposes the agent tools", ["open_tab", "list_services", "check_trust", "call_service", "get_bill"].every((t) => tools.includes(t)), tools.join(", "));

    const tab = parse(await client.callTool({ name: "open_tab", arguments: { capUsdc: 0.05 } }));
    check("open_tab → a budget-capped wallet", !!tab.tabId && !!tab.budgetUsdc, `budget $${tab.budgetUsdc}`);

    const list = parse(await client.callTool({ name: "list_services", arguments: {} }));
    check("list_services → services with trust verdicts", Array.isArray(list.services) && list.services.some((s: any) => s.trust), `${list.services?.length} services`);

    const trust = parse(await client.callTool({ name: "check_trust", arguments: { target: "price" } }));
    check("check_trust → a verdict before paying", !!trust.verdict, `price: ${trust.verdict}`);

    const call = parse(await client.callTool({ name: "call_service", arguments: { service: "compute", input: { op: "sum", nums: [10, 20, 12] } } }));
    check("call_service → pays + returns a result on Arc rails", call.result?.result === 42 && !!call.paidUsdc, `result=${call.result?.result}, paid $${call.paidUsdc}, left $${call.remainingBudgetUsdc}`);

    const bill = parse(await client.callTool({ name: "get_bill", arguments: {} }));
    check("get_bill → the agent's spending", Number(bill.calls) >= 1, `calls=${bill.calls}, spent $${bill.spentUsdc}`);
  } finally {
    try { await client?.close(); } catch {}
    if (server) server.close();
    chain.stop();
  }
  console.log(
    fails === 0
      ? "\n✅ MCP E2E PASSED — any AI agent can open a budget, discover, trust-check, and pay for services on Arc."
      : `\n❌ ${fails} MCP CHECK(S) FAILED`
  );
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
