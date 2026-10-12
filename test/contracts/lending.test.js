const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const usd = (n) => BigInt(Math.round(n * 1e6));
const ANS = ethers.id("answer");

describe("LendingPool — track-record-backed credit", function () {
  let usdc, identity, reputation, validation, bond, jobBoard, pool;
  let owner, lender, lender2, borrower, client, validatorAcct, sybil, treasury;
  let borrowerId, validatorId, sybilId;

  async function deploy(name, ...args) {
    const f = await ethers.getContractFactory(name);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    return c;
  }

  /** A real job the borrower completes: client pays `amount`, the curated validator earns `valBps`. */
  async function completeJob(workerSigner, workerAgentId, amount, valBps = 300) {
    const deadline = (await time.latest()) + 3600;
    await usdc.connect(client).approve(jobBoard.target, amount);
    await jobBoard.connect(client).postJob(workerAgentId, validatorId, 0n, 0, valBps, amount, deadline, ethers.id("spec"));
    const jobId = (await jobBoard.nextJobId()) - 1n;
    await jobBoard.connect(workerSigner).accept(jobId);
    await jobBoard.connect(workerSigner).submit(jobId, ANS);
    await jobBoard.connect(validatorAcct).validate(jobId, ANS);
  }

  beforeEach(async () => {
    [owner, lender, lender2, borrower, client, validatorAcct, sybil, treasury] = await ethers.getSigners();
    usdc = await deploy("MockUSDC");
    identity = await deploy("IdentityRegistry");
    reputation = await deploy("ReputationRegistry");
    validation = await deploy("ValidationRegistry");
    bond = await deploy("ReputationBond", usdc.target);
    jobBoard = await deploy("JobBoard", usdc.target, identity.target, reputation.target, validation.target, bond.target, treasury.address);
    pool = await deploy("LendingPool", usdc.target, identity.target, reputation.target, bond.target, jobBoard.target);

    await reputation.setReporter(jobBoard.target, true);
    await reputation.setReporter(pool.target, true);
    await bond.setManager(jobBoard.target, true);
    await bond.setManager(pool.target, true);
    await validation.initialize(jobBoard.target);

    await identity.setValidatorApproval(validatorAcct.address, true);
    await identity.connect(validatorAcct).register("validator", "ipfs://v");
    await identity.connect(client).register("consumer", "ipfs://c");
    await identity.connect(borrower).register("worker", "ipfs://b");
    await identity.connect(sybil).register("worker", "ipfs://fresh");
    validatorId = await identity.agentOf(validatorAcct.address);
    borrowerId = await identity.agentOf(borrower.address);
    sybilId = await identity.agentOf(sybil.address);

    for (const a of [lender, lender2, client]) await usdc.mint(a.address, usd(1000));
    // the borrower has stake enough to accept real jobs ($100 job → $50 locked); the sybil posts a little
    await usdc.mint(borrower.address, usd(400));
    await usdc.connect(borrower).approve(bond.target, usd(300));
    await bond.connect(borrower).postBond(usd(300));
    await usdc.mint(sybil.address, usd(100));
    await usdc.connect(sybil).approve(bond.target, usd(20));
    await bond.connect(sybil).postBond(usd(20));

    await usdc.connect(lender).approve(pool.target, usd(200));
    await pool.connect(lender).deposit(usd(200));
  });

  it("a fresh wallet with no track record gets NO credit (closes the sybil drain)", async () => {
    expect(await pool.creditLimit(sybilId)).to.equal(0n);
    await expect(pool.connect(sybil).borrow(usd(1))).to.be.revertedWith("exceeds credit limit");
  });

  it("credit = 2× the validator fees sunk into completed work, capped at $17", async () => {
    await completeJob(borrower, borrowerId, usd(100)); // 3% → $3 basis
    expect(await jobBoard.creditBasis(borrowerId)).to.equal(usd(3));
    expect(await pool.creditLimit(borrowerId)).to.equal(usd(6));
    await completeJob(borrower, borrowerId, usd(500)); // +$15 basis → 2×$18 = $36 → capped
    expect(await pool.creditLimit(borrowerId)).to.equal(usd(17));
  });

  it("defaulting never pays: what a defaulter keeps is less than the fees it had to sink", async () => {
    await completeJob(borrower, borrowerId, usd(100)); // basis $3 → limit $6
    const basis = await jobBoard.creditBasis(borrowerId);
    const principal = (usd(6) * 10000n) / 10500n; // max borrow so principal + 5% fee == limit
    const b0 = await usdc.balanceOf(borrower.address);
    const bond0 = await bond.bondOf(borrower.address);
    await pool.connect(borrower).borrow(principal);
    await time.increase(24 * 3600 + 1);
    await pool.connect(owner).recover(borrower.address);
    const kept = (await usdc.balanceOf(borrower.address)) - b0 - (bond0 - (await bond.bondOf(borrower.address)));
    expect(kept).to.be.greaterThan(0n);
    expect(kept).to.be.lessThan(basis); // the default netted less than the sunk third-party fees
  });

  it("borrowing locks 60% collateral from free bond", async () => {
    await completeJob(borrower, borrowerId, usd(100));
    const b0 = await usdc.balanceOf(borrower.address);
    await pool.connect(borrower).borrow(usd(5));
    expect((await usdc.balanceOf(borrower.address)) - b0).to.equal(usd(5));
    expect(await pool.debt(borrower.address)).to.equal(usd(5.25));
    expect(await bond.locked(borrower.address)).to.equal(usd(3));
  });

  it("negative reputation → no credit", async () => {
    await completeJob(borrower, borrowerId, usd(100));
    await reputation.setReporter(owner.address, true);
    await reputation.connect(owner).giveFeedback(borrowerId, -50, false, ethers.id("x"));
    expect(await pool.creditLimit(borrowerId)).to.equal(0n);
  });

  it("interest raises every lender's share value; lenders can withdraw principal + yield", async () => {
    await usdc.connect(lender2).approve(pool.target, usd(100));
    await pool.connect(lender2).deposit(usd(100));
    await completeJob(borrower, borrowerId, usd(100));
    await pool.connect(borrower).borrow(usd(5));
    await usdc.connect(borrower).approve(pool.target, usd(5.25));
    await pool.connect(borrower).repay(usd(5.25));
    expect(await pool.interestEarned()).to.equal(usd(0.25));
    expect(await bond.locked(borrower.address)).to.equal(0n);

    const l1 = await pool.balanceOf(lender.address);
    const l2 = await pool.balanceOf(lender2.address);
    // 2:1 deposits → interest split 2:1 (±1 unit rounding)
    expect(l1 - usd(200)).to.be.closeTo(usd(0.25) * 2n / 3n, 2n);
    expect(l2 - usd(100)).to.be.closeTo(usd(0.25) / 3n, 2n);

    const w0 = await usdc.balanceOf(lender2.address);
    await pool.connect(lender2).withdraw(l2);
    expect((await usdc.balanceOf(lender2.address)) - w0).to.equal(l2); // got principal + yield back
  });

  it("a default's loss is shared pro rata — nobody exits whole while others eat it", async () => {
    await usdc.connect(lender2).approve(pool.target, usd(200));
    await pool.connect(lender2).deposit(usd(200));
    await completeJob(borrower, borrowerId, usd(100));
    await pool.connect(borrower).borrow(usd(5)); // 60% collateral = $3 → shortfall $2.25 (owed 5.25)
    await time.increase(24 * 3600 + 1);
    await pool.connect(owner).recover(borrower.address);
    expect(await pool.defaults()).to.equal(1n);
    expect(await pool.writtenOff()).to.equal(usd(2.25));

    const l1 = await pool.balanceOf(lender.address);
    const l2 = await pool.balanceOf(lender2.address);
    expect(l1).to.be.closeTo(l2, 2n); // equal deposits → equal loss
    expect(usd(200) - l1).to.be.closeTo(usd(1), 2n); // $2 principal loss split in half
    await expect(pool.connect(lender).withdraw(usd(200))).to.be.revertedWith("exceeds balance"); // can't exit whole
  });

  it("recovery tanks reputation; the loan can't be recovered before it's due", async () => {
    await completeJob(borrower, borrowerId, usd(100)); // rep +10
    await pool.connect(borrower).borrow(usd(5));
    await expect(pool.connect(owner).recover(borrower.address)).to.be.revertedWith("not past due");
    await time.increase(24 * 3600 + 1);
    await pool.connect(owner).recover(borrower.address);
    expect(await reputation.scoreOf(borrowerId)).to.equal(-30n); // 10 - 40
    expect(await bond.locked(borrower.address)).to.equal(0n);
  });

  it("partial repayment pays principal first, keeps collateral locked until fully repaid", async () => {
    await completeJob(borrower, borrowerId, usd(100));
    await pool.connect(borrower).borrow(usd(5));
    await usdc.connect(borrower).approve(pool.target, usd(5.25));
    await pool.connect(borrower).repay(usd(3));
    expect(await pool.principalOf(borrower.address)).to.equal(usd(2));
    expect(await bond.locked(borrower.address)).to.equal(usd(3));
    await pool.connect(borrower).repay(usd(2.25));
    expect(await pool.debt(borrower.address)).to.equal(0n);
    expect(await bond.locked(borrower.address)).to.equal(0n);
  });

  it("one loan at a time; borrowing needs enough free bond", async () => {
    await completeJob(borrower, borrowerId, usd(500)); // limit $17 (capped)
    await pool.connect(borrower).borrow(usd(5));
    await expect(pool.connect(borrower).borrow(usd(1))).to.be.revertedWith("repay existing loan first");
    await usdc.connect(borrower).approve(pool.target, usd(5.25));
    await pool.connect(borrower).repay(usd(5.25));
    await bond.connect(borrower).withdraw(usd(300)); // no free bond left
    await expect(pool.connect(borrower).borrow(usd(5))).to.be.revertedWith("insufficient free bond");
  });
});
