// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC — a 6-decimal ERC-20 used as USDC on the LOCAL chain.
/// @dev On Arc Testnet, the real USDC (0x3600...0000, the native gas token) is used instead;
///      this mock exists only so the economy can run + be fully tested on a local Hardhat node.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin (Mock)", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Open faucet for local testing — mirrors the free Arc faucet.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
