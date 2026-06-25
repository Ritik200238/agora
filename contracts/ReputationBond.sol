// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ReputationBond — reputation-as-collateral.
/// @notice Agents post a USDC bond; fraud or under-delivery lets an authorized slasher (the JobBoard)
///         seize part of it and pay the wronged party. Trust becomes economically expensive to fake.
contract ReputationBond is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    mapping(address => uint256) public bonds;     // agent wallet -> posted bond
    mapping(address => bool) public slashers;     // authorized to slash (the JobBoard)

    event BondPosted(address indexed agent, uint256 amount, uint256 total);
    event BondWithdrawn(address indexed agent, uint256 amount, uint256 total);
    event Slashed(address indexed agent, uint256 amount, address indexed beneficiary);
    event SlasherSet(address indexed slasher, bool allowed);

    constructor(IERC20 _usdc) Ownable(msg.sender) {
        usdc = _usdc;
    }

    function setSlasher(address s, bool allowed) external onlyOwner {
        slashers[s] = allowed;
        emit SlasherSet(s, allowed);
    }

    modifier onlySlasher() {
        require(slashers[msg.sender], "not slasher");
        _;
    }

    function postBond(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        bonds[msg.sender] += amount;
        emit BondPosted(msg.sender, amount, bonds[msg.sender]);
    }

    function withdraw(uint256 amount) external {
        require(bonds[msg.sender] >= amount, "insufficient bond");
        bonds[msg.sender] -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit BondWithdrawn(msg.sender, amount, bonds[msg.sender]);
    }

    /// @notice Slash up to `amount` from `agent`'s bond, paying the seized funds to `beneficiary`.
    /// @return slashed The amount actually seized (capped at the agent's bond).
    function slash(address agent, uint256 amount, address beneficiary) external onlySlasher returns (uint256 slashed) {
        uint256 b = bonds[agent];
        slashed = amount > b ? b : amount;
        if (slashed > 0) {
            bonds[agent] = b - slashed;
            usdc.safeTransfer(beneficiary, slashed);
        }
        emit Slashed(agent, slashed, beneficiary);
    }

    function bondOf(address agent) external view returns (uint256) {
        return bonds[agent];
    }
}
