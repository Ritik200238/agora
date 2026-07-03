// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IdentityRegistry} from "./IdentityRegistry.sol";
import {ReputationRegistry} from "./ReputationRegistry.sol";
import {ReputationBond} from "./ReputationBond.sol";

/// @title LendingPool — a reputation-backed credit market.
/// @notice Lenders deposit USDC; agents borrow working capital UNDER-COLLATERALIZED against their on-chain
///         reputation (credit limit = f(reputation)), posting only a fraction as bond collateral. Interest
///         accrues to lenders. On default (past due), the pool recovers by slashing the locked collateral
///         and tanking the borrower's reputation — so credit access is earned and abuse is punished.
/// @dev    One active loan per borrower at a time. The pool is a ReputationBond manager + a
///         ReputationRegistry reporter (wired at deploy; ownership then renounced).
contract LendingPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    IdentityRegistry public immutable identity;
    ReputationRegistry public immutable reputation;
    ReputationBond public immutable bond;

    uint16 public constant INTEREST_BPS = 500; // 5% origination interest
    uint16 public constant COLLATERAL_BPS = 2000; // borrower posts 20% as bond collateral (5x leverage on rep)
    uint64 public constant LOAN_TERM = 5000; // blocks until a loan is "due" and can be recovered
    int256 public constant REP_DEFAULT = -40; // reputation hit on default

    mapping(address => uint256) public deposits; // lender → deposited
    mapping(address => uint256) public debt; // borrower → outstanding (principal + interest)
    mapping(address => uint256) public loanFee; // borrower → the interest portion of the active loan
    mapping(address => uint256) public collateral; // borrower → bond locked for the active loan
    mapping(address => uint64) public dueBlock; // borrower → block after which the loan can be recovered

    uint256 public totalDeposits;
    uint256 public totalBorrowed; // cumulative principal lent
    uint256 public interestEarned; // cumulative interest collected
    uint256 public defaults;

    event Deposited(address indexed lender, uint256 amount, uint256 total);
    event Withdrawn(address indexed lender, uint256 amount, uint256 total);
    event Borrowed(address indexed borrower, uint256 principal, uint256 fee, uint256 debt);
    event Repaid(address indexed borrower, uint256 amount, uint256 debt);
    event Defaulted(address indexed borrower, uint256 recovered, uint256 writtenOff);

    constructor(IERC20 _usdc, IdentityRegistry _identity, ReputationRegistry _reputation, ReputationBond _bond) {
        usdc = _usdc;
        identity = _identity;
        reputation = _reputation;
        bond = _bond;
    }

    function liquidity() public view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Credit limit as a function of on-chain reputation. Negative reputation → no credit.
    function creditLimit(uint256 agentId) public view returns (uint256) {
        int256 score = reputation.scoreOf(agentId);
        if (score < 0) return 0;
        uint256 s = uint256(score);
        if (s > 300) s = 300;
        return 2e6 + s * 5e4; // base $2 + $0.05 per reputation point (up to $17)
    }

    function deposit(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        deposits[msg.sender] += amount;
        totalDeposits += amount;
        emit Deposited(msg.sender, amount, deposits[msg.sender]);
    }

    function withdraw(uint256 amount) external nonReentrant {
        require(deposits[msg.sender] >= amount, "exceeds deposit");
        require(liquidity() >= amount, "insufficient free liquidity");
        deposits[msg.sender] -= amount;
        totalDeposits -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, deposits[msg.sender]);
    }

    /// @notice Borrow `principal` against reputation. Posts COLLATERAL_BPS of it as locked bond.
    function borrow(uint256 principal) external nonReentrant {
        require(debt[msg.sender] == 0, "repay existing loan first");
        require(principal > 0, "principal=0");
        uint256 agentId = identity.agentOf(msg.sender);
        require(agentId != 0, "not registered");

        uint256 fee = (principal * INTEREST_BPS) / 10000;
        uint256 owed = principal + fee;
        require(owed <= creditLimit(agentId), "exceeds credit limit");
        require(liquidity() >= principal, "insufficient pool liquidity");

        uint256 coll = (principal * COLLATERAL_BPS) / 10000;
        bond.lock(msg.sender, coll); // reverts if the borrower lacks free bond collateral

        debt[msg.sender] = owed;
        loanFee[msg.sender] = fee;
        collateral[msg.sender] = coll;
        dueBlock[msg.sender] = uint64(block.number) + LOAN_TERM;
        totalBorrowed += principal;

        usdc.safeTransfer(msg.sender, principal);
        emit Borrowed(msg.sender, principal, fee, owed);
    }

    /// @notice Repay (up to) the outstanding debt. Full repayment unlocks the collateral + books interest.
    function repay(uint256 amount) external nonReentrant {
        uint256 d = debt[msg.sender];
        require(d > 0, "no debt");
        uint256 pay = amount > d ? d : amount;
        usdc.safeTransferFrom(msg.sender, address(this), pay);
        debt[msg.sender] = d - pay;

        if (debt[msg.sender] == 0) {
            interestEarned += loanFee[msg.sender];
            loanFee[msg.sender] = 0;
            uint256 coll = collateral[msg.sender];
            collateral[msg.sender] = 0;
            dueBlock[msg.sender] = 0;
            if (coll > 0) bond.unlock(msg.sender, coll);
        }
        emit Repaid(msg.sender, pay, debt[msg.sender]);
    }

    /// @notice Recover a defaulted (past-due, unpaid) loan: slash the locked collateral to the pool and
    ///         tank the borrower's reputation. Any shortfall is written off (bad debt).
    function recover(address borrower) external nonReentrant {
        require(debt[borrower] > 0, "no debt");
        require(block.number > dueBlock[borrower] && dueBlock[borrower] != 0, "not past due");

        uint256 coll = collateral[borrower];
        uint256 recovered = coll > 0 ? bond.slash(borrower, coll, address(this)) : 0;
        uint256 owed = debt[borrower];
        uint256 writtenOff = owed > recovered ? owed - recovered : 0;

        collateral[borrower] = 0;
        loanFee[borrower] = 0;
        debt[borrower] = 0;
        dueBlock[borrower] = 0;
        defaults += 1;

        uint256 agentId = identity.agentOf(borrower);
        if (agentId != 0) reputation.giveFeedback(agentId, REP_DEFAULT, false, bytes32(uint256(uint160(borrower))));
        emit Defaulted(borrower, recovered, writtenOff);
    }
}
