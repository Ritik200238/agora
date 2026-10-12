// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IdentityRegistry} from "./IdentityRegistry.sol";
import {ReputationRegistry} from "./ReputationRegistry.sol";
import {ReputationBond} from "./ReputationBond.sol";
import {JobBoard} from "./JobBoard.sol";

/// @title LendingPool — a track-record-backed credit market.
/// @notice Lenders deposit USDC for pool SHARES; agents borrow working capital partly collateralized by their
///         bond. Interest raises the share price; defaults lower it — gains and losses are split pro rata, so no
///         lender can exit at full value while others eat a loss.
///
///         Credit is sized so that defaulting is never profitable:
///             limit      = CREDIT_MULT × creditBasis      (creditBasis = validator fees paid on the agent's
///                                                          completed jobs — a cost sunk to a curated third party)
///             collateral = COLLATERAL_BPS × principal
///             gain from default ≤ limit × (1 − collateral) = 2 × basis × 0.4 = 0.8 × basis  <  basis spent
///         The old design gave every fresh wallet a $2 limit against 20% collateral, which a sybil could
///         drain wallet by wallet; and reputation points were free to farm. Neither is spendable here.
/// @dev    One active loan per borrower. Times are in seconds (block counts vary wildly across chains).
///         The pool is a ReputationBond manager + a ReputationRegistry reporter (wired at deploy).
contract LendingPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    IdentityRegistry public immutable identity;
    ReputationRegistry public immutable reputation;
    ReputationBond public immutable bond;
    JobBoard public immutable jobBoard;

    uint16 public constant INTEREST_BPS = 500; // 5% origination interest
    uint16 public constant COLLATERAL_BPS = 6000; // borrower locks 60% of principal as bond collateral
    uint256 public constant CREDIT_MULT = 2; // limit = 2 × sunk third-party fees (see the inequality above)
    uint256 public constant MAX_CREDIT = 17e6; // $17 hard cap per borrower
    uint64 public constant LOAN_TERM = 1 days; // seconds until a loan is due and can be recovered
    int256 public constant REP_DEFAULT = -40; // reputation hit on default
    uint256 private constant VIRTUAL_SHARES = 1e6; // inflation-attack guard (OZ ERC-4626 virtual offset)
    uint256 private constant VIRTUAL_ASSETS = 1;

    // ---- lenders (shares) ----
    mapping(address => uint256) public sharesOf;
    uint256 public totalShares;

    // ---- borrowers ----
    mapping(address => uint256) public debt; // borrower → outstanding (principal + interest)
    mapping(address => uint256) public principalOf; // borrower → principal still outstanding
    mapping(address => uint256) public collateral; // borrower → bond locked for the active loan
    mapping(address => uint64) public dueAt; // borrower → timestamp after which the loan can be recovered
    uint256 public outstandingPrincipal; // Σ principalOf — counted as pool assets until repaid or written off

    // ---- lifetime stats (dashboard) ----
    uint256 public totalDeposits; // cumulative USDC deposited by lenders
    uint256 public totalBorrowed; // cumulative principal lent
    uint256 public interestEarned; // cumulative interest collected
    uint256 public defaults;
    uint256 public writtenOff; // cumulative bad debt (principal + fee) not recovered

    event Deposited(address indexed lender, uint256 assets, uint256 shares);
    event Withdrawn(address indexed lender, uint256 assets, uint256 shares);
    event Borrowed(address indexed borrower, uint256 principal, uint256 fee, uint256 debt, uint256 collateral);
    event Repaid(address indexed borrower, uint256 amount, uint256 debt);
    event Defaulted(address indexed borrower, uint256 recovered, uint256 writtenOff);

    constructor(IERC20 _usdc, IdentityRegistry _identity, ReputationRegistry _reputation, ReputationBond _bond, JobBoard _jobBoard) {
        usdc = _usdc;
        identity = _identity;
        reputation = _reputation;
        bond = _bond;
        jobBoard = _jobBoard;
    }

    /// @notice USDC sitting in the pool (what can be lent or withdrawn right now).
    function liquidity() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Everything lenders own: idle USDC + principal still out on loan.
    function totalAssets() public view returns (uint256) {
        return liquidity() + outstandingPrincipal;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return Math.mulDiv(assets, totalShares + VIRTUAL_SHARES, totalAssets() + VIRTUAL_ASSETS);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, totalAssets() + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
    }

    /// @notice A lender's current claim on the pool, in USDC (moves with interest and defaults).
    function balanceOf(address lender) external view returns (uint256) {
        return convertToAssets(sharesOf[lender]);
    }

    /// @notice Credit limit: 2× the third-party fees sunk into the agent's completed work, capped; 0 with
    ///         negative reputation.
    function creditLimit(uint256 agentId) public view returns (uint256) {
        if (reputation.scoreOf(agentId) < 0) return 0;
        uint256 limit = jobBoard.creditBasis(agentId) * CREDIT_MULT;
        return limit > MAX_CREDIT ? MAX_CREDIT : limit;
    }

    function deposit(uint256 assets) external nonReentrant returns (uint256 shares) {
        require(assets > 0, "amount=0");
        shares = convertToShares(assets); // priced BEFORE the transfer lands
        require(shares > 0, "deposit too small");
        usdc.safeTransferFrom(msg.sender, address(this), assets);
        sharesOf[msg.sender] += shares;
        totalShares += shares;
        totalDeposits += assets;
        emit Deposited(msg.sender, assets, shares);
    }

    /// @notice Withdraw `assets` USDC, burning the shares that are worth that much (rounded up, pool-favouring).
    function withdraw(uint256 assets) external nonReentrant returns (uint256 shares) {
        require(assets > 0, "amount=0");
        shares = Math.mulDiv(assets, totalShares + VIRTUAL_SHARES, totalAssets() + VIRTUAL_ASSETS, Math.Rounding.Ceil);
        require(sharesOf[msg.sender] >= shares, "exceeds balance");
        require(liquidity() >= assets, "insufficient free liquidity");
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        usdc.safeTransfer(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shares);
    }

    /// @notice Borrow `principal`, locking COLLATERAL_BPS of it from the borrower's free bond.
    function borrow(uint256 principal) external nonReentrant {
        require(debt[msg.sender] == 0, "repay existing loan first");
        require(principal > 0, "principal=0");
        uint256 agentId = identity.agentOf(msg.sender);
        require(agentId != 0, "not registered");

        uint256 fee = (principal * INTEREST_BPS) / 10000;
        uint256 owed = principal + fee;
        require(owed <= creditLimit(agentId), "exceeds credit limit");
        require(liquidity() >= principal, "insufficient pool liquidity");

        uint256 coll = Math.mulDiv(principal, COLLATERAL_BPS, 10000, Math.Rounding.Ceil);
        bond.lock(msg.sender, coll); // reverts if the borrower lacks free bond collateral

        debt[msg.sender] = owed;
        principalOf[msg.sender] = principal;
        collateral[msg.sender] = coll;
        dueAt[msg.sender] = uint64(block.timestamp) + LOAN_TERM;
        outstandingPrincipal += principal;
        totalBorrowed += principal;

        usdc.safeTransfer(msg.sender, principal);
        emit Borrowed(msg.sender, principal, fee, owed, coll);
    }

    /// @notice Repay (up to) the outstanding debt — principal first, then interest. Full repayment unlocks
    ///         the collateral. Interest raises every lender's share value.
    function repay(uint256 amount) external nonReentrant {
        uint256 d = debt[msg.sender];
        require(d > 0, "no debt");
        uint256 pay = amount > d ? d : amount;
        uint256 toPrincipal = pay > principalOf[msg.sender] ? principalOf[msg.sender] : pay;

        debt[msg.sender] = d - pay;
        principalOf[msg.sender] -= toPrincipal;
        outstandingPrincipal -= toPrincipal;
        interestEarned += pay - toPrincipal;

        uint256 coll;
        if (debt[msg.sender] == 0) {
            coll = collateral[msg.sender];
            collateral[msg.sender] = 0;
            dueAt[msg.sender] = 0;
        }
        usdc.safeTransferFrom(msg.sender, address(this), pay);
        if (coll > 0) bond.unlock(msg.sender, coll);
        emit Repaid(msg.sender, pay, debt[msg.sender]);
    }

    /// @notice Recover a defaulted (past-due, unpaid) loan: slash the locked collateral into the pool and tank
    ///         the borrower's reputation. Any shortfall lowers the share price for all lenders (pro rata).
    function recover(address borrower) external nonReentrant {
        require(debt[borrower] > 0, "no debt");
        require(dueAt[borrower] != 0 && block.timestamp > dueAt[borrower], "not past due");

        uint256 owed = debt[borrower];
        uint256 coll = collateral[borrower];
        outstandingPrincipal -= principalOf[borrower];
        collateral[borrower] = 0;
        principalOf[borrower] = 0;
        debt[borrower] = 0;
        dueAt[borrower] = 0;
        defaults += 1;

        uint256 recovered = coll > 0 ? bond.slash(borrower, coll, address(this)) : 0;
        uint256 shortfall = owed > recovered ? owed - recovered : 0;
        writtenOff += shortfall;

        uint256 agentId = identity.agentOf(borrower);
        if (agentId != 0) reputation.giveFeedback(agentId, REP_DEFAULT, false, bytes32(uint256(uint160(borrower))));
        emit Defaulted(borrower, recovered, shortfall);
    }
}
