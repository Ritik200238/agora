// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IdentityRegistry} from "./IdentityRegistry.sol";
import {ReputationRegistry} from "./ReputationRegistry.sol";
import {ValidationRegistry} from "./ValidationRegistry.sol";
import {ReputationBond} from "./ReputationBond.sol";

/// @title JobBoard — ERC-8183-style escrowed job lifecycle, wired to the ERC-8004 trust layer.
/// @notice The heart of the economy: a client funds USDC escrow, a worker delivers, a validator
///         attests, and the contract settles — paying out + raising reputation on pass, or refunding
///         the client + slashing the worker's bond + tanking reputation on fail.
///         Lifecycle: Open -> Submitted -> Completed | Rejected | Expired.
contract JobBoard {
    using SafeERC20 for IERC20;

    enum Status { None, Open, Submitted, Completed, Rejected, Expired }

    struct Job {
        uint256 clientId;
        uint256 workerId;
        uint256 validatorId;
        uint256 brokerId; // 0 = no broker
        uint16 brokerFeeBps;
        uint16 validatorFeeBps;
        uint256 amount;
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

    uint256 public nextJobId = 1;
    mapping(uint256 => Job) public jobs;

    // Cheap on-chain economy counters (read by the dashboard for "GDP").
    uint256 public totalSettled;  // cumulative USDC actually paid to workers
    uint256 public jobsCompleted;
    uint256 public jobsRejected;
    uint256 public jobsExpired;

    int256 public constant REP_PASS = 10;
    int256 public constant REP_FAIL = -25;
    int256 public constant REP_EXPIRE = -5;

    event JobPosted(uint256 indexed jobId, uint256 indexed clientId, uint256 indexed workerId, uint256 brokerId, uint256 amount, bytes32 specHash);
    event JobSubmitted(uint256 indexed jobId, uint256 workerId, bytes32 deliverable, uint256 validationId);
    event JobCompleted(uint256 indexed jobId, uint256 workerId, uint256 workerPay, uint256 brokerFee, uint256 validatorFee);
    event JobRejected(uint256 indexed jobId, uint256 workerId, uint256 refunded, uint256 slashed);
    event JobExpired(uint256 indexed jobId, uint256 workerId, uint256 refunded);

    constructor(
        IERC20 _usdc,
        IdentityRegistry _identity,
        ReputationRegistry _reputation,
        ValidationRegistry _validation,
        ReputationBond _bond
    ) {
        usdc = _usdc;
        identity = _identity;
        reputation = _reputation;
        validation = _validation;
        bond = _bond;
    }

    /// @notice Client posts a job and funds the escrow. Client must `approve` `amount` USDC first.
    function postJob(
        uint256 workerId,
        uint256 validatorId,
        uint256 brokerId,
        uint16 brokerFeeBps,
        uint16 validatorFeeBps,
        uint256 amount,
        uint64 deadline,
        bytes32 specHash
    ) external returns (uint256 jobId) {
        uint256 clientId = identity.agentOf(msg.sender);
        require(clientId != 0, "client not registered");
        require(workerId != 0 && validatorId != 0, "bad parties");
        require(workerId != clientId, "worker == client");
        require(validatorId != workerId, "validator == worker");
        require(amount > 0, "amount=0");
        require(uint256(brokerFeeBps) + uint256(validatorFeeBps) <= 5000, "fees too high");
        require(deadline > block.timestamp, "deadline past");

        jobId = nextJobId++;
        jobs[jobId] = Job({
            clientId: clientId,
            workerId: workerId,
            validatorId: validatorId,
            brokerId: brokerId,
            brokerFeeBps: brokerFeeBps,
            validatorFeeBps: validatorFeeBps,
            amount: amount,
            deadline: deadline,
            specHash: specHash,
            deliverable: bytes32(0),
            validationId: 0,
            status: Status.Open
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit JobPosted(jobId, clientId, workerId, brokerId, amount, specHash);
    }

    /// @notice Worker submits a deliverable hash; opens a validation request.
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

    /// @notice Validator attests pass/fail; settlement happens here.
    function validate(uint256 jobId, bool passed) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Submitted, "not submitted");
        require(identity.ownerOf(j.validatorId) == msg.sender, "not validator");

        validation.respond(j.validationId, j.validatorId, passed);
        bytes32 ref = bytes32(jobId);

        if (passed) {
            uint256 brokerFee = j.brokerId == 0 ? 0 : (j.amount * j.brokerFeeBps) / 10000;
            uint256 validatorFee = (j.amount * j.validatorFeeBps) / 10000;
            uint256 workerPay = j.amount - brokerFee - validatorFee;

            usdc.safeTransfer(identity.ownerOf(j.workerId), workerPay);
            if (brokerFee > 0) usdc.safeTransfer(identity.ownerOf(j.brokerId), brokerFee);
            if (validatorFee > 0) usdc.safeTransfer(identity.ownerOf(j.validatorId), validatorFee);

            reputation.giveFeedback(j.workerId, REP_PASS, true, ref);
            if (j.brokerId != 0) reputation.giveFeedback(j.brokerId, REP_PASS / 5, true, ref);

            j.status = Status.Completed;
            totalSettled += workerPay;
            jobsCompleted += 1;
            emit JobCompleted(jobId, j.workerId, workerPay, brokerFee, validatorFee);
        } else {
            // Refund the client in full, then slash the worker's bond as a penalty paid to the validator.
            usdc.safeTransfer(identity.ownerOf(j.clientId), j.amount);

            uint256 penalty = j.amount / 2;
            uint256 slashed = bond.slash(
                identity.ownerOf(j.workerId),
                penalty,
                identity.ownerOf(j.validatorId)
            );

            reputation.giveFeedback(j.workerId, REP_FAIL, false, ref);

            j.status = Status.Rejected;
            jobsRejected += 1;
            emit JobRejected(jobId, j.workerId, j.amount, slashed);
        }
    }

    /// @notice After the deadline, anyone can expire an undelivered job: refund client, tank worker rep.
    function expire(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.status == Status.Open || j.status == Status.Submitted, "not expirable");
        require(block.timestamp > j.deadline, "not past deadline");

        usdc.safeTransfer(identity.ownerOf(j.clientId), j.amount);
        reputation.giveFeedback(j.workerId, REP_EXPIRE, false, bytes32(jobId));

        j.status = Status.Expired;
        jobsExpired += 1;
        emit JobExpired(jobId, j.workerId, j.amount);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }
}
