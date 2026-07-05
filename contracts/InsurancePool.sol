// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title InsurancePool — the buyer-protection fund for the agent marketplace.
/// @notice Every dollar slashed from a misbehaving service (ServiceBond) flows here, and the Agora gateway
///         (a `manager`) can pay it out to make a wronged buyer whole. So bad actors literally finance the
///         insurance that protects the people they'd rip off — the guarantee that lets an autonomous agent
///         spend without fear. Funds arrive by plain USDC transfer (ServiceBond slashes here) or via fund().
/// @dev    Post-deploy the deployer sets the gateway operator as the sole manager and renounces ownership,
///         so no key can add a rogue payer and drain the pool (see deploy.js).
contract InsurancePool is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    mapping(address => bool) public managers; // authorized to pay out (the gateway operator)
    uint256 public totalPaidOut; // lifetime refunds to buyers, for transparency

    event Funded(address indexed from, uint256 amount);
    event PaidOut(address indexed to, uint256 amount, string reason);
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

    /// @notice USDC available to cover claims right now (= everything the pool holds).
    function available() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Voluntarily top up the fund (approve first). Slashes also arrive here by direct transfer.
    function fund(uint256 amount) external {
        require(amount > 0, "amount=0");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    /// @notice The gateway refunds a wronged buyer from the pool. Capped at what the pool holds, so it can
    ///         never revert for over-payment; returns the amount actually paid (0 if the pool is empty).
    function payout(address to, uint256 amount, string calldata reason)
        external
        onlyManager
        returns (uint256 paid)
    {
        uint256 bal = available();
        paid = amount > bal ? bal : amount;
        if (paid > 0) {
            totalPaidOut += paid;
            usdc.safeTransfer(to, paid);
        }
        emit PaidOut(to, paid, reason);
    }
}
