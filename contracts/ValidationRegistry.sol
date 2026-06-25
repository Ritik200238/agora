// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ValidationRegistry — ERC-8004 Validation pillar (authenticated).
/// @notice Append-only attestation log written ONLY by the JobBoard, so on-chain validation records
///         cannot be forged by arbitrary callers. `initialize` binds the JobBoard once, at deploy.
contract ValidationRegistry {
    enum Status { None, Requested, Passed, Failed }

    struct Validation {
        uint256 jobId;
        uint256 worker;
        uint256 validator;
        bytes32 deliverable;
        Status status;
    }

    address public jobBoard;
    uint256 public nextId = 1;
    mapping(uint256 => Validation) public validations;

    event ValidationRequested(uint256 indexed id, uint256 indexed jobId, uint256 worker, bytes32 deliverable);
    event ValidationResponded(uint256 indexed id, uint256 indexed jobId, uint256 validator, bool passed);

    /// @notice One-time binding of the authorized JobBoard.
    function initialize(address _jobBoard) external {
        require(jobBoard == address(0), "already initialized");
        require(_jobBoard != address(0), "zero");
        jobBoard = _jobBoard;
    }

    modifier onlyJobBoard() {
        require(msg.sender == jobBoard, "only jobBoard");
        _;
    }

    function request(uint256 jobId, uint256 worker, bytes32 deliverable) external onlyJobBoard returns (uint256 id) {
        id = nextId++;
        validations[id] = Validation(jobId, worker, 0, deliverable, Status.Requested);
        emit ValidationRequested(id, jobId, worker, deliverable);
    }

    function respond(uint256 id, uint256 validator, bool passed) external onlyJobBoard {
        Validation storage v = validations[id];
        require(v.status == Status.Requested, "not requested");
        v.validator = validator;
        v.status = passed ? Status.Passed : Status.Failed;
        emit ValidationResponded(id, v.jobId, validator, passed);
    }
}
