// End-to-end test of agora-paywall: a publisher wraps a route, an unpaid request gets 402 + x402 terms, a
// real on-chain USDC payment unlocks the content, underpayment is rejected, and a payment can't be replayed.
// `npm run test:paywall`.
import express from "express";
import { startChain } from "./harness";
import { agoraPaywall } from "../paywall/index.js";
import { dep } from "../shared/config";
import { walletFor, activeChain } from "../shared/chain";
import { HARDHAT_KEYS } from "../shared/local-accounts";
import { usd, usdcMint, usdcTransfer } from "../shared/usdc";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { parseEther } from "viem";

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fails++;
}
const PORT = 4082;
const base = `http://localhost:${PORT}`;
const getH = (p: string, headers: Record<string, string> = {}) =>
  fetch(base + p, { headers }).then(async (r) => ({ status: r.status, body: await r.json() }));

async function main() {
  const chain = await startChain();
  let server: any;
  try {
    const faucet = walletFor(HARDHAT_KEYS[0]);
    const publisher = privateKeyToAccount(generatePrivateKey()); // gets paid here
    const buyerPk = generatePrivateKey();
    const buyer = privateKeyToAccount(buyerPk);
    const buyerWallet = walletFor(buyerPk);
    await faucet.sendTransaction({ account: faucet.account, chain: activeChain, to: buyer.address, value: parseEther("1") });
    await usdcMint(faucet, dep().usdc, buyer.address, usd(1));

    // a publisher paywalls a premium article — 3 lines
    const app = express();
    app.use(express.json());
    app.get(
      "/article/:id",
      agoraPaywall({ priceUsdc: 0.01, payTo: publisher.address, token: dep().usdc, rpcUrl: "http://127.0.0.1:8545", chainId: 31337, name: "Premium article" }),
      (req: any, res) => res.json({ id: req.params.id, body: "PREMIUM: the secret sauce", paidTx: req.agoraPayment.tx })
    );
    server = await new Promise<any>((r) => { const s = app.listen(PORT, () => r(s)); });

    console.log("\n[agora-paywall — a publisher charges per article in USDC]");

    // 1. no payment → 402 + x402 terms
    const noPay = await getH("/article/1");
    check("an unpaid request gets 402 + x402 terms", noPay.status === 402 && noPay.body.terms?.payTo === publisher.address && Number(noPay.body.terms?.priceUsdc) === 0.01, `payTo=${noPay.body.terms?.payTo?.slice(0, 8)}…`);

    // 2. underpayment → 402
    const underTx = (await usdcTransfer(buyerWallet, dep().usdc, publisher.address, usd(0.005))).transactionHash;
    const claim = (tx: string) => buyer.signMessage({ message: noPay.body.terms.claimMessage.replace("{txHash}", tx.toLowerCase()) });
    const under = await getH("/article/1", { "X-Payment": underTx, "X-Payment-Signature": await claim(underTx) });
    check("an underpayment is rejected", under.status === 402 && /insufficient/i.test(under.body.error || ""), under.body.error);

    // 3. someone who copies the buyer's tx hash off the chain can't use it (no / wrong-wallet signature)
    const payTx = (await usdcTransfer(buyerWallet, dep().usdc, publisher.address, usd(0.01))).transactionHash;
    const snoop = await getH("/article/1", { "X-Payment": payTx });
    const thief = privateKeyToAccount(generatePrivateKey());
    const snoop2 = await getH("/article/1", { "X-Payment": payTx, "X-Payment-Signature": await thief.signMessage({ message: noPay.body.terms.claimMessage.replace("{txHash}", payTx.toLowerCase()) }) });
    check("a copied tx hash is useless without the payer's signature", snoop.status === 402 && snoop2.status === 402 && /not from the wallet/i.test(snoop2.body.error || ""), `${snoop.status}/${snoop2.status}`);

    // 4. the buyer's signed payment unlocks the content — once, even when sent twice at the same moment
    const sig = await claim(payTx);
    const [paid, raced] = await Promise.all([
      getH("/article/1", { "X-Payment": payTx, "X-Payment-Signature": sig }),
      getH("/article/1", { "X-Payment": payTx, "X-Payment-Signature": sig }),
    ]);
    const wins = [paid, raced].filter((r) => r.status === 200);
    check("a valid USDC payment unlocks the paid content", wins.length >= 1 && /PREMIUM/.test(wins[0].body.body || "") && wins[0].body.paidTx === payTx, `served article ${wins[0]?.body.id}`);
    check("two concurrent uses of one payment → only one served", wins.length === 1, `${wins.length} of 2 served`);

    // 5. replay protection
    const replay = await getH("/article/1", { "X-Payment": payTx, "X-Payment-Signature": sig });
    check("the same payment cannot be replayed", replay.status === 402 && /replay/i.test(replay.body.error || ""), replay.body.error);
  } finally {
    if (server) server.close();
    chain.stop();
  }
  console.log(fails === 0 ? "\n✅ PAYWALL E2E PASSED — any publisher can charge per request in USDC on Arc, verified on-chain." : `\n❌ ${fails} PAYWALL CHECK(S) FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
