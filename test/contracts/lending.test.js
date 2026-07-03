const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");

const usd = (n) => BigInt(Math.round(n * 1e6));

describe("LendingPool — reputation-backed credit", function () {
  let usdc, identity, reputation, bond, pool;
  let owner, lender, borrower, other;
  let borrowerId, otherId;

  async function deploy(name, ...args) {
    const f = await ethers.getContractFactory(name);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    return c;
  }

  beforeEach(async () => {
    [owner, lender, borrower, other] = await ethers.getSigners();
    usdc = await deploy("MockUSDC");
    identity = await deploy("IdentityRegistry");
    reputation = await deploy("ReputationRegistry");
    bond = await deploy("ReputationBond", usdc.target);
    pool = await deploy("LendingPool", usdc.target, identity.target, reputation.target, bond.target);

    await bond.setManager(pool.target, true);
    await reputation.setReporter(pool.target, true);
    await reputation.setReporter(owner.address, true); // so the test can set reputation directly

    await identity.connect(borrower).register("worker", "ipfs://b");
    await identity.connect(other).register("worker", "ipfs://o");
    borrowerId = await identity.agentOf(borrower.address);
    otherId = await identity.agentOf(other.address);

    // fund: lender + borrower; borrower posts a bond (for collateral)
    await usdc.mint(lender.address, usd(500));
    await usdc.mint(borrower.address, usd(100));
    await usdc.connect(borrower).approve(bond.target, usd(10));
    await bond.connect(borrower).postBond(usd(10));

    // lender deposits into the pool
    await usdc.connect(lender).approve(pool.target, usd(200));
    await pool.connect(lender).deposit(usd(200));
  });

  it("credit limit tracks reputation; negative reputation → no credit", async () => {
    expect(await pool.creditLimit(borrowerId)).to.equal(usd(2)); // score 0 → base $2
    await reputation.connect(owner).giveFeedback(borrowerId, 100, true, ethers.id("x"));
    expect(await pool.creditLimit(borrowerId)).to.equal(usd(7)); // $2 + 100*$0.05
    await reputation.connect(owner).giveFeedback(otherId, -5, false, ethers.id("y"));
    expect(await pool.creditLimit(otherId)).to.equal(0n); // negative → 0
  });

  it("borrows under-collateralized against reputation, locking only a fraction as bond", async () => {
    await reputation.connect(owner).giveFeedback(borrowerId, 100, true, ethers.id("x")); // limit $7
    const b0 = await usdc.balanceOf(borrower.address);
    await pool.connect(borrower).borrow(usd(5)); // fee 5% = 0.25, owed 5.25 <= 7
    expect((await usdc.balanceOf(borrower.address)) - b0).to.equal(usd(5)); // got principal
    expect(await pool.debt(borrower.address)).to.equal(usd(5.25));
    expect(await bond.locked(borrower.address)).to.equal(usd(1)); // 20% of 5 collateral, << the $5 borrowed
  });

  it("rejects borrowing beyond the reputation credit limit", async () => {
    // score 0 → limit $2; try to borrow $5 (owed $5.25)
    await expect(pool.connect(borrower).borrow(usd(5))).to.be.revertedWith("exceeds credit limit");
  });

  it("full repayment clears debt, unlocks collateral, books interest for lenders", async () => {
    await reputation.connect(owner).giveFeedback(borrowerId, 100, true, ethers.id("x"));
    await pool.connect(borrower).borrow(usd(5));
    await usdc.connect(borrower).approve(pool.target, usd(5.25));
    await pool.connect(borrower).repay(usd(5.25));
    expect(await pool.debt(borrower.address)).to.equal(0n);
    expect(await bond.locked(borrower.address)).to.equal(0n); // collateral unlocked
    expect(await pool.interestEarned()).to.equal(usd(0.25)); // lender's yield
  });

  it("recovers a defaulted (past-due) loan by slashing collateral + tanking reputation", async () => {
    await reputation.connect(owner).giveFeedback(borrowerId, 100, true, ethers.id("x"));
    await pool.connect(borrower).borrow(usd(5)); // locks $1 collateral
    const bondBefore = await bond.bondOf(borrower.address);
    await mine(5001); // past LOAN_TERM
    await pool.connect(owner).recover(borrower.address);
    expect(await pool.defaults()).to.equal(1n);
    expect(await pool.debt(borrower.address)).to.equal(0n);
    expect(bondBefore - (await bond.bondOf(borrower.address))).to.equal(usd(1)); // collateral seized
    expect(await reputation.scoreOf(borrowerId)).to.equal(60n); // 100 - 40 default hit
  });
});
