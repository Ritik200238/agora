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
    bond.target
  );

  // Authority: only the JobBoard may report reputation + slash bonds.
  await (await reputation.setReporter(jobBoard.target, true)).wait();
  await (await bond.setSlasher(jobBoard.target, true)).wait();

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    usdc: usdcAddr,
    usdcIsMock,
    identity: identity.target,
    reputation: reputation.target,
    validation: validation.target,
    bond: bond.target,
    jobBoard: jobBoard.target,
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
