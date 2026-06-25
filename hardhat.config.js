require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-network-helpers");
require("dotenv").config();

const ARC_RPC = process.env.ARC_TESTNET_RPC || "https://rpc.testnet.arc.network";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    // In-process EVM used by `hardhat test`
    hardhat: { chainId: 31337 },
    // Standalone local node: `npm run chain`
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    // Arc Testnet (USDC is the native gas token; needs a faucet-funded key)
    arcTestnet: {
      url: ARC_RPC,
      chainId: 5042002,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test/contracts",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
