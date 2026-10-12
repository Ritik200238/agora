// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ServiceBond — reputation-as-collateral at the MARKETPLACE layer.
/// @notice A third-party seller who lists a pay-per-use service can stake USDC behind it. Buyers (and their
///         agents) can then filter the marketplace to "bonded only" and know that a service which misbehaves
///         loses real money: the Agora gateway (a `manager`) slashes a bad service's stake into the buyer-
///         protection pool. Trust becomes economic, not a star rating.
/// @dev    Withdrawing is two-step with a delay: requestUnbond() moves stake out of the ACTIVE bond (the trust
///         signal drops immediately) into an unbonding queue that stays SLASHABLE until withdrawUnbonded() after
///         `unbondDelay`. Otherwise a seller could take buyers' money and pull the stake before the slash lands.
///         Bonds are keyed by the seller's payout address (`payTo`). The owner can rotate managers (so a leaked
///         gateway key can be revoked) but can never move a seller's funds.
contract ServiceBond is Ownable {
    using SafeERC20 for IERC20;

    struct Unbonding {
        uint256 amount;
        uint64 readyAt;
    }

    IERC20 public immutable usdc;
    address public immutable treasury; // neutral sink for slashed stake (the buyer-protection pool)
    uint64 public immutable unbondDelay; // seconds a stake stays slashable after the seller asks to leave

    mapping(address => uint256) public bonds; // seller payTo => ACTIVE staked USDC (the trust signal)
    mapping(address => Unbonding) public unbonding; // seller payTo => stake on its way out (still slashable)
    mapping(address => bool) public managers; // authorized to slash (the Agora gateway operator)
    uint256 public totalSlashed; // lifetime slashed, for transparency

    event Bonded(address indexed seller, uint256 amount, uint256 total);
    event UnbondRequested(address indexed seller, uint256 amount, uint256 pending, uint64 readyAt);
    event UnbondCancelled(address indexed seller, uint256 amount, uint256 total);
    event Unbonded(address indexed seller, uint256 amount, uint256 total);
    event Slashed(address indexed seller, uint256 amount, address indexed to, string reason);
    event ManagerSet(address indexed manager, bool allowed);

    constructor(IERC20 _usdc, address _treasury, uint64 _unbondDelay) Ownable(msg.sender) {
        require(_treasury != address(0), "treasury=0");
        usdc = _usdc;
        treasury = _treasury;
        unbondDelay = _unbondDelay;
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
    function bond(uint256 amount) external {
        require(amount > 0, "amount=0");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        bonds[msg.sender] += amount;
        emit Bonded(msg.sender, amount, bonds[msg.sender]);
    }

    /// @notice Start withdrawing: `amount` leaves the active bond now and becomes withdrawable after the delay.
    ///         Requesting more restarts the clock for the whole pending amount.
    function requestUnbond(uint256 amount) external {
        require(amount > 0 && amount <= bonds[msg.sender], "exceeds bond");
        bonds[msg.sender] -= amount;
        Unbonding storage u = unbonding[msg.sender];
        u.amount += amount;
        u.readyAt = uint64(block.timestamp) + unbondDelay;
        emit UnbondRequested(msg.sender, amount, u.amount, u.readyAt);
    }

    /// @notice Changed your mind: move everything pending back into the active bond.
    function cancelUnbond() external {
        uint256 amt = unbonding[msg.sender].amount;
        require(amt > 0, "nothing pending");
        delete unbonding[msg.sender];
        bonds[msg.sender] += amt;
        emit UnbondCancelled(msg.sender, amt, bonds[msg.sender]);
    }

    /// @notice Collect the unbonded stake once the delay has passed (whatever survived any slashes).
    function withdrawUnbonded() external {
        Unbonding memory u = unbonding[msg.sender];
        require(u.amount > 0, "nothing pending");
        require(block.timestamp >= u.readyAt, "still unbonding");
        delete unbonding[msg.sender];
        usdc.safeTransfer(msg.sender, u.amount);
        emit Unbonded(msg.sender, u.amount, bonds[msg.sender]);
    }

    /// @notice The gateway slashes up to `amount` of a misbehaving service's stake into the treasury — active
    ///         stake first, then stake that is mid-unbond. Capped at what exists, so it never reverts for
    ///         over-seizure. Returns the amount actually seized.
    function slash(address seller, uint256 amount, string calldata reason)
        external
        onlyManager
        returns (uint256 slashed)
    {
        uint256 b = bonds[seller];
        uint256 fromActive = amount > b ? b : amount;
        bonds[seller] = b - fromActive;
        uint256 rest = amount - fromActive;
        uint256 p = unbonding[seller].amount;
        uint256 fromPending = rest > p ? p : rest;
        unbonding[seller].amount = p - fromPending;
        slashed = fromActive + fromPending;
        if (slashed > 0) {
            totalSlashed += slashed;
            usdc.safeTransfer(treasury, slashed);
        }
        emit Slashed(seller, slashed, treasury, reason);
    }

    /// @notice ACTIVE stake — what the marketplace shows as the trust signal.
    function bondOf(address seller) external view returns (uint256) {
        return bonds[seller];
    }
}
