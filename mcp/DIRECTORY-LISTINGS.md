# List `agora-pay-mcp` in the MCP directories (~10 min, copy-paste)

The package is already published (`npx agora-pay-mcp`). This gets it **discovered** by agent builders across the
main directories. Do them top-to-bottom; the first two matter most.

**Reusable copy-paste block** (name / description / install):

- **Name:** Agora Pay
- **Package:** `agora-pay-mcp`
- **One-liner:** Give any AI agent a budget-capped wallet + a trust-checked, insured pay-per-use marketplace on Arc. USDC nanopayments over x402.
- **Tags:** payments, x402, usdc, arc, circle, agent-payments, marketplace, pay-per-use, nanopayments
- **Install config:**
  ```json
  { "mcpServers": { "agora-pay": { "command": "npx", "args": ["-y", "agora-pay-mcp"] } } }
  ```

---

## 1. Smithery — https://smithery.ai  (biggest directory)
1. Sign in with GitHub → **Deploy / Add Server**.
2. Point it at the repo **`Ritik200238/agora`** (a `mcp/smithery.yaml` is already committed for it).
3. If it asks for the base directory, use `mcp`. Publish.

## 2. Glama — https://glama.ai/mcp/servers  (auto-indexes)
Glama auto-discovers MCP servers from npm + GitHub, so `agora-pay-mcp` should appear on its own within a day.
To speed it up: sign in with GitHub at https://glama.ai → **Add server** → paste the repo URL.

## 3. PulseMCP — https://www.pulsemcp.com/submit
Fill the form with the copy-paste block above + repo `https://github.com/Ritik200238/agora`.

## 4. mcp.so — https://mcp.so/submit
Same: paste the repo URL + the description/tags above.

## 5. Official MCP Registry — https://github.com/modelcontextprotocol/registry
A `mcp/server.json` is already committed. To publish:
```bash
# one-time: install the publisher CLI (see the registry README for the latest command)
mcp-publisher login github        # authenticate as the repo owner
mcp-publisher publish mcp/server.json
```
(If the CLI/schema has moved on, open a PR adding the server per the registry's current instructions —
`mcp/server.json` has the exact metadata to paste.)

## 6. Awesome MCP Servers — https://github.com/punkpeye/awesome-mcp-servers
Open a small PR adding one line under the payments/finance section:
```
- [Agora Pay](https://github.com/Ritik200238/agora) — budget-capped agent wallet + trust-checked, insured pay-per-use marketplace on Arc (USDC over x402).
```

---

Tip: after listing, the fastest real-install signal is Smithery + Glama. Everything else is bonus reach.
