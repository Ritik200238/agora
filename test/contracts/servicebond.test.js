const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const usd = (n) => BigInt(Math.round(n * 1e6));
const DELAY = 3 * 24 * 3600;

describe("ServiceBond — marketplace-layer collateral", function () {
  let usdc, sb;
  let owner, gateway, seller, treasury, stranger;

  async function deploy(name, ...args) {
    const f = await ethers.getContractFactory(name);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    return c;
  }

  beforeEach(async () => {
    [owner, gateway, seller, treasury, stranger] = await ethers.getSigners();
    usdc = await deploy("MockUSDC");
    sb = await deploy("ServiceBond", usdc.target, treasury.address, DELAY);
    await sb.setManager(gateway.address, true); // the gateway operator may slash

    await usdc.mint(seller.address, usd(100));
    await usdc.connect(seller).approve(sb.target, usd(100));
  });

  it("a seller stakes USDC behind their service", async () => {
    await expect(sb.connect(seller).bond(usd(10)))
      .to.emit(sb, "Bonded")
      .withArgs(seller.address, usd(10), usd(10));
    expect(await sb.bondOf(seller.address)).to.equal(usd(10));
    expect(await usdc.balanceOf(sb.target)).to.equal(usd(10));
  });

  it("rejects a zero treasury", async () => {
    await expect(deploy("ServiceBond", usdc.target, ethers.ZeroAddress, DELAY)).to.be.revertedWith("treasury=0");
  });

  it("unbonding is two-step: the trust signal drops now, the money only leaves after the delay", async () => {
    await sb.connect(seller).bond(usd(10));
    await sb.connect(seller).requestUnbond(usd(4));
    expect(await sb.bondOf(seller.address)).to.equal(usd(6)); // active stake (trust signal) drops immediately
    await expect(sb.connect(seller).withdrawUnbonded()).to.be.revertedWith("still unbonding");
    await time.increase(DELAY);
    const b0 = await usdc.balanceOf(seller.address);
    await sb.connect(seller).withdrawUnbonded();
    expect((await usdc.balanceOf(seller.address)) - b0).to.equal(usd(4));
    await expect(sb.connect(seller).requestUnbond(usd(999))).to.be.revertedWith("exceeds bond");
  });

  it("a seller can't dodge a slash by unbonding first — pending stake is still slashable", async () => {
    await sb.connect(seller).bond(usd(10));
    await sb.connect(seller).requestUnbond(usd(10)); // tries to run with everything
    await sb.connect(gateway).slash(seller.address, usd(7), "took the money and ran");
    expect((await sb.unbonding(seller.address)).amount).to.equal(usd(3));
    expect(await usdc.balanceOf(treasury.address)).to.equal(usd(7));
    await time.increase(DELAY);
    const b0 = await usdc.balanceOf(seller.address);
    await sb.connect(seller).withdrawUnbonded();
    expect((await usdc.balanceOf(seller.address)) - b0).to.equal(usd(3)); // only what survived the slash
  });

  it("a slash takes active stake first, then pending; cancelUnbond restores pending to active", async () => {
    await sb.connect(seller).bond(usd(10));
    await sb.connect(seller).requestUnbond(usd(4));
    await sb.connect(gateway).slash(seller.address, usd(8), "bad");
    expect(await sb.bondOf(seller.address)).to.equal(0n); // 6 active gone first
    expect((await sb.unbonding(seller.address)).amount).to.equal(usd(2)); // then 2 of the 4 pending
    await sb.connect(seller).cancelUnbond();
    expect(await sb.bondOf(seller.address)).to.equal(usd(2));
  });

  it("the gateway slashes to the treasury, capped at what exists", async () => {
    await sb.connect(seller).bond(usd(10));
    const t0 = await usdc.balanceOf(treasury.address);
    await expect(sb.connect(gateway).slash(seller.address, usd(3), "3/4 calls failed"))
      .to.emit(sb, "Slashed")
      .withArgs(seller.address, usd(3), treasury.address, "3/4 calls failed");
    expect(await sb.bondOf(seller.address)).to.equal(usd(7));
    expect((await usdc.balanceOf(treasury.address)) - t0).to.equal(usd(3));
    expect(await sb.totalSlashed()).to.equal(usd(3));
    const seized = await sb.connect(gateway).slash.staticCall(seller.address, usd(999), "drain");
    expect(seized).to.equal(usd(7));
  });

  it("only a manager can slash; the owner can revoke a leaked manager key", async () => {
    await sb.connect(seller).bond(usd(10));
    await expect(sb.connect(stranger).slash(seller.address, usd(1), "nope")).to.be.revertedWith("not manager");
    await sb.setManager(gateway.address, false); // rotate out a compromised gateway key
    await expect(sb.connect(gateway).slash(seller.address, usd(1), "leaked")).to.be.revertedWith("not manager");
    await expect(sb.connect(stranger).setManager(stranger.address, true)).to.be.revertedWithCustomError(sb, "OwnableUnauthorizedAccount");
  });
});
