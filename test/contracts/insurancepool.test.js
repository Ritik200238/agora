const { expect } = require("chai");
const { ethers } = require("hardhat");

const usd = (n) => BigInt(Math.round(n * 1e6));

describe("InsurancePool — buyer-protection fund", function () {
  let usdc, pool, sb;
  let owner, gateway, buyer, seller, stranger;

  async function deploy(name, ...args) {
    const f = await ethers.getContractFactory(name);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    return c;
  }

  beforeEach(async () => {
    [owner, gateway, buyer, seller, stranger] = await ethers.getSigners();
    usdc = await deploy("MockUSDC");
    pool = await deploy("InsurancePool", usdc.target);
    await pool.setManager(gateway.address, true);
    await usdc.mint(stranger.address, usd(100));
  });

  it("accepts voluntary funding + reports what's available", async () => {
    await usdc.connect(stranger).approve(pool.target, usd(10));
    await expect(pool.connect(stranger).fund(usd(10))).to.emit(pool, "Funded").withArgs(stranger.address, usd(10));
    expect(await pool.available()).to.equal(usd(10));
  });

  it("a ServiceBond slash flows straight into the pool", async () => {
    // ServiceBond deployed with the pool as its treasury → slashes land here
    sb = await deploy("ServiceBond", usdc.target, pool.target);
    await sb.setManager(gateway.address, true);
    await usdc.mint(seller.address, usd(20));
    await usdc.connect(seller).approve(sb.target, usd(20));
    await sb.connect(seller).bond(usd(20));

    await sb.connect(gateway).slash(seller.address, usd(5), "bad service");
    expect(await pool.available()).to.equal(usd(5)); // slashed stake now protects buyers
  });

  it("the gateway pays a wronged buyer out of the pool (capped at balance)", async () => {
    await usdc.connect(stranger).approve(pool.target, usd(10));
    await pool.connect(stranger).fund(usd(10));
    const b0 = await usdc.balanceOf(buyer.address);

    await expect(pool.connect(gateway).payout(buyer.address, usd(3), "call svc_x failed"))
      .to.emit(pool, "PaidOut")
      .withArgs(buyer.address, usd(3), "call svc_x failed");
    expect((await usdc.balanceOf(buyer.address)) - b0).to.equal(usd(3));
    expect(await pool.available()).to.equal(usd(7));
    expect(await pool.totalPaidOut()).to.equal(usd(3));

    // paying more than the pool holds pays only what's left (never reverts)
    const paid = await pool.connect(gateway).payout.staticCall(buyer.address, usd(999), "drain");
    expect(paid).to.equal(usd(7));
  });

  it("only a manager can pay out", async () => {
    await usdc.connect(stranger).approve(pool.target, usd(10));
    await pool.connect(stranger).fund(usd(10));
    await expect(pool.connect(stranger).payout(stranger.address, usd(1), "theft")).to.be.revertedWith("not manager");
  });

  it("once ownership is renounced, no key can add a rogue payer", async () => {
    await pool.renounceOwnership();
    await expect(pool.setManager(stranger.address, true)).to.be.reverted;
  });
});
