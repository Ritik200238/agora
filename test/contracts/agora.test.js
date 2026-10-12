const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const usd = (n) => BigInt(Math.round(n * 1e6)); // USDC 6 decimals
const ANS = ethers.id("the-correct-answer");
const WRONG = ethers.id("tampered-answer");

describe("Agora contracts (hardened)", function () {
  let usdc, identity, reputation, validation, bond, jobBoard;
  let owner, client, worker, validatorAcct, broker, fraud, unbonded;
  let clientId, workerId, validatorId, brokerId, fraudId, unbondedId;

  async function deploy(name, ...args) {
    const f = await ethers.getContractFactory(name);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    return c;
  }

  beforeEach(async () => {
    [owner, client, worker, validatorAcct, broker, fraud, unbonded] = await ethers.getSigners();

    usdc = await deploy("MockUSDC");
    identity = await deploy("IdentityRegistry");
    reputation = await deploy("ReputationRegistry");
    validation = await deploy("ValidationRegistry");
    bond = await deploy("ReputationBond", usdc.target);
    jobBoard = await deploy("JobBoard", usdc.target, identity.target, reputation.target, validation.target, bond.target, owner.address);

    await reputation.setReporter(jobBoard.target, true);
    await bond.setManager(jobBoard.target, true);
    await validation.initialize(jobBoard.target);

    await identity.setValidatorApproval(validatorAcct.address, true); // curated validator set
    await identity.connect(client).register("consumer", "ipfs://client");
    await identity.connect(worker).register("worker", "ipfs://worker");
    await identity.connect(validatorAcct).register("validator", "ipfs://validator");
    await identity.connect(broker).register("broker", "ipfs://broker");
    await identity.connect(fraud).register("worker", "ipfs://fraud");
    await identity.connect(unbonded).register("worker", "ipfs://unbonded");

    clientId = await identity.agentOf(client.address);
    workerId = await identity.agentOf(worker.address);
    validatorId = await identity.agentOf(validatorAcct.address);
    brokerId = await identity.agentOf(broker.address);
    fraudId = await identity.agentOf(fraud.address);
    unbondedId = await identity.agentOf(unbonded.address);

    await usdc.mint(client.address, usd(1000));
    await usdc.mint(worker.address, usd(100));
    await usdc.mint(fraud.address, usd(100));
    await usdc.connect(worker).approve(bond.target, usd(50));
    await bond.connect(worker).postBond(usd(50));
    await usdc.connect(fraud).approve(bond.target, usd(20));
    await bond.connect(fraud).postBond(usd(20));
  });

  const signerFor = (id) => ({ [workerId]: worker, [fraudId]: fraud, [unbondedId]: unbonded })[id];

  /** Client proposes a job; by default the named worker accepts it (locking its collateral). */
  async function postJob(workerAgentId, amount, brokerAgentId = 0n, brokerBps = 0, valBps = 0, ttl = 3600, accept = true) {
    const deadline = (await time.latest()) + ttl;
    await usdc.connect(client).approve(jobBoard.target, amount);
    await jobBoard.connect(client).postJob(workerAgentId, validatorId, brokerAgentId, brokerBps, valBps, amount, deadline, ethers.id("spec"));
    const jobId = (await jobBoard.nextJobId()) - 1n;
    if (accept) await jobBoard.connect(signerFor(workerAgentId)).accept(jobId);
    return jobId;
  }

  describe("Identity (soulbound)", () => {
    it("mints a passport per wallet; rejects double registration", async () => {
      expect(await identity.ownerOf(workerId)).to.equal(worker.address);
      await expect(identity.connect(worker).register("worker", "x")).to.be.revertedWith("already registered");
    });
    it("passports are non-transferable", async () => {
      await expect(
        identity.connect(worker).transferFrom(worker.address, owner.address, workerId)
      ).to.be.revertedWith("soulbound: non-transferable");
    });
  });

  describe("Happy path — verdict derived on-chain", () => {
    it("pays splits, raises reputation, unlocks bond on match", async () => {
      const amount = usd(10);
      const jobId = await postJob(workerId, amount, brokerId, 500, 300);
      expect(await bond.locked(worker.address)).to.equal(amount / 2n); // collateral locked

      const w0 = await usdc.balanceOf(worker.address);
      await jobBoard.connect(worker).submit(jobId, ANS);
      await jobBoard.connect(validatorAcct).validate(jobId, ANS); // validator's recomputed hash matches

      const brokerFee = (amount * 500n) / 10000n;
      const valFee = (amount * 300n) / 10000n;
      expect((await usdc.balanceOf(worker.address)) - w0).to.equal(amount - brokerFee - valFee);
      expect(await reputation.scoreOf(workerId)).to.equal(10n);
      expect(await bond.locked(worker.address)).to.equal(0n); // unlocked
      expect((await jobBoard.getJob(jobId)).status).to.equal(3n);
    });
  });

  describe("Fraud path — locked bond is actually slashed", () => {
    it("mismatch → reject, refund client, slash locked bond to treasury, tank reputation", async () => {
      const amount = usd(8);
      const jobId = await postJob(fraudId, amount); // locks usd(4) of fraud's bond
      const c0 = await usdc.balanceOf(client.address);
      const t0 = await usdc.balanceOf(owner.address); // treasury
      const fb0 = await bond.bondOf(fraud.address);

      await jobBoard.connect(fraud).submit(jobId, WRONG);
      await jobBoard.connect(validatorAcct).validate(jobId, ANS); // ANS != WRONG → fail

      expect((await usdc.balanceOf(client.address)) - c0).to.equal(amount); // refunded
      expect((await usdc.balanceOf(owner.address)) - t0).to.equal(amount / 2n); // slashed → treasury
      expect(fb0 - (await bond.bondOf(fraud.address))).to.equal(amount / 2n);
      expect(await reputation.scoreOf(fraudId)).to.equal(-25n);
      expect((await jobBoard.getJob(jobId)).status).to.equal(4n);
    });
  });

  describe("Reputation-as-collateral is enforced", () => {
    it("a worker without free collateral cannot accept (and the client can cancel for a full refund)", async () => {
      const jobId = await postJob(unbondedId, usd(10), 0n, 0, 0, 3600, false);
      await expect(jobBoard.connect(unbonded).accept(jobId)).to.be.revertedWith("insufficient free bond");
      const c0 = await usdc.balanceOf(client.address);
      await jobBoard.connect(client).cancel(jobId);
      expect((await usdc.balanceOf(client.address)) - c0).to.equal(usd(10));
      expect((await jobBoard.getJob(jobId)).status).to.equal(7n); // Cancelled
    });
    it("locked bond cannot be withdrawn mid-job (closes the slash-bypass)", async () => {
      await postJob(workerId, usd(10)); // locks usd(5)
      expect(await bond.available(worker.address)).to.equal(usd(45));
      await expect(bond.connect(worker).withdraw(usd(50))).to.be.revertedWith("exceeds available (locked)");
      await expect(bond.connect(worker).withdraw(usd(45))).to.not.be.reverted; // the free part is fine
    });
  });

  describe("Party distinctness + validator integrity", () => {
    it("rejects worker == client", async () => {
      const deadline = (await time.latest()) + 3600;
      await usdc.connect(client).approve(jobBoard.target, usd(2));
      await expect(
        jobBoard.connect(client).postJob(clientId, validatorId, 0n, 0, 0, usd(2), deadline, ethers.id("s"))
      ).to.be.revertedWith("worker == client");
    });
    it("rejects validator == client (no self-validation theft)", async () => {
      const deadline = (await time.latest()) + 3600;
      await usdc.connect(client).approve(jobBoard.target, usd(2));
      await expect(
        jobBoard.connect(client).postJob(workerId, clientId, 0n, 0, 0, usd(2), deadline, ethers.id("s"))
      ).to.be.revertedWith("validator == client");
    });
    it("an unapproved wallet cannot register as a validator (no self-declared validators)", async () => {
      await expect(identity.connect(owner).register("validator", "ipfs://self")).to.be.revertedWith("validator not approved");
      await expect(identity.connect(client).setValidatorApproval(client.address, true)).to.be.revertedWithCustomError(identity, "OwnableUnauthorizedAccount");
    });
    it("a revoked validator can no longer be named on new jobs", async () => {
      await identity.setValidatorApproval(validatorAcct.address, false);
      expect(await identity.isValidator(validatorId)).to.equal(false);
      const deadline = (await time.latest()) + 3600;
      await usdc.connect(client).approve(jobBoard.target, usd(2));
      await expect(
        jobBoard.connect(client).postJob(workerId, validatorId, 0n, 0, 0, usd(2), deadline, ethers.id("s"))
      ).to.be.revertedWith("validator role required");
    });
    it("rejects a validator that is not a validator-role agent", async () => {
      const deadline = (await time.latest()) + 3600;
      await usdc.connect(client).approve(jobBoard.target, usd(2));
      // brokerId is a 'broker' role, not 'validator'
      await expect(
        jobBoard.connect(client).postJob(workerId, brokerId, 0n, 0, 0, usd(2), deadline, ethers.id("s"))
      ).to.be.revertedWith("validator role required");
    });
  });

  describe("Authorization & rug-resistance", () => {
    it("ValidationRegistry can only be bound by its deployer, once", async () => {
      const v2 = await deploy("ValidationRegistry");
      await expect(v2.connect(client).initialize(client.address)).to.be.revertedWith("only deployer");
      await expect(validation.initialize(client.address)).to.be.revertedWith("already initialized");
    });
    it("a contract wallet cannot re-enter register() to mint itself a second passport", async () => {
      const probe = await deploy("ReentrantRegistrant", identity.target);
      await probe.go();
      expect(await probe.reentered()).to.equal(true);
      expect(await probe.reentrySucceeded()).to.equal(false);
      expect(await identity.balanceOf(probe.target)).to.equal(1n);
    });
    it("ValidationRegistry is writable only by the JobBoard", async () => {
      await expect(validation.connect(owner).request(1, 1, ethers.id("x"))).to.be.revertedWith("only jobBoard");
    });
    it("reputation feedback only from the reporter", async () => {
      await expect(reputation.connect(owner).giveFeedback(workerId, 1, true, ethers.id("x"))).to.be.revertedWith("not reporter");
    });
    it("after renounce, no key can add a new reporter/manager (no rug)", async () => {
      await reputation.renounceOwnership();
      await bond.renounceOwnership();
      await expect(reputation.connect(owner).setReporter(owner.address, true)).to.be.revertedWithCustomError(reputation, "OwnableUnauthorizedAccount");
      await expect(bond.connect(owner).setManager(owner.address, true)).to.be.revertedWithCustomError(bond, "OwnableUnauthorizedAccount");
    });
    it("only worker submits; only validator validates", async () => {
      const jobId = await postJob(workerId, usd(4));
      await expect(jobBoard.connect(broker).submit(jobId, ANS)).to.be.revertedWith("not worker");
      await jobBoard.connect(worker).submit(jobId, ANS);
      await expect(jobBoard.connect(broker).validate(jobId, ANS)).to.be.revertedWith("not validator");
    });
  });

  describe("Expiry", () => {
    it("refunds client, unlocks bond, dings reputation after deadline", async () => {
      const jobId = await postJob(workerId, usd(6), 0n, 0, 0, 100);
      const c0 = await usdc.balanceOf(client.address);
      await time.increase(200);
      await jobBoard.connect(owner).expire(jobId);
      expect((await usdc.balanceOf(client.address)) - c0).to.equal(usd(6));
      expect(await bond.locked(worker.address)).to.equal(0n);
      expect(await reputation.scoreOf(workerId)).to.equal(-5n);
      expect((await jobBoard.getJob(jobId)).status).to.equal(5n);
    });
  });

  describe("Worker consent (no griefing a stranger's bond or reputation)", () => {
    it("a proposal locks nothing until the worker accepts", async () => {
      const jobId = await postJob(workerId, usd(10), 0n, 0, 0, 3600, false);
      expect(await bond.locked(worker.address)).to.equal(0n);
      expect((await jobBoard.getJob(jobId)).status).to.equal(6n); // Proposed
      await jobBoard.connect(worker).accept(jobId);
      expect(await bond.locked(worker.address)).to.equal(usd(5));
      expect((await jobBoard.getJob(jobId)).status).to.equal(1n); // Open
    });
    it("only the named worker can accept; only the client can cancel; accepted jobs can't be cancelled", async () => {
      const jobId = await postJob(workerId, usd(4), 0n, 0, 0, 3600, false);
      await expect(jobBoard.connect(fraud).accept(jobId)).to.be.revertedWith("not worker");
      await expect(jobBoard.connect(worker).cancel(jobId)).to.be.revertedWith("not client");
      await jobBoard.connect(worker).accept(jobId);
      await expect(jobBoard.connect(client).cancel(jobId)).to.be.revertedWith("not proposed");
    });
    it("an un-accepted proposal expires with a refund and NO reputation hit", async () => {
      const jobId = await postJob(workerId, usd(6), 0n, 0, 0, 100, false);
      const c0 = await usdc.balanceOf(client.address);
      await time.increase(200);
      await jobBoard.connect(owner).expire(jobId);
      expect((await usdc.balanceOf(client.address)) - c0).to.equal(usd(6));
      expect(await reputation.scoreOf(workerId)).to.equal(0n);
      expect((await jobBoard.getJob(jobId)).status).to.equal(7n); // Cancelled
    });
    it("deadlines are capped (a job can't park a bond for years)", async () => {
      const far = (await time.latest()) + 31 * 24 * 3600;
      await usdc.connect(client).approve(jobBoard.target, usd(2));
      await expect(
        jobBoard.connect(client).postJob(workerId, validatorId, 0n, 0, 0, usd(2), far, ethers.id("s"))
      ).to.be.revertedWith("deadline too far");
    });
  });

  describe("Validator liveness (no stranded escrow)", () => {
    it("an unanswered submission unwinds after the window: refund + unlock, no reputation change", async () => {
      const jobId = await postJob(workerId, usd(8));
      await jobBoard.connect(worker).submit(jobId, ANS);
      await expect(jobBoard.connect(owner).timeoutValidation(jobId)).to.be.revertedWith("validation window open");
      await time.increase(24 * 3600 + 1);
      await expect(jobBoard.connect(validatorAcct).validate(jobId, ANS)).to.be.revertedWith("validation window closed");
      const c0 = await usdc.balanceOf(client.address);
      await jobBoard.connect(owner).timeoutValidation(jobId);
      expect((await usdc.balanceOf(client.address)) - c0).to.equal(usd(8));
      expect(await bond.locked(worker.address)).to.equal(0n);
      expect(await reputation.scoreOf(workerId)).to.equal(0n);
      expect((await jobBoard.getJob(jobId)).status).to.equal(5n);
    });
    it("completed jobs accrue the worker's credit basis = validator fees paid to the curated validator", async () => {
      const jobId = await postJob(workerId, usd(10), brokerId, 500, 300);
      await jobBoard.connect(worker).submit(jobId, ANS);
      await jobBoard.connect(validatorAcct).validate(jobId, ANS);
      expect(await jobBoard.creditBasis(workerId)).to.equal(usd(0.3));
    });
  });

  describe("Lock/slash accounting + edge cases", () => {
    it("rejects a job too small to collateralize (amount/2 == 0)", async () => {
      const deadline = (await time.latest()) + 3600;
      await usdc.connect(client).approve(jobBoard.target, 1n);
      await expect(
        jobBoard.connect(client).postJob(workerId, validatorId, 0n, 0, 0, 1n, deadline, ethers.id("s"))
      ).to.be.revertedWith("amount too small to collateralize");
    });

    it("tracks locked bond across two concurrent jobs (complete one, slash the other)", async () => {
      const job1 = await postJob(workerId, usd(10));
      const job2 = await postJob(workerId, usd(10));
      expect(await bond.locked(worker.address)).to.equal(usd(10)); // 5 + 5 locked

      await jobBoard.connect(worker).submit(job1, ANS);
      await jobBoard.connect(validatorAcct).validate(job1, ANS); // pass → unlock 5
      expect(await bond.locked(worker.address)).to.equal(usd(5));

      const fb0 = await bond.bondOf(worker.address);
      await jobBoard.connect(worker).submit(job2, WRONG);
      await jobBoard.connect(validatorAcct).validate(job2, ANS); // fail → slash exactly job2's lock
      expect(await bond.locked(worker.address)).to.equal(0n);
      expect(fb0 - (await bond.bondOf(worker.address))).to.equal(usd(5));
    });

    it("a Submitted job cannot be expired — must be validated (closes the post-deadline slash-dodge)", async () => {
      const job = await postJob(workerId, usd(8), 0n, 0, 0, 100);
      await jobBoard.connect(worker).submit(job, WRONG);
      await time.increase(200);
      await expect(jobBoard.connect(worker).expire(job)).to.be.revertedWith("only open jobs are expirable");
      await jobBoard.connect(validatorAcct).validate(job, ANS); // validate has no deadline → fail/slash still applies
      expect((await jobBoard.getJob(job)).status).to.equal(4n); // Rejected
    });
  });
});
