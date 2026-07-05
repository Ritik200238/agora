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
  if (network.name === "arcTestnet") {
    usdcAddr = process.env.ARC_USDC || ARC_USDC;
  } else {
    const mock = await dep("MockUSDC");
    usdcAddr = mock.target;
    usdcIsMock = true;
  }

  // Neutral sink for slashed collateral (never a job party). Override with TREASURY for Arc.
  const treasury = process.env.TREASURY || deployer.address;

  const identity = await dep("IdentityRegistry");
  const reputation = await dep("ReputationRegistry");
  const validation = await dep("ValidationRegistry");
  const bond = await dep("ReputationBond", usdcAddr);
  const jobBoard = await dep(
    "JobBoard",
    usdcAddr,
    identity.target,
    reputation.target,
    validation.target,
    bond.target,
    treasury
  );

  const lendingPool = await dep("LendingPool", usdcAddr, identity.target, reputation.target, bond.target);

  // Marketplace-layer collateral: sellers stake behind their pay-per-use service; the gateway can slash a
  // misbehaving one to the treasury. The gateway operator (the deployer key, which the gateway signs with) is
  // the sole manager. Override GATEWAY_OPERATOR for Arc if the live gateway runs under a different key.
  const serviceBond = await dep("ServiceBond", usdcAddr, treasury);
  const gatewayOperator = process.env.GATEWAY_OPERATOR || deployer.address;

  // Authority: the JobBoard + LendingPool may report reputation + lock/slash bonds; JobBoard writes validations.
  await (await reputation.setReporter(jobBoard.target, true)).wait();
  await (await bond.setManager(jobBoard.target, true)).wait();
  await (await validation.initialize(jobBoard.target)).wait();
  await (await reputation.setReporter(lendingPool.target, true)).wait();
  await (await bond.setManager(lendingPool.target, true)).wait();
  await (await serviceBond.setManager(gatewayOperator, true)).wait();

  // Lock it down: renounce ownership so NO key (incl. the deployer) can add a rogue reporter/manager
  // and forge reputation or drain bonds. Authority is now immutable.
  await (await reputation.renounceOwnership()).wait();
  await (await bond.renounceOwnership()).wait();
  await (await serviceBond.renounceOwnership()).wait();

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
    gatewayOperator,
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
