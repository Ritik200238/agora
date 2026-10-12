// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IIdentityRegistry {
    function register(string calldata role, string calldata uri) external returns (uint256);
}

/// @dev TEST ONLY. A contract wallet that tries to re-enter IdentityRegistry.register() from the ERC-721
///      receive hook to mint itself a second passport. Records whether the re-entry got through.
contract ReentrantRegistrant is IERC721Receiver {
    IIdentityRegistry public immutable registry;
    bool public reentered;
    bool public reentrySucceeded;

    constructor(IIdentityRegistry _registry) {
        registry = _registry;
    }

    function go() external {
        registry.register("worker", "ipfs://reentrant");
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        if (!reentered) {
            reentered = true;
            try registry.register("worker", "ipfs://second") returns (uint256) {
                reentrySucceeded = true;
            } catch {}
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}
