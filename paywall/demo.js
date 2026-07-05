// A runnable demo publisher: two free articles + two premium ones behind an Agora paywall.
//   ARC_RPC=https://rpc.testnet.arc.network PAY_TO=0xYourWallet node paywall/demo.js
// Then GET http://localhost:3000/article/1 (free) and /premium/1 (402 → pay in USDC → unlock).
import express from "express";
import { agoraPaywall } from "./index.js";

const PORT = process.env.PORT ? +process.env.PORT : 3000;
const PAY_TO = process.env.PAY_TO || "0x000000000000000000000000000000000000dEaD";
const RPC = process.env.ARC_RPC || "https://rpc.testnet.arc.network";

const FREE = { 1: "Coffee is nice.", 2: "Water is wet." };
const PREMIUM = { 1: "The 3 trades that 10x'd our fund last quarter.", 2: "The prompt that broke every eval." };

const app = express();
app.use(express.json());

app.get("/", (_req, res) =>
  res.json({ free: ["/article/1", "/article/2"], premium: ["/premium/1", "/premium/2"], priceUsdc: 0.01, payTo: PAY_TO })
);

// free content — no paywall
app.get("/article/:id", (req, res) => {
  const body = FREE[req.params.id];
  return body ? res.json({ id: req.params.id, tier: "free", body }) : res.status(404).json({ error: "not found" });
});

// premium content — $0.01 USDC per read, settled on Arc
app.get(
  "/premium/:id",
  agoraPaywall({ priceUsdc: 0.01, payTo: PAY_TO, rpcUrl: RPC, name: "Premium article", onPaid: (i) => console.log(`paid ${i.priceUsdc} USDC → ${i.tx}`) }),
  (req, res) => {
    const body = PREMIUM[req.params.id];
    return body ? res.json({ id: req.params.id, tier: "premium", body, paidTx: req.agoraPayment.tx }) : res.status(404).json({ error: "not found" });
  }
);

app.listen(PORT, () => console.log(`demo publisher on http://localhost:${PORT}  (payTo ${PAY_TO}, rpc ${RPC})`));
