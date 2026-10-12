const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

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
    pool = await deploy("InsurancePool", usdc.target, usd(5), usd(12)); // $5/claim, $12/day
    await pool.setManager(gateway.address, true);
    await usdc.mint(stranger.address, usd(100));
    await usdc.connect(stranger).approve(pool.target, usd(100));
  });

  it("accepts voluntary funding + reports what's available", async () => {
    await expect(pool.connect(stranger).fund(usd(10))).to.emit(pool, "Funded").withArgs(stranger.address, usd(10));
    expect(await pool.available()).to.equal(usd(10));
  });

  it("a ServiceBond slash flows straight into the pool", async () => {
    sb = await deploy("ServiceBond", usdc.target, pool.target, 3600);
    await sb.setManager(gateway.address, true);
    await usdc.mint(seller.address, usd(20));
    await usdc.connect(seller).approve(sb.target, usd(20));
    await sb.connect(seller).bond(usd(20));
    await sb.connect(gateway).slash(seller.address, usd(5), "bad service");
    expect(await pool.available()).to.equal(usd(5));
  });

  it("the gateway pays a wronged buyer (pays what's there if the pool is short)", async () => {
    await pool.connect(stranger).fund(usd(4));
    const b0 = await usdc.balanceOf(buyer.address);
    await expect(pool.connect(gateway).payout(buyer.address, usd(3), "call svc_x failed"))
      .to.emit(pool, "PaidOut")
      .withArgs(buyer.address, usd(3), "call svc_x failed");
    expect((await usdc.balanceOf(buyer.address)) - b0).to.equal(usd(3));
    expect(await pool.totalPaidOut()).to.equal(usd(3));
    expect(await pool.connect(gateway).payout.staticCall(buyer.address, usd(5), "short")).to.equal(usd(1));
  });

  it("a leaked gateway key can't drain the pool: per-claim and per-day caps hold", async () => {
    await pool.connect(stranger).fund(usd(100));
    await expect(pool.connect(gateway).payout(stranger.address, usd(6), "big")).to.be.revertedWith("exceeds per-claim cap");
    await pool.connect(gateway).payout(stranger.address, usd(5), "a");
    await pool.connect(gateway).payout(stranger.address, usd(5), "b");
    await expect(pool.connect(gateway).payout(stranger.address, usd(5), "c")).to.be.revertedWith("daily payout cap reached");
    expect(await pool.remainingToday()).to.equal(usd(2));
    await time.increase(24 * 3600);
    expect(await pool.remainingToday()).to.equal(usd(12)); // the window rolls over
    await pool.connect(gateway).payout(stranger.address, usd(5), "next day");
    expect(await pool.available()).to.equal(usd(85)); // at most $12/day ever left the pool
  });

  it("only a manager can pay out; the owner can revoke a manager but can't pay out itself", async () => {
    await pool.connect(stranger).fund(usd(10));
    await expect(pool.connect(stranger).payout(stranger.address, usd(1), "theft")).to.be.revertedWith("not manager");
    await expect(pool.connect(owner).payout(owner.address, usd(1), "owner")).to.be.revertedWith("not manager");
    await pool.setManager(gateway.address, false);
    await expect(pool.connect(gateway).payout(buyer.address, usd(1), "revoked")).to.be.revertedWith("not manager");
  });

  it("rejects nonsense caps", async () => {
    await expect(deploy("InsurancePool", usdc.target, 0, usd(1))).to.be.revertedWith("bad caps");
    await expect(deploy("InsurancePool", usdc.target, usd(5), usd(1))).to.be.revertedWith("bad caps");
  });
});
