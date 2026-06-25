// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ValidationRegistry — ERC-8004 Validation pillar.
/// @notice Append-only attestation log: a deliverable is submitted for validation (request),
///         then a validator attests pass/fail (respond). The JobBoard is the practical caller,
///         which is what couples on-chain validation to settlement + slashing.
contract ValidationRegistry {
    enum Status { None, Requested, Passed, Failed }

    struct Validation {
        uint256 jobId;
        uint256 worker;
        uint256 validator;
        bytes32 deliverable;
        Status status;
    }

    uint256 public nextId = 1;
    mapping(uint256 => Validation) public validations;

    event ValidationRequested(uint256 indexed id, uint256 indexed jobId, uint256 worker, bytes32 deliverable);
    event ValidationResponded(uint256 indexed id, uint256 indexed jobId, uint256 validator, bool passed);

    function request(uint256 jobId, uint256 worker, bytes32 deliverable) external returns (uint256 id) {
        id = nextId++;
        validations[id] = Validation(jobId, worker, 0, deliverable, Status.Requested);
        emit ValidationRequested(id, jobId, worker, deliverable);
    }

    function respond(uint256 id, uint256 validator, bool passed) external {
        Validation storage v = validations[id];
        require(v.status == Status.Requested, "not requested");
        v.validator = validator;
        v.status = passed ? Status.Passed : Status.Failed;
        emit ValidationResponded(id, v.jobId, validator, passed);
    }
}
