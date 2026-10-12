// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IdentityRegistry} from "./IdentityRegistry.sol";
import {ReputationRegistry} from "./ReputationRegistry.sol";
import {ValidationRegistry} from "./ValidationRegistry.sol";
import {ReputationBond} from "./ReputationBond.sol";

/// @title JobBoard — ERC-8183-style escrow wired to a REAL trust layer.
/// @notice Lifecycle: a client funds USDC escrow and PROPOSES the job to a worker → the worker ACCEPTS the
///         terms, which locks its collateral → the worker submits → a curated validator independently
///         re-executes and submits its answer hash; the contract DERIVES the verdict (deliverable == validator's
///         hash). Pass → pay + raise reputation + unlock bond. Fail → refund client + slash the locked bond to a
///         neutral treasury + tank reputation. Every state has an exit, so no funds can be stranded:
///           Proposed  → accept | cancel (client) | expire after deadline (refund, no penalty: never agreed)
///           Open      → submit | expire after deadline (refund, unlock, small rep hit: a no-show)
///           Submitted → validate | timeoutValidation after VALIDATION_WINDOW (refund, unlock, no penalty:
///                       the validator failed, not the worker)
/// @dev    Worker consent closes three griefing vectors of the old "client names any worker" design: locking a
///         stranger's bond until an arbitrary deadline, docking their reputation via expiry, and imposing fee
///         terms they never agreed to.
contract JobBoard is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // New states are APPENDED so existing status codes (Open=1 … Expired=5) keep their meaning off-chain.
    enum Status { None, Open, Submitted, Completed, Rejected, Expired, Proposed, Cancelled }

    struct Job {
        uint256 clientId;
        uint256 workerId;
        uint256 validatorId;
        uint256 brokerId;
        uint16 brokerFeeBps;
        uint16 validatorFeeBps;
        uint256 amount;
        uint256 bondLocked; // worker collateral reserved for this job (set on accept)
        uint64 deadline;
        uint64 submittedAt;
        bytes32 specHash;
        bytes32 deliverable;
        uint256 validationId;
        Status status;
    }

    IERC20 public immutable usdc;
    IdentityRegistry public immutable identity;
    ReputationRegistry public immutable reputation;
    ValidationRegistry public immutable validation;
    ReputationBond public immutable bond;
    address public immutable treasury; // neutral sink for slashed collateral (the buyer-protection pool)

    uint256 public nextJobId = 1;
    mapping(uint256 => Job) public jobs;

    /// @notice Validator fees paid on each worker's COMPLETED jobs. Those fees go to a curated third party, so
    ///         they are a cost nobody can route back to themselves — the LendingPool sizes credit off this.
    mapping(uint256 => uint256) public creditBasis;

    uint256 public totalSettled;
    uint256 public jobsCompleted;
    uint256 public jobsRejected;
    uint256 public jobsExpired;
    uint256 public totalSlashed;

    int256 public constant REP_PASS = 10;
    int256 public constant REP_FAIL = -25;
    int256 public constant REP_EXPIRE = -5;
    uint64 public constant MAX_DURATION = 30 days; // a job can't park a worker's bond indefinitely
    uint64 public constant VALIDATION_WINDOW = 1 days; // after this, an unanswered submission can be unwound

    event JobPosted(uint256 indexed jobId, uint256 indexed clientId, uint256 indexed workerId, uint256 brokerId, uint256 amount, uint256 bondRequired, bytes32 specHash);
    event JobAccepted(uint256 indexed jobId, uint256 workerId, uint256 bondLocked);
    event JobCancelled(uint256 indexed jobId, uint256 refunded);
    event JobSubmitted(uint256 indexed jobId, uint256 workerId, bytes32 deliverable, uint256 validationId);
    event JobCompleted(uint256 indexed jobId, uint256 workerId, uint256 workerPay, uint256 brokerFee, uint256 validatorFee);
    event JobRejected(uint256 indexed jobId, uint256 workerId, uint256 refunded, uint256 slashed);
    event JobExpired(uint256 indexed jobId, uint256 workerId, uint256 refunded);
    event ValidationTimedOut(uint256 indexed jobId, uint256 validatorId, uint256 refunded);

    constructor(
        IERC20 _usdc,
        IdentityRegistry _identity,
        ReputationRegistry _reputation,
        ValidationRegistry _validation,
        ReputationBond _bond,
        address _treasury
    ) {
        require(_treasury != address(0), "treasury=0");
        usdc = _usdc;
        identity = _identity;
        reputation = _reputation;
        validation = _validation;
        bond = _bond;
        treasury = _treasury;
    }

    /// @notice The worker collateral a job of `amount` requires (locked on accept, slashed on proven fraud).
    function bondRequired(uint256 amount) public pure returns (uint256) {
        return amount / 2;
    }

    /// @notice Client proposes a job (approve `amount` USDC first). Escrow is funded now; the worker's
    ///         collateral is only locked once the worker accepts.
    function postJob(
        uint256 workerId,
        uint256 validatorId,
        uint256 brokerId,
        uint16 brokerFeeBps,
        uint16 validatorFeeBps,
        uint256 amount,
        uint64 deadline,
        bytes32 specHash
    ) external nonReentrant returns (uint256 jobId) {
        uint256 clientId = identity.agentOf(msg.sender);
        require(clientId != 0, "client not registered");
        require(workerId != 0 && validatorId != 0, "bad parties");
        require(workerId != clientId, "worker == client");
        require(validatorId != workerId, "validator == worker");
        require(validatorId != clientId, "validator == client"); // no self-validation
        require(
            brokerId == 0 || (brokerId != clientId && brokerId != workerId && brokerId != validatorId),
            "broker not distinct"
        );
        identity.ownerOf(workerId); // fail-fast on an unregistered worker
        if (brokerId != 0) identity.ownerOf(brokerId); // …or broker
        // The validator must be a CURRENTLY approved member of the curated validator set.
        require(identity.isValidator(validatorId), "validator role required");
        require(amount > 0, "amount=0");
        require(bondRequired(amount) > 0, "amount too small to collateralize");
        require(uint256(brokerFeeBps) + uint256(validatorFeeBps) <= 5000, "fees too high");
        require(deadline > block.timestamp, "deadline past");
        require(deadline <= block.timestamp + MAX_DURATION, "deadline too far");
        if (brokerId == 0) require(brokerFeeBps == 0, "broker fee w/o broker");

        jobId = nextJobId++;
        jobs[jobId] = Job({
            clientId: clientId,
            workerId: workerId,
            validatorId: validatorId,
            brokerId: brokerId,
            brokerFeeBps: brokerFeeBps,
            validatorFeeBps: validatorFeeBps,
            amount: amount,
            bondLocked: 0,
            deadline: deadline,
            submittedAt: 0,
            specHash: specHash,
            deliverable: bytes32(0),
            validationId: 0,
            status: Status.Proposed
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit JobPosted(jobId, clientId, workerId, brokerId, amount, bondRequired(amount), specHash);
    }

    /// @notice The named worker agrees to the terms. Reputation-as-collateral, ENFORCED: the slashable penalty
    ///         is locked from the worker's free bond here (reverts if it lacks the collateral).
    function accept(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        require(j.status == Status.Proposed, "not proposed");
        require(identity.ownerOf(j.workerId) == msg.sender, "not worker");
        require(block.timestamp <= j.deadline, "past deadline");
        uint256 reqBond = bondRequired(j.amount);
        j.bondLocked = reqBond;
        j.status = Status.Open;
        bond.lock(msg.sender, reqBond);
        emit JobAccepted(jobId, j.workerId, reqBond);
    }

    /// @notice The client withdraws a proposal the worker hasn't accepted yet (full refund).
    function cancel(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        require(j.status == Status.Proposed, "not proposed");
        require(identity.ownerOf(j.clientId) == msg.sender, "not client");
        j.status = Status.Cancelled;
        usdc.safeTransfer(msg.sender, j.amount);
        emit JobCancelled(jobId, j.amount);
    }

    function submit(uint256 jobId, bytes32 deliverable) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Open, "not open");
        require(identity.ownerOf(j.workerId) == msg.sender, "not worker");
        require(block.timestamp <= j.deadline, "past deadline");
        j.deliverable = deliverable;
        j.submittedAt = uint64(block.timestamp);
        j.status = Status.Submitted;
        j.validationId = validation.request(jobId, j.workerId, deliverable);
        emit JobSubmitted(jobId, j.workerId, deliverable, j.validationId);
    }

    /// @notice Validator submits its INDEPENDENTLY re-executed answer hash. The verdict is DERIVED on-chain
    ///         (pass iff it matches the worker's deliverable) — the contract never trusts a raw boolean.
    function validate(uint256 jobId, bytes32 validatorAnswerHash) external nonReentrant {
        Job storage j = jobs[jobId];
        require(j.status == Status.Submitted, "not submitted");
        require(identity.ownerOf(j.validatorId) == msg.sender, "not validator");
        require(block.timestamp <= uint256(j.submittedAt) + VALIDATION_WINDOW, "validation window closed");

        bool passed = (validatorAnswerHash == j.deliverable);
        validation.respond(j.validationId, j.validatorId, passed);
        bytes32 ref = bytes32(jobId);
        address workerW = identity.ownerOf(j.workerId);

        if (passed) {
            uint256 brokerFee = j.brokerId == 0 ? 0 : (j.amount * j.brokerFeeBps) / 10000;
            uint256 validatorFee = (j.amount * j.validatorFeeBps) / 10000;
            uint256 workerPay = j.amount - brokerFee - validatorFee;

            // effects before interactions
            j.status = Status.Completed;
            jobsCompleted += 1;
            totalSettled += j.amount; // full escrow settled to provider(s): worker + broker + validator
            creditBasis[j.workerId] += validatorFee;
            bond.unlock(workerW, j.bondLocked);
            reputation.giveFeedback(j.workerId, REP_PASS, true, ref);
            if (j.brokerId != 0) reputation.giveFeedback(j.brokerId, REP_PASS / 5, true, ref);

            usdc.safeTransfer(workerW, workerPay);
            if (brokerFee > 0) usdc.safeTransfer(identity.ownerOf(j.brokerId), brokerFee);
            if (validatorFee > 0) usdc.safeTransfer(identity.ownerOf(j.validatorId), validatorFee);
            emit JobCompleted(jobId, j.workerId, workerPay, brokerFee, validatorFee);
        } else {
            j.status = Status.Rejected;
            jobsRejected += 1;
            uint256 slashed = bond.slash(workerW, j.bondLocked, treasury); // slashed → neutral treasury
            totalSlashed += slashed;
            reputation.giveFeedback(j.workerId, REP_FAIL, false, ref);

            usdc.safeTransfer(identity.ownerOf(j.clientId), j.amount); // refund the client in full
            emit JobRejected(jobId, j.workerId, j.amount, slashed);
        }
    }

    /// @notice After the deadline, a job that never reached submission can be expired by anyone: the client is
    ///         refunded. An accepted (Open) job also unlocks the worker's bond and dings reputation (a no-show is
    ///         not proven fraud); an un-accepted (Proposed) job carries no penalty — the worker never agreed.
    /// @dev    A `Submitted` job can't expire here (a worker could otherwise race the validator past the deadline
    ///         to downgrade a deserved slash); it resolves via validate() or timeoutValidation().
    function expire(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        require(j.status == Status.Open || j.status == Status.Proposed, "only open jobs are expirable");
        require(block.timestamp > j.deadline, "not past deadline");

        address clientW = identity.ownerOf(j.clientId);
        if (j.status == Status.Proposed) {
            j.status = Status.Cancelled;
            usdc.safeTransfer(clientW, j.amount);
            emit JobCancelled(jobId, j.amount);
            return;
        }
        j.status = Status.Expired;
        jobsExpired += 1;
        bond.unlock(identity.ownerOf(j.workerId), j.bondLocked);
        reputation.giveFeedback(j.workerId, REP_EXPIRE, false, bytes32(jobId));
        usdc.safeTransfer(clientW, j.amount);
        emit JobExpired(jobId, j.workerId, j.amount);
    }

    /// @notice If the validator hasn't answered within VALIDATION_WINDOW of submission, anyone can unwind the
    ///         job: the client is refunded and the worker's bond unlocked, with no reputation change for either
    ///         (the validator failed). Without this, a lost or unresponsive validator froze both forever.
    function timeoutValidation(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        require(j.status == Status.Submitted, "not submitted");
        require(block.timestamp > uint256(j.submittedAt) + VALIDATION_WINDOW, "validation window open");
        j.status = Status.Expired;
        jobsExpired += 1;
        bond.unlock(identity.ownerOf(j.workerId), j.bondLocked);
        usdc.safeTransfer(identity.ownerOf(j.clientId), j.amount);
        emit ValidationTimedOut(jobId, j.validatorId, j.amount);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }
}
