require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-network-helpers");
require("dotenv").config();

const ARC_RPC = process.env.ARC_TESTNET_RPC || "https://rpc.testnet.arc.network";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const ARC_MAINNET_RPC = process.env.ARC_MAINNET_RPC || "https://rpc.mainnet.arc.io";
// a DEDICATED mainnet key (real USDC) — never the testnet key. npm run gen:arc-mainnet-key creates it.
const MAINNET_PRIVATE_KEY = process.env.MAINNET_PRIVATE_KEY;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // OpenZeppelin v5 uses the `mcopy` opcode → requires the Cancun EVM.
      // Arc (Reth) and the Hardhat local network both support Cancun.
      evmVersion: "cancun",
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
    // Arc MAINNET (chain 5042) — real USDC pays gas. Verified: rpc.mainnet.arc.io returns chainId 0x13b2.
    arcMainnet: {
      url: ARC_MAINNET_RPC,
      chainId: 5042,
      accounts: MAINNET_PRIVATE_KEY ? [MAINNET_PRIVATE_KEY] : [],
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test/contracts",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
