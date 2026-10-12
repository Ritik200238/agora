// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title IdentityRegistry — ERC-8004 Identity pillar.
/// @notice Every agent mints a soulbound on-chain passport (ERC-721) linked to its wallet, role, and a
///         metadata URI (agent card / capabilities). One passport per wallet.
/// @dev    Roles are self-declared EXCEPT "validator": a validator's verdict moves escrow, reputation and
///         (via reputation-earned fees) credit, so a self-declared validator would let one person with three
///         wallets farm reputation for free. Validators are therefore admitted by the registry admin (the
///         curated validator set), and admission can be revoked. Ownership stays with the admin for that.
contract IdentityRegistry is ERC721, Ownable {
    uint256 public nextId = 1;

    mapping(uint256 => string) public metadataURI; // agent card (capabilities, name, version)
    mapping(uint256 => string) public role;        // "producer" | "worker" | "broker" | "validator" | "consumer" | "lender"
    mapping(address => uint256) public agentOf;    // wallet -> agentId (0 = unregistered)
    mapping(address => bool) public validatorApproved; // admin-curated validator set

    bytes32 private constant VALIDATOR_ROLE = keccak256(bytes("validator"));

    event AgentRegistered(uint256 indexed agentId, address indexed owner, string role, string metadataURI);
    event ValidatorApproval(address indexed wallet, bool approved);

    constructor() ERC721("Agora Agent Passport", "AGENT") Ownable(msg.sender) {}

    /// @notice Admit (or revoke) a wallet as a validator. Revocation takes effect immediately for new jobs.
    function setValidatorApproval(address wallet, bool approved) external onlyOwner {
        validatorApproved[wallet] = approved;
        emit ValidatorApproval(wallet, approved);
    }

    /// @notice Register the caller as an agent. Returns the minted agentId.
    function register(string calldata _role, string calldata _metadataURI) external returns (uint256 id) {
        require(agentOf[msg.sender] == 0, "already registered");
        if (keccak256(bytes(_role)) == VALIDATOR_ROLE) require(validatorApproved[msg.sender], "validator not approved");
        id = nextId++;
        // effects before the mint: _safeMint calls back into a contract receiver, which must not be able to
        // re-enter register() and mint a second passport for the same wallet
        agentOf[msg.sender] = id;
        role[id] = _role;
        metadataURI[id] = _metadataURI;
        _safeMint(msg.sender, id);
        emit AgentRegistered(id, msg.sender, _role, _metadataURI);
    }

    /// @notice True iff `agentId` is a registered validator whose wallet is CURRENTLY approved.
    function isValidator(uint256 agentId) external view returns (bool) {
        address w = _ownerOf(agentId);
        return w != address(0) && validatorApproved[w] && keccak256(bytes(role[agentId])) == VALIDATOR_ROLE;
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
