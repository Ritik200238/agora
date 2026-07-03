# Deploying Agora

## A. Live dashboard (the hosted link)

The container self-boots a local EVM, deploys the contracts, runs the economy, and serves the dashboard on
`$PORT`. No external services or keys needed.

### Render (recommended)
1. Push this repo to GitHub.
2. Render → **New → Web Service** → connect the repo. It auto-detects `render.yaml` (Docker).
3. Deploy. Render gives you a public URL — open it to watch the live economy. That URL is your submission link.

*(Railway and Fly.io work the same way — they build the `Dockerfile`.)*

### Local Docker
```bash
docker build -t agora .
docker run -p 4000:4000 agora
# open http://localhost:4000
```

> Sizing: the economy runs a local EVM node in-process, so give it ≥512MB (Render "starter" is comfortable).
> The economy is ephemeral — it resets on restart (fine for a demo).

## B. Arc Testnet (real on-chain — needs funds)

```bash
# 1. Get an Arc Testnet key funded with test USDC:
#    https://faucet.circle.com
cp .env.example .env          # set PRIVATE_KEY + ARC_TESTNET_RPC
npm run deploy:arc            # deploys contracts to Arc → deployments/arcTestnet.json
AGORA_NETWORK=arcTestnet SETTLEMENT=arc npm run economy
```
On Arc, jobs / streams / credit settle via on-chain USDC (Arc's native USDC at `0x3600…0000`). The x402
**Circle Gateway** path additionally needs a producer facilitator endpoint (`PRODUCER_X402_URL`) to settle
per-call sales via Gateway; without it, jobs+streams+credit still run and x402 sales are skipped with a log.

> The multi-agent economy needs each agent funded. From CI/headless we can't clear the faucet captcha, so a
> full multi-agent Arc run needs you to fund the keys; the **local** run proves the whole system.

## C. CI

`.github/workflows/ci.yml` runs the full suite — **22 contract tests + the end-to-end economy** (which boots a
real local chain and asserts on-chain state) — on every push and PR.
