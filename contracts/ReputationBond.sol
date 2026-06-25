// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ReputationBond — reputation-as-collateral with in-flight LOCKING.
/// @notice Agents post a USDC bond. The JobBoard (a "manager") LOCKS a portion while a job is in flight,
///         so a worker cannot withdraw collateral mid-job to dodge a slash. On fraud the locked portion is
///         seized; on success it is unlocked. `withdraw` is restricted to the un-locked (available) balance.
/// @dev    Ownership is renounced post-deploy (see scripts/deploy.js) so no key can add a rogue manager.
contract ReputationBond is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    mapping(address => uint256) public bonds; // total posted
    mapping(address => uint256) public locked; // reserved for in-flight jobs
    mapping(address => bool) public managers; // authorized to lock/unlock/slash (the JobBoard)

    event BondPosted(address indexed agent, uint256 amount, uint256 total);
    event BondWithdrawn(address indexed agent, uint256 amount, uint256 total);
    event BondLocked(address indexed agent, uint256 amount, uint256 locked);
    event BondUnlocked(address indexed agent, uint256 amount, uint256 locked);
    event Slashed(address indexed agent, uint256 amount, address indexed beneficiary);
    event ManagerSet(address indexed manager, bool allowed);

    constructor(IERC20 _usdc) Ownable(msg.sender) {
        usdc = _usdc;
    }

    function setManager(address m, bool allowed) external onlyOwner {
        managers[m] = allowed;
        emit ManagerSet(m, allowed);
    }

    modifier onlyManager() {
        require(managers[msg.sender], "not manager");
        _;
    }

    /// @notice Bond that is NOT locked by an in-flight job — the only amount that can be withdrawn.
    function available(address agent) public view returns (uint256) {
        uint256 b = bonds[agent];
        uint256 l = locked[agent];
        return b > l ? b - l : 0;
    }

    function postBond(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        bonds[msg.sender] += amount;
        emit BondPosted(msg.sender, amount, bonds[msg.sender]);
    }

    function withdraw(uint256 amount) external {
        require(amount <= available(msg.sender), "exceeds available (locked)");
        bonds[msg.sender] -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit BondWithdrawn(msg.sender, amount, bonds[msg.sender]);
    }

    /// @notice Reserve `amount` of an agent's free bond for an in-flight job. Reverts if insufficient.
    function lock(address agent, uint256 amount) external onlyManager {
        require(available(agent) >= amount, "insufficient free bond");
        locked[agent] += amount;
        emit BondLocked(agent, amount, locked[agent]);
    }

    /// @notice Release previously-locked bond (job completed/expired without fraud).
    function unlock(address agent, uint256 amount) external onlyManager {
        uint256 l = locked[agent];
        uint256 u = amount > l ? l : amount;
        locked[agent] = l - u;
        emit BondUnlocked(agent, u, locked[agent]);
    }

    /// @notice Seize up to `amount` from the agent's LOCKED bond, paying it to `beneficiary`.
    /// @dev Because the JobBoard locks the penalty at postJob, the slashable amount is guaranteed reserved.
    function slash(address agent, uint256 amount, address beneficiary) external onlyManager returns (uint256 slashed) {
        uint256 l = locked[agent];
        slashed = amount > l ? l : amount;
        if (slashed > 0) {
            locked[agent] = l - slashed;
            bonds[agent] -= slashed;
            usdc.safeTransfer(beneficiary, slashed);
        }
        emit Slashed(agent, slashed, beneficiary);
    }

    function bondOf(address agent) external view returns (uint256) {
        return bonds[agent];
    }
}
