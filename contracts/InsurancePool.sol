// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title InsurancePool — the buyer-protection fund for the agent marketplace.
/// @notice Every dollar slashed from a misbehaving service (ServiceBond) or a fraudulent worker (JobBoard)
///         flows here, and the Agora gateway (a `manager`) pays it out to make wronged buyers whole. Bad actors
///         literally finance the insurance that protects the people they'd rip off.
/// @dev    The manager is a hot key on a public server, so its blast radius is bounded on-chain: each payout is
///         capped (`maxPayout`) and so is the total per rolling 24h window (`maxPerDay`). The owner can revoke
///         and rotate managers (a leaked key can be cut off) but has no payout power of its own.
contract InsurancePool is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    uint256 public immutable maxPayout; // per-claim ceiling
    uint256 public immutable maxPerDay; // ceiling across all payouts in a 24h window

    mapping(address => bool) public managers; // authorized to pay out (the gateway operator)
    uint256 public totalPaidOut; // lifetime refunds to buyers, for transparency
    uint64 public windowStart; // start of the current 24h window
    uint256 public paidInWindow; // paid out since windowStart

    event Funded(address indexed from, uint256 amount);
    event PaidOut(address indexed to, uint256 amount, string reason);
    event ManagerSet(address indexed manager, bool allowed);

    constructor(IERC20 _usdc, uint256 _maxPayout, uint256 _maxPerDay) Ownable(msg.sender) {
        require(_maxPayout > 0 && _maxPerDay >= _maxPayout, "bad caps");
        usdc = _usdc;
        maxPayout = _maxPayout;
        maxPerDay = _maxPerDay;
    }

    function setManager(address m, bool allowed) external onlyOwner {
        managers[m] = allowed;
        emit ManagerSet(m, allowed);
    }

    modifier onlyManager() {
        require(managers[msg.sender], "not manager");
        _;
    }

    /// @notice USDC available to cover claims right now (= everything the pool holds).
    function available() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice How much more can be paid out in the current 24h window.
    function remainingToday() public view returns (uint256) {
        if (block.timestamp >= uint256(windowStart) + 1 days) return maxPerDay;
        return maxPerDay - paidInWindow;
    }

    /// @notice Voluntarily top up the fund (approve first). Slashes also arrive here by direct transfer.
    function fund(uint256 amount) external {
        require(amount > 0, "amount=0");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    /// @notice The gateway refunds a wronged buyer from the pool, within the per-claim and daily caps. Pays what
    ///         the pool holds if that's less; returns the amount actually paid.
    function payout(address to, uint256 amount, string calldata reason)
        external
        onlyManager
        returns (uint256 paid)
    {
        require(amount <= maxPayout, "exceeds per-claim cap");
        if (block.timestamp >= uint256(windowStart) + 1 days) {
            windowStart = uint64(block.timestamp);
            paidInWindow = 0;
        }
        uint256 bal = available();
        paid = amount > bal ? bal : amount;
        require(paidInWindow + paid <= maxPerDay, "daily payout cap reached");
        if (paid > 0) {
            paidInWindow += paid;
            totalPaidOut += paid;
            usdc.safeTransfer(to, paid);
        }
        emit PaidOut(to, paid, reason);
    }
}
