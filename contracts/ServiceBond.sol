// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ServiceBond — reputation-as-collateral at the MARKETPLACE layer.
/// @notice A third-party seller who lists a pay-per-use service can stake USDC behind it. Buyers (and their
///         agents) can then filter the marketplace to "bonded only" and know that a service which misbehaves
///         loses real money: the Agora gateway (a `manager`) slashes a bad service's stake to a neutral
///         treasury. This makes trust *economic*, not just a star rating — the exact moat a plain API
///         directory can't copy.
/// @dev    Distinct from ReputationBond (which collateralises internal JobBoard work). Bonds are keyed by the
///         seller's payout address (`payTo`). Post-deploy the deployer registers the gateway operator as the
///         sole manager and then renounces ownership, so no key can ever add a rogue slasher (see deploy.js).
contract ServiceBond is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    mapping(address => uint256) public bonds; // seller payTo => staked USDC
    mapping(address => bool) public managers; // authorized to slash (the Agora gateway operator)
    address public treasury; // neutral sink for slashed stake (never a marketplace party)
    uint256 public totalSlashed; // lifetime slashed, for transparency

    event Bonded(address indexed seller, uint256 amount, uint256 total);
    event Unbonded(address indexed seller, uint256 amount, uint256 total);
    event Slashed(address indexed seller, uint256 amount, address indexed to, string reason);
    event ManagerSet(address indexed manager, bool allowed);

    constructor(IERC20 _usdc, address _treasury) Ownable(msg.sender) {
        usdc = _usdc;
        treasury = _treasury;
    }

    function setManager(address m, bool allowed) external onlyOwner {
        managers[m] = allowed;
        emit ManagerSet(m, allowed);
    }

    modifier onlyManager() {
        require(managers[msg.sender], "not manager");
        _;
    }

    /// @notice Seller stakes USDC behind their listed service (approve this contract first).
    ///         A bigger, older, un-slashed stake reads as a stronger trust signal in the marketplace.
    function bond(uint256 amount) external {
        require(amount > 0, "amount=0");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        bonds[msg.sender] += amount;
        emit Bonded(msg.sender, amount, bonds[msg.sender]);
    }

    /// @notice Seller withdraws their remaining (un-slashed) stake at any time.
    /// @dev    Withdrawing drops the service's trust signal — the honest trade-off for pulling skin out.
    function unbond(uint256 amount) external {
        require(amount > 0 && amount <= bonds[msg.sender], "exceeds bond");
        bonds[msg.sender] -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Unbonded(msg.sender, amount, bonds[msg.sender]);
    }

    /// @notice The gateway slashes up to `amount` of a misbehaving service's stake to the treasury.
    /// @dev    Capped at the seller's current bond, so a slash can never revert for over-seizure. Returns the
    ///         amount actually seized (0 if the seller has no stake left).
    function slash(address seller, uint256 amount, string calldata reason)
        external
        onlyManager
        returns (uint256 slashed)
    {
        uint256 b = bonds[seller];
        slashed = amount > b ? b : amount;
        if (slashed > 0) {
            bonds[seller] = b - slashed;
            totalSlashed += slashed;
            usdc.safeTransfer(treasury, slashed);
        }
        emit Slashed(seller, slashed, treasury, reason);
    }

    function bondOf(address seller) external view returns (uint256) {
        return bonds[seller];
    }
}
