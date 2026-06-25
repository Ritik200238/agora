const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// USDC has 6 decimals
const usd = (n) => BigInt(Math.round(n * 1e6));

describe("Agora contracts", function () {
  let usdc, identity, reputation, validation, bond, jobBoard;
  let owner, client, worker, validatorAcct, broker, fraud;
  let workerId, validatorId, brokerId, clientId, fraudId;

  async function deploy(name, ...args) {
    const f = await ethers.getContractFactory(name);
    const c = await f.deploy(...args);
    await c.waitForDeployment();
    return c;
  }

  beforeEach(async () => {
    [owner, client, worker, validatorAcct, broker, fraud] = await ethers.getSigners();

    usdc = await deploy("MockUSDC");
    identity = await deploy("IdentityRegistry");
    reputation = await deploy("ReputationRegistry");
    validation = await deploy("ValidationRegistry");
    bond = await deploy("ReputationBond", usdc.target);
    jobBoard = await deploy(
      "JobBoard",
      usdc.target,
      identity.target,
      reputation.target,
      validation.target,
      bond.target
    );

    // wire authority: JobBoard may report reputation + slash bonds
    await reputation.setReporter(jobBoard.target, true);
    await bond.setSlasher(jobBoard.target, true);

    // register the cast
    await identity.connect(client).register("consumer", "ipfs://client");
    await identity.connect(worker).register("worker", "ipfs://worker");
    await identity.connect(validatorAcct).register("validator", "ipfs://validator");
    await identity.connect(broker).register("broker", "ipfs://broker");
    await identity.connect(fraud).register("worker", "ipfs://fraud");

    clientId = await identity.agentOf(client.address);
    workerId = await identity.agentOf(worker.address);
    validatorId = await identity.agentOf(validatorAcct.address);
    brokerId = await identity.agentOf(broker.address);
    fraudId = await identity.agentOf(fraud.address);

    // seed balances + a worker bond
    await usdc.mint(client.address, usd(1000));
    await usdc.mint(worker.address, usd(100));
    await usdc.mint(fraud.address, usd(100));
    await usdc.connect(worker).approve(bond.target, usd(50));
    await bond.connect(worker).postBond(usd(50));
    await usdc.connect(fraud).approve(bond.target, usd(20));
    await bond.connect(fraud).postBond(usd(20));
  });

  async function postJob(workerAgentId, amount, brokerAgentId = 0n, brokerBps = 0, valBps = 0, ttl = 3600) {
    const deadline = (await time.latest()) + ttl;
    await usdc.connect(client).approve(jobBoard.target, amount);
    const tx = await jobBoard
      .connect(client)
      .postJob(workerAgentId, validatorId, brokerAgentId, brokerBps, valBps, amount, deadline, ethers.id("spec"));
    const rc = await tx.wait();
    // jobId is the nextJobId-1; read it back
    return (await jobBoard.nextJobId()) - 1n;
  }

  describe("IdentityRegistry", () => {
    it("mints a passport per wallet with role + owner", async () => {
      expect(await identity.ownerOf(workerId)).to.equal(worker.address);
      expect(await identity.role(workerId)).to.equal("worker");
      expect(await identity.isRegistered(worker.address)).to.equal(true);
    });
    it("rejects double registration", async () => {
      await expect(identity.connect(worker).register("worker", "x")).to.be.revertedWith("already registered");
    });
  });

  describe("Happy path — validate(pass)", () => {
    it("escrows, pays worker+broker+validator splits, raises reputation", async () => {
      const amount = usd(10);
      const jobId = await postJob(workerId, amount, brokerId, 500 /*5%*/, 300 /*3%*/);

      // escrow held
      expect(await usdc.balanceOf(jobBoard.target)).to.equal(amount);

      const w0 = await usdc.balanceOf(worker.address);
      const b0 = await usdc.balanceOf(broker.address);
      const v0 = await usdc.balanceOf(validatorAcct.address);

      await jobBoard.connect(worker).submit(jobId, ethers.id("deliverable"));
      await jobBoard.connect(validatorAcct).validate(jobId, true);

      const brokerFee = (amount * 500n) / 10000n; // 0.5
      const valFee = (amount * 300n) / 10000n; // 0.3
      const workerPay = amount - brokerFee - valFee; // 9.2

      expect((await usdc.balanceOf(worker.address)) - w0).to.equal(workerPay);
      expect((await usdc.balanceOf(broker.address)) - b0).to.equal(brokerFee);
      expect((await usdc.balanceOf(validatorAcct.address)) - v0).to.equal(valFee);

      expect(await reputation.scoreOf(workerId)).to.equal(10n);
      expect(await jobBoard.totalSettled()).to.equal(workerPay);
      expect(await jobBoard.jobsCompleted()).to.equal(1n);

      const job = await jobBoard.getJob(jobId);
      expect(job.status).to.equal(3n); // Completed
      // escrow drained
      expect(await usdc.balanceOf(jobBoard.target)).to.equal(0n);
    });
  });

  describe("Fraud path — validate(fail) slashes the bond", () => {
    it("refunds client, slashes worker bond to validator, tanks reputation", async () => {
      const amount = usd(8);
      const jobId = await postJob(fraudId, amount); // no broker, no fees

      const c0 = await usdc.balanceOf(client.address);
      const v0 = await usdc.balanceOf(validatorAcct.address);
      const fraudBond0 = await bond.bondOf(fraud.address); // 20

      await jobBoard.connect(fraud).submit(jobId, ethers.id("garbage"));
      await jobBoard.connect(validatorAcct).validate(jobId, false);

      // client fully refunded
      expect((await usdc.balanceOf(client.address)) - c0).to.equal(amount);
      // penalty = amount/2 = 4, slashed to validator
      const penalty = amount / 2n;
      expect((await usdc.balanceOf(validatorAcct.address)) - v0).to.equal(penalty);
      expect(fraudBond0 - (await bond.bondOf(fraud.address))).to.equal(penalty);

      expect(await reputation.scoreOf(fraudId)).to.equal(-25n);
      expect(await jobBoard.jobsRejected()).to.equal(1n);
      const job = await jobBoard.getJob(jobId);
      expect(job.status).to.equal(4n); // Rejected
    });

    it("slash is capped at the available bond", async () => {
      // give fraud a tiny bond by withdrawing most of it
      await bond.connect(fraud).withdraw(usd(19)); // bond now 1
      const amount = usd(8); // penalty would be 4, but bond is only 1
      const jobId = await postJob(fraudId, amount);
      const v0 = await usdc.balanceOf(validatorAcct.address);
      await jobBoard.connect(fraud).submit(jobId, ethers.id("garbage"));
      await jobBoard.connect(validatorAcct).validate(jobId, false);
      expect((await usdc.balanceOf(validatorAcct.address)) - v0).to.equal(usd(1)); // capped
      expect(await bond.bondOf(fraud.address)).to.equal(0n);
    });
  });

  describe("Expiry", () => {
    it("refunds client + dings worker reputation after deadline", async () => {
      const amount = usd(5);
      const jobId = await postJob(workerId, amount, 0n, 0, 0, 100 /*ttl*/);
      const c0 = await usdc.balanceOf(client.address);
      await time.increase(200);
      await jobBoard.connect(owner).expire(jobId); // anyone can expire
      expect((await usdc.balanceOf(client.address)) - c0).to.equal(amount);
      expect(await reputation.scoreOf(workerId)).to.equal(-5n);
      expect(await jobBoard.jobsExpired()).to.equal(1n);
      const job = await jobBoard.getJob(jobId);
      expect(job.status).to.equal(5n); // Expired
    });
  });

  describe("Authorization guards", () => {
    it("reputation: only reporters can give feedback", async () => {
      await expect(
        reputation.connect(owner).giveFeedback(workerId, 1, true, ethers.id("x"))
      ).to.be.revertedWith("not reporter");
    });
    it("bond: only slashers can slash", async () => {
      await expect(
        bond.connect(owner).slash(worker.address, 1, owner.address)
      ).to.be.revertedWith("not slasher");
    });
    it("job: only the worker can submit", async () => {
      const jobId = await postJob(workerId, usd(2));
      await expect(jobBoard.connect(broker).submit(jobId, ethers.id("x"))).to.be.revertedWith("not worker");
    });
    it("job: only the validator can validate", async () => {
      const jobId = await postJob(workerId, usd(2));
      await jobBoard.connect(worker).submit(jobId, ethers.id("x"));
      await expect(jobBoard.connect(broker).validate(jobId, true)).to.be.revertedWith("not validator");
    });
    it("job: worker cannot equal client", async () => {
      const deadline = (await time.latest()) + 3600;
      await usdc.connect(client).approve(jobBoard.target, usd(1));
      await expect(
        jobBoard.connect(client).postJob(clientId, validatorId, 0n, 0, 0, usd(1), deadline, ethers.id("s"))
      ).to.be.revertedWith("worker == client");
    });
  });
});
