# Deploying Agora

The hosted app is one container. It always runs the **12-agent economy on an in-process sandbox chain**, which
sends dozens of transactions a second and so has to be free. The **public marketplace** runs in one of two
modes:

| Mode | Set | What a call costs / proves |
|---|---|---|
| **Sandbox** (default) | nothing | Demo USDC on the sandbox chain. Tx hashes are local, not on Arcscan. |
| **Arc** | `MARKET_CHAIN=arc` + `PRIVATE_KEY` | Real testnet USDC. Every call is a **Circle Gateway nanopayment on Arc Testnet**, charged only if the call delivers. |

## A. Render (the hosted link)

1. Render → **New → Web Service** → connect the repo. It auto-detects `render.yaml` (Docker).
2. Set the environment variables below. Then deploy; it auto-deploys on every push to `main`.

### Environment variables

| Variable | Needed for | Value |
|---|---|---|
| `AGORA_ADMIN_TOKEN` | resolving buyer claims | a long random secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Without it the admin route is off (404). |
| `DATABASE_URL` | listings + traction that survive redeploys | a Postgres URL (e.g. Supabase). If it's unreachable the app keeps running in memory and `/api/info` shows `store.ok: false`. |
| `MARKET_CHAIN` | Arc mode | `arc` |
| `PRIVATE_KEY` | Arc mode | the funded Arc Testnet key that deployed `deployments/arcTestnet.json` (it's the ServiceBond/InsurancePool manager). **Keep it secret.** Top it up at https://faucet.circle.com. |
| `ARC_TESTNET_RPC` | optional | defaults to `https://rpc.testnet.arc.network` |
| `ARC_TAB_CAP_USDC` | optional | free demo credit per visitor tab (default `0.01`) |
| `ARC_TAB_DAILY_BUDGET_USDC` | optional | most the operator spends on demo tabs per day (default `0.5`) |
| `ARC_OPERATOR_FLOOR_USDC` | optional | demo tabs pause if the operator's **on-chain** balance would drop below this (default `5`). This survives restarts; the daily budget doesn't. |
| `TRUST_PROXY_HOPS` | optional | proxies in front of the app. Default `3` on Render (measured), `0` elsewhere. |

### Check it's live

```bash
curl -s https://<your-app>/api/info          # "market":"arc" and "store":{"ok":true}
curl -s https://<your-app>/x402/services | head -c 300   # "settlement":"circle-gateway","chainId":5042002
curl -si https://<your-app>/x402/arc/feed | grep -i payment-required   # standard x402 402
```

Each demo tab costs the operator its cap plus about $0.006 of Arc gas. The defaults cap that at $0.50/day and
stop at a $5 reserve.

## B. Local

```bash
npm ci && npx hardhat compile
npm run dashboard                                   # sandbox mode → http://localhost:4000
MARKET_CHAIN=arc npm run dashboard                  # Arc mode (needs PRIVATE_KEY in .env)
docker build -t agora . && docker run -p 4000:4000 agora
```

## C. Contracts on Arc

`deployments/arcTestnet.json` holds the live Arc addresses and is committed. To redeploy (e.g. after a
contract change):

```bash
npm run deploy:arc        # PRIVATE_KEY in .env; costs ~$0.30 of testnet USDC in gas
```

Optional deploy env: `ADMIN` (a multisig to own the validator set and manager rotation), `GATEWAY_OPERATOR`,
`UNBOND_DELAY_SECONDS`, `INSURANCE_MAX_PAYOUT_UNITS`, `INSURANCE_MAX_PER_DAY_UNITS`.

## D. Tests

- `npm test`: contracts, security suites and every end-to-end suite on a local chain. CI runs this plus
  `npm run typecheck` on every push.
- `npm run test:arc` and `npm run test:arc-gateway`: **live** against Arc Testnet + Circle's facilitator. Each
  costs a few cents of testnet USDC and needs `PRIVATE_KEY`. They're not in CI.
