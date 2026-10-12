// Deploys the full Agora contract suite and wires authority.
// Local networks deploy MockUSDC; Arc Testnet uses the real native USDC at 0x3600...0000.
// Writes deployments/<network>.json for the agent runtime to read.
const hre = require("hardhat");
const { ethers, network } = hre;
const fs = require("fs");
const path = require("path");

const ARC_USDC = "0x3600000000000000000000000000000000000000";

async function dep(name, ...args) {
  const f = await ethers.getContractFactory(name);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return c;
}

async function deployAll() {
  const [deployer] = await ethers.getSigners();

  let usdcAddr;
  let usdcIsMock = false;
  if (network.name === "arcTestnet" || network.name === "arcMainnet") {
    usdcAddr = process.env.ARC_USDC || ARC_USDC;
  } else {
    const mock = await dep("MockUSDC");
    usdcAddr = mock.target;
    usdcIsMock = true;
  }

  const identity = await dep("IdentityRegistry");
  const reputation = await dep("ReputationRegistry");
  const validation = await dep("ValidationRegistry");
  const bond = await dep("ReputationBond", usdcAddr);

  // Buyer-protection insurance pool, deployed FIRST so every slash (marketplace AND job fraud) lands in it.
  // The gateway's hot key pays claims out of it, so payouts are capped per claim and per 24h on-chain.
  const maxPayout = BigInt(process.env.INSURANCE_MAX_PAYOUT_UNITS || 5_000_000); // $5 per claim
  const maxPerDay = BigInt(process.env.INSURANCE_MAX_PER_DAY_UNITS || 50_000_000); // $50 per day
  const insurancePool = await dep("InsurancePool", usdcAddr, maxPayout, maxPerDay);
  const treasury = insurancePool.target; // neutral sink for slashed collateral (never a job party)

  const jobBoard = await dep(
    "JobBoard",
    usdcAddr,
    identity.target,
    reputation.target,
    validation.target,
    bond.target,
    treasury
  );
  const lendingPool = await dep("LendingPool", usdcAddr, identity.target, reputation.target, bond.target, jobBoard.target);

  // Marketplace-layer collateral: sellers stake behind their pay-per-use service; the gateway can slash a
  // misbehaving one straight into the insurance pool. Unbonding waits UNBOND_DELAY_SECONDS (stake stays
  // slashable meanwhile). The gateway operator (the key the gateway signs with) is the manager.
  const unbondDelay = BigInt(process.env.UNBOND_DELAY_SECONDS || 3 * 24 * 3600);
  const serviceBond = await dep("ServiceBond", usdcAddr, treasury, unbondDelay);
  const gatewayOperator = process.env.GATEWAY_OPERATOR || deployer.address;

  // Authority: the JobBoard + LendingPool may report reputation + lock/slash bonds; JobBoard writes validations.
  await (await reputation.setReporter(jobBoard.target, true)).wait();
  await (await bond.setManager(jobBoard.target, true)).wait();
  await (await validation.initialize(jobBoard.target)).wait();
  await (await reputation.setReporter(lendingPool.target, true)).wait();
  await (await bond.setManager(lendingPool.target, true)).wait();
  await (await serviceBond.setManager(gatewayOperator, true)).wait();
  await (await insurancePool.setManager(gatewayOperator, true)).wait();

  // Lock down what only contracts should ever touch: renounce, so NO key can add a rogue reporter/manager
  // and forge reputation or seize job bonds.
  await (await reputation.renounceOwnership()).wait();
  await (await bond.renounceOwnership()).wait();
  // Keep an ADMIN on the three contracts whose authority is a human/hot-key decision: the curated validator
  // set (IdentityRegistry) and the gateway manager on ServiceBond + InsurancePool — so a leaked gateway key
  // can be revoked and rotated. The admin can't move anyone's funds. Set ADMIN to a multisig in production.
  const admin = process.env.ADMIN || deployer.address;
  if (admin.toLowerCase() !== deployer.address.toLowerCase()) {
    await (await identity.transferOwnership(admin)).wait();
    await (await serviceBond.transferOwnership(admin)).wait();
    await (await insurancePool.transferOwnership(admin)).wait();
  }

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    usdc: usdcAddr,
    usdcIsMock,
    treasury,
    identity: identity.target,
    reputation: reputation.target,
    validation: validation.target,
    bond: bond.target,
    jobBoard: jobBoard.target,
    lendingPool: lendingPool.target,
    serviceBond: serviceBond.target,
    insurancePool: insurancePool.target,
    gatewayOperator,
    admin,
    unbondDelaySeconds: Number(unbondDelay),
    insuranceCaps: { maxPayoutUnits: maxPayout.toString(), maxPerDayUnits: maxPerDay.toString() },
    deployer: deployer.address,
  };

  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2));
  return out;
}

async function main() {
  const out = await deployAll();
  console.log("Agora deployed:\n" + JSON.stringify(out, null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { deployAll };
