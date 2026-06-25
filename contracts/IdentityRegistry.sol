// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title IdentityRegistry — ERC-8004 Identity pillar.
/// @notice Every agent mints a non-transferable* on-chain passport (ERC-721) linked to its wallet,
///         role, and a metadata URI (agent card / capabilities). One passport per wallet.
/// @dev *We don't override transfer here to keep it minimal; the economy never transfers passports.
contract IdentityRegistry is ERC721 {
    uint256 public nextId = 1;

    mapping(uint256 => string) public metadataURI; // agent card (capabilities, name, version)
    mapping(uint256 => string) public role;        // "producer" | "worker" | "broker" | "validator" | "consumer" | "treasury"
    mapping(address => uint256) public agentOf;    // wallet -> agentId (0 = unregistered)

    event AgentRegistered(uint256 indexed agentId, address indexed owner, string role, string metadataURI);

    constructor() ERC721("Agora Agent Passport", "AGENT") {}

    /// @notice Register the caller as an agent. Returns the minted agentId.
    function register(string calldata _role, string calldata _metadataURI) external returns (uint256 id) {
        require(agentOf[msg.sender] == 0, "already registered");
        id = nextId++;
        _safeMint(msg.sender, id);
        role[id] = _role;
        metadataURI[id] = _metadataURI;
        agentOf[msg.sender] = id;
        emit AgentRegistered(id, msg.sender, _role, _metadataURI);
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return metadataURI[id];
    }

    function isRegistered(address wallet) external view returns (bool) {
        return agentOf[wallet] != 0;
    }

    /// @dev Soulbound: passports can be minted but never transferred (would break the one-wallet-one-agent
    ///      identity invariant and let job payouts/reputation follow a transferred token). Mint only.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        require(from == address(0), "soulbound: non-transferable");
        return super._update(to, tokenId, auth);
    }
}
