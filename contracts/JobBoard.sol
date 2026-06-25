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
/// @notice Hardened lifecycle: a client funds USDC escrow; the worker must hold collateral, which is
///         LOCKED for the job; the validator independently re-executes and submits its answer hash; the
///         contract DERIVES the verdict on-chain (deliverable == validator's hash). Pass → pay + raise
///         reputation + unlock bond. Fail → refund client + slash the locked bond to a neutral treasury +
///         tank reputation. Slashed collateral never flows to a job party (no self-deal profit).
contract JobBoard is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status { None, Open, Submitted, Completed, Rejected, Expired }

    struct Job {
        uint256 clientId;
        uint256 workerId;
        uint256 validatorId;
        uint256 brokerId;
        uint16 brokerFeeBps;
        uint16 validatorFeeBps;
        uint256 amount;
        uint256 bondLocked; // worker collateral reserved for this job
        uint64 deadline;
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
    address public immutable treasury; // neutral sink for slashed collateral

    uint256 public nextJobId = 1;
    mapping(uint256 => Job) public jobs;

    uint256 public totalSettled;
    uint256 public jobsCompleted;
    uint256 public jobsRejected;
    uint256 public jobsExpired;
    uint256 public totalSlashed;

    int256 public constant REP_PASS = 10;
    int256 public constant REP_FAIL = -25;
    int256 public constant REP_EXPIRE = -5;
    bytes32 private constant VALIDATOR_ROLE = keccak256(bytes("validator"));

    event JobPosted(uint256 indexed jobId, uint256 indexed clientId, uint256 indexed workerId, uint256 brokerId, uint256 amount, uint256 bondLocked, bytes32 specHash);
    event JobSubmitted(uint256 indexed jobId, uint256 workerId, bytes32 deliverable, uint256 validationId);
    event JobCompleted(uint256 indexed jobId, uint256 workerId, uint256 workerPay, uint256 brokerFee, uint256 validatorFee);
    event JobRejected(uint256 indexed jobId, uint256 workerId, uint256 refunded, uint256 slashed);
    event JobExpired(uint256 indexed jobId, uint256 workerId, uint256 refunded);

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

    /// @notice Client posts a job (approve `amount` USDC first). The worker's collateral is LOCKED here.
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
        // The validator must be a registered validator-role agent (disinterested third party).
        require(keccak256(bytes(identity.role(validatorId))) == VALIDATOR_ROLE, "validator role required");
        require(amount > 0, "amount=0");
        require(uint256(brokerFeeBps) + uint256(validatorFeeBps) <= 5000, "fees too high");
        require(deadline > block.timestamp, "deadline past");
        if (brokerId == 0) require(brokerFeeBps == 0, "broker fee w/o broker");

        // Reputation-as-collateral, ENFORCED: lock the slashable penalty from the worker's free bond.
        uint256 reqBond = amount / 2;
        require(reqBond > 0, "amount too small to collateralize");
        bond.lock(identity.ownerOf(workerId), reqBond); // reverts if the worker lacks free collateral

        jobId = nextJobId++;
        jobs[jobId] = Job({
            clientId: clientId,
            workerId: workerId,
            validatorId: validatorId,
            brokerId: brokerId,
            brokerFeeBps: brokerFeeBps,
            validatorFeeBps: validatorFeeBps,
            amount: amount,
            bondLocked: reqBond,
            deadline: deadline,
            specHash: specHash,
            deliverable: bytes32(0),
            validationId: 0,
            status: Status.Open
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit JobPosted(jobId, clientId, workerId, brokerId, amount, reqBond, specHash);
    }

    function submit(uint256 jobId, bytes32 deliverable) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Open, "not open");
        require(identity.ownerOf(j.workerId) == msg.sender, "not worker");
        require(block.timestamp <= j.deadline, "past deadline");
        j.deliverable = deliverable;
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
            totalSettled += workerPay;
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

    /// @notice After the deadline: refund the client, unlock the worker's bond (a no-show is not proven
    ///         fraud), and ding the worker's reputation.
    function expire(uint256 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        require(j.status == Status.Open || j.status == Status.Submitted, "not expirable");
        require(block.timestamp > j.deadline, "not past deadline");

        j.status = Status.Expired;
        jobsExpired += 1;
        bond.unlock(identity.ownerOf(j.workerId), j.bondLocked);
        reputation.giveFeedback(j.workerId, REP_EXPIRE, false, bytes32(jobId));
        usdc.safeTransfer(identity.ownerOf(j.clientId), j.amount);
        emit JobExpired(jobId, j.workerId, j.amount);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }
}
