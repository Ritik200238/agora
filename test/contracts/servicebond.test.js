const { expect } = require("chai");
const { ethers } = require("hardhat");

const usd = (n) => BigInt(Math.round(n * 1e6));

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
    sb = await deploy("ServiceBond", usdc.target, treasury.address);
    await sb.setManager(gateway.address, true); // the gateway operator may slash

    await usdc.mint(seller.address, usd(100));
    await usdc.connect(seller).approve(sb.target, usd(100));
  });

  it("a seller stakes USDC behind their service", async () => {
    await expect(sb.connect(seller).bond(usd(10)))
      .to.emit(sb, "Bonded")
      .withArgs(seller.address, usd(10), usd(10));
    expect(await sb.bondOf(seller.address)).to.equal(usd(10));
    // funds actually moved into the contract
    expect(await usdc.balanceOf(sb.target)).to.equal(usd(10));
  });

  it("a seller can withdraw un-slashed stake, but never more than they staked", async () => {
    await sb.connect(seller).bond(usd(10));
    await sb.connect(seller).unbond(usd(4));
    expect(await sb.bondOf(seller.address)).to.equal(usd(6));
    await expect(sb.connect(seller).unbond(usd(999))).to.be.revertedWith("exceeds bond");
  });

  it("the gateway slashes a bad service's stake to the treasury (capped at the bond)", async () => {
    await sb.connect(seller).bond(usd(10));
    const t0 = await usdc.balanceOf(treasury.address);

    await expect(sb.connect(gateway).slash(seller.address, usd(3), "3/4 calls failed"))
      .to.emit(sb, "Slashed")
      .withArgs(seller.address, usd(3), treasury.address, "3/4 calls failed");
    expect(await sb.bondOf(seller.address)).to.equal(usd(7));
    expect((await usdc.balanceOf(treasury.address)) - t0).to.equal(usd(3));
    expect(await sb.totalSlashed()).to.equal(usd(3));

    // slashing more than the remaining bond seizes only what's left (never reverts for over-seizure)
    const seized = await sb.connect(gateway).slash.staticCall(seller.address, usd(999), "drain");
    expect(seized).to.equal(usd(7));
    await sb.connect(gateway).slash(seller.address, usd(999), "drain");
    expect(await sb.bondOf(seller.address)).to.equal(0n);
  });

  it("only a manager can slash", async () => {
    await sb.connect(seller).bond(usd(10));
    await expect(sb.connect(stranger).slash(seller.address, usd(1), "nope")).to.be.revertedWith("not manager");
  });

  it("once ownership is renounced, no key can add a rogue slasher", async () => {
    await sb.renounceOwnership();
    await expect(sb.setManager(stranger.address, true)).to.be.reverted; // Ownable: caller is not the owner
  });
});
