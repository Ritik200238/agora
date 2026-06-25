// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ReputationRegistry — ERC-8004 Reputation pillar.
/// @notice Stores each agent's verifiable, on-chain track record. Only authorized reporters
///         (the JobBoard) can post outcomes, so reputation reflects real settled work.
contract ReputationRegistry is Ownable {
    struct Rep {
        int256 score;       // cumulative reputation
        uint256 jobs;       // total outcomes recorded
        uint256 completed;  // successful
        uint256 failed;     // failed / rejected / expired
    }

    mapping(uint256 => Rep) public rep;        // agentId -> reputation
    mapping(address => bool) public reporters; // authorized writers

    event Feedback(uint256 indexed agentId, int256 delta, int256 newScore, bool success, bytes32 jobRef);
    event ReporterSet(address indexed reporter, bool allowed);

    constructor() Ownable(msg.sender) {}

    function setReporter(address r, bool allowed) external onlyOwner {
        reporters[r] = allowed;
        emit ReporterSet(r, allowed);
    }

    modifier onlyReporter() {
        require(reporters[msg.sender], "not reporter");
        _;
    }

    function giveFeedback(uint256 agentId, int256 delta, bool success, bytes32 jobRef) external onlyReporter {
        Rep storage r = rep[agentId];
        r.score += delta;
        r.jobs += 1;
        if (success) {
            r.completed += 1;
        } else {
            r.failed += 1;
        }
        emit Feedback(agentId, delta, r.score, success, jobRef);
    }

    function scoreOf(uint256 agentId) external view returns (int256) {
        return rep[agentId].score;
    }

    function statsOf(uint256 agentId) external view returns (int256 score, uint256 jobs, uint256 completed, uint256 failed) {
        Rep storage r = rep[agentId];
        return (r.score, r.jobs, r.completed, r.failed);
    }
}
