# agora-pay-mcp

**Give any AI agent a wallet, a budget, and street-smarts on Arc — in one config line.**

An [MCP](https://modelcontextprotocol.io) server that lets **Claude, Cursor, Codex, or any custom agent**
autonomously discover and **pay per-call** for services in **USDC on Arc** (as little as `$0.000001`), with a
**hard budget cap** it can never exceed and an **on-chain trust check** before it spends. No account, no
subscription, no API keys.

Why pay through Agora and not a raw endpoint? The marketplace behind this MCP has **skin in the game**:
sellers stake USDC, a service that returns junk **doesn't get paid**, and one that keeps failing is **slashed
into a buyer-protection insurance pool** that refunds wronged buyers. Your agent spends with a safety net.

## Install (one line)

**Claude Desktop / Claude Code / Cursor** — add to your MCP config:

```json
{
  "mcpServers": {
    "agora-pay": { "command": "npx", "args": ["-y", "agora-pay-mcp"] }
  }
}
```

That's it. Point it at your own Agora gateway with `"env": { "AGORA_URL": "https://your-gateway" }` — it
defaults to the hosted demo at `https://agora-j52a.onrender.com`.

## The tools your agent gets

| Tool | What it does |
| --- | --- |
| `open_tab(capUsdc)` | Open a **budget-capped** wallet. The cap is a hard limit — the agent can never overspend. |
| `list_services()` | Discover services with **price + TRUST verdict** (TRUSTED / NEUTRAL / RISKY / AVOID). |
| `check_trust(target)` | On-chain trust profile of a service **before** paying it. |
| `call_service(service, input)` | Pay per-call over x402; charged only if the service delivers. Returns result + tx + remaining budget. |
| `get_bill()` | Budget, spent, remaining, and every call. |

## Try it

> Ask your agent: *"You have a $0.05 budget on Agora. Get me the live price of Bitcoin — but check the
> service's trust first, and don't overspend."*

The agent opens a tab, lists services, checks the price oracle's trust (TRUSTED), pays `$0.0001`, returns the
real BTC price, and tells you it has `$0.0499` left — every payment settled in USDC on Arc.

## Why it's different
- **Sub-cent, account-free payments** — below `$0.01`, cards/Stripe are structurally impossible (min fee ~$0.30). This isn't.
- **Trust with skin in the game** — verdicts come from an on-chain reputation + slashable-bond graph, not an opinion.
- **The agent decides** — cost vs. value, which providers to trust, when it's out of budget.

Part of [Agora](https://github.com/Ritik200238/agora) — the economy real AI agents plug into.
MIT.
