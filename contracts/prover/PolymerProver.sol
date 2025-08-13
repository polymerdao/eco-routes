// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseProver} from "./BaseProver.sol";
import {Semver} from "../libs/Semver.sol";
import {IProver} from "../interfaces/IProver.sol";
import {ICrossL2ProverV2} from "../lib/polymer-prover-contracts/contracts/interfaces/ICrossL2ProverV2.sol";

/**
 * @title PolymerProver
 * @notice Prover implementation using Polymer's cross-chain proving system
 * @dev Processes cryptographic proofs from Polymer and records proven intents
 */
contract PolymerProver is BaseProver, Semver {
    
    string public constant PROOF_TYPE = "Polymer";
    address public immutable POLYMER_VERIFIER;
    
    /**
     * @notice Expected event signature for Fulfillment events
     * @dev keccak256("Fulfillment(bytes32,uint256,address,address)")
     */
    bytes32 public constant FULFILLMENT_EVENT_SIG = 
        keccak256("Fulfillment(bytes32,uint256,address,address)");
    
    // Authorization mappings
    mapping(uint256 => mapping(address => bool)) public authorizedInboxes;
    
    // Admin controls
    address public owner;
    
    // Events
    event ProofSubmitted(
        bytes32 indexed intentHash, 
        address indexed claimant,
        address indexed submitter,
        uint256 sourceChainId
    );
    event InvalidProofRejected(bytes32 indexed intentHash, string reason);
    event InboxAuthorized(uint256 indexed chainId, address indexed inbox);
    event InboxDeauthorized(uint256 indexed chainId, address indexed inbox);
    
    // Custom errors
    error InvalidVerifier();
    error InvalidOwner();
    error ArrayLengthMismatch();
    error OnlyOwner();
    error SourceChainMismatch();
    error UnauthorizedInbox();
    error InvalidEventStructure();
    error NotFulfillmentEvent();
    error IntentHashMismatch();
    error EventSourceChainMismatch();
    error InvalidClaimant();
    error InvalidProver();
    error InvalidTopicsLength();
    error InvalidUnindexedData();
    error InvalidNewOwner();
    
    // Modifiers
    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }
    
    
    
    constructor(
        address _inbox,
        address _polymerVerifier,
        address _owner,
        uint256[] memory _chainIds,
        address[] memory _authorizedInboxes
    ) BaseProver(_inbox) {
        if (_polymerVerifier == address(0)) revert InvalidVerifier();
        if (_owner == address(0)) revert InvalidOwner();
        if (_chainIds.length != _authorizedInboxes.length) revert ArrayLengthMismatch();
        
        POLYMER_VERIFIER = _polymerVerifier;
        owner = _owner;
        
        // Initialize authorized inboxes
        for (uint i = 0; i < _chainIds.length; i++) {
            authorizedInboxes[_chainIds[i]][_authorizedInboxes[i]] = true;
            emit InboxAuthorized(_chainIds[i], _authorizedInboxes[i]);
        }
    }
    
    /**
     * @notice Submit and validate a Polymer proof for intent fulfillment
     * @param proof The Polymer-generated proof bytes
     * @param expectedIntentHash The intent hash we expect this proof to validate
     * @param expectedSourceChainId The source chain where the intent was created
     */
    function submitProof(
        bytes calldata proof,
        bytes32 expectedIntentHash,
        uint256 expectedSourceChainId
    ) external {
        
        // 1. Validate the proof using Polymer's verifier and copy to memory
        (
            uint32 chainId,
            address emittingContract,
            bytes calldata topicsCalldata,
            bytes calldata unindexedDataCalldata
        ) = ICrossL2ProverV2(POLYMER_VERIFIER).validateEvent(proof);
        
        // Copy calldata to memory for processing
        bytes memory topics = topicsCalldata;
        bytes memory unindexedData = unindexedDataCalldata;
        
        // 2. Validate source chain matches expectation
        if (uint256(chainId) != expectedSourceChainId) revert SourceChainMismatch();
        
        // 3. Verify emitting contract is authorized
        if (!authorizedInboxes[uint256(chainId)][emittingContract]) {
            revert UnauthorizedInbox();
        }
        
        // 4. Parse topics from bytes to bytes32 array
        bytes32[] memory parsedTopics = _parseTopics(topics);
        if (parsedTopics.length < 4) revert InvalidEventStructure();
        
        // 5. Verify this is a Fulfillment event
        if (parsedTopics[0] != FULFILLMENT_EVENT_SIG) revert NotFulfillmentEvent();
        
        // 6. Extract data from the Fulfillment event
        // Event: Fulfillment(bytes32 indexed _hash, uint256 indexed _sourceChainID, address indexed _prover, address _claimant)
        bytes32 intentHash = parsedTopics[1];           // _hash (indexed)
        uint256 sourceChainFromEvent = uint256(parsedTopics[2]); // _sourceChainID (indexed)
        address proverFromEvent = address(uint160(uint256(parsedTopics[3]))); // _prover (indexed)
        
        // Extract claimant from unindexed data
        address claimant = _extractClaimantFromData(unindexedData);
        
        // 7. Validate extracted data
        if (intentHash != expectedIntentHash) revert IntentHashMismatch();
        if (sourceChainFromEvent != expectedSourceChainId) revert EventSourceChainMismatch();
        if (claimant == address(0)) revert InvalidClaimant();
        if (proverFromEvent == address(0)) revert InvalidProver();
        
        // 8. Store the proof data
        _storeProofData(intentHash, claimant, uint256(chainId));
        
        emit ProofSubmitted(intentHash, claimant, msg.sender, uint256(chainId));
    }
    
    /**
     * @notice Parse topics bytes into bytes32 array
     * @dev Critical security function - prevents misinterpretation of event data
     * @param topics The concatenated topics bytes from Polymer
     * @return parsedTopics Array of individual topic values
     */
    function _parseTopics(bytes memory topics) internal pure returns (bytes32[] memory parsedTopics) {
        if (topics.length % 32 != 0) revert InvalidTopicsLength();
        
        uint256 topicCount = topics.length / 32;
        parsedTopics = new bytes32[](topicCount);
        
        assembly {
            let topicsPtr := add(topics, 0x20)
            let parsedPtr := add(parsedTopics, 0x20)
            
            for { let i := 0 } lt(i, topicCount) { i := add(i, 1) } {
                mstore(add(parsedPtr, mul(i, 0x20)), mload(add(topicsPtr, mul(i, 0x20))))
            }
        }
    }
    
    /**
     * @notice Extract claimant address from unindexed event data
     * @param unindexedData The unindexed data from the event
     * @return claimant The claimant address
     */
    function _extractClaimantFromData(bytes memory unindexedData) internal pure returns (address claimant) {
        if (unindexedData.length < 32) revert InvalidUnindexedData();
        
        // ABI decode the claimant address
        assembly {
            claimant := mload(add(unindexedData, 0x20))
        }
    }
    
    /**
     * @notice Store proof data with replay protection
     * @param intentHash The intent hash
     * @param claimant The claimant address
     * @param destinationChainId The destination chain ID
     */
    function _storeProofData(
        bytes32 intentHash,
        address claimant,
        uint256 destinationChainId
    ) internal {
        ProofData storage proofData = _provenIntents[intentHash];
        
        // Check if already proven
        if (proofData.claimant != address(0)) {
            emit IntentAlreadyProven(intentHash);
            return;
        }
        
        // Store proof data
        proofData.destinationChainID = uint96(destinationChainId);
        proofData.claimant = claimant;
        
        emit IntentProven(intentHash, claimant);
    }
    
    /**
     * @notice Batch submit multiple proofs
     */
    function submitBatchProofs(
        bytes[] calldata proofs,
        bytes32[] calldata expectedIntentHashes,
        uint256[] calldata expectedSourceChainIds
    ) external {
        if (proofs.length != expectedIntentHashes.length || 
            proofs.length != expectedSourceChainIds.length) {
            revert ArrayLengthMismatch();
        }
        
        for (uint256 i = 0; i < proofs.length; i++) {
            try this.submitProof(
                proofs[i],
                expectedIntentHashes[i],
                expectedSourceChainIds[i]
            ) {
                // Success - continue
            } catch Error(string memory reason) {
                emit InvalidProofRejected(expectedIntentHashes[i], reason);
            }
        }
    }
    
    /**
     * @notice Get detailed proof information for debugging
     */
    function inspectProof(bytes calldata proof) external view returns (
        uint32 srcChainId,
        uint64 blockNumber,
        uint32 receiptIndex,
        uint32 logIndex
    ) {
        return ICrossL2ProverV2(POLYMER_VERIFIER).inspectLogIdentifier(proof);
    }
    
    function getProofType() external pure override returns (string memory) {
        return PROOF_TYPE;
    }
    
    // Administrative functions
    function authorizeInbox(uint256 chainId, address inbox) external onlyOwner {
        authorizedInboxes[chainId][inbox] = true;
        emit InboxAuthorized(chainId, inbox);
    }
    
    function deauthorizeInbox(uint256 chainId, address inbox) external onlyOwner {
        authorizedInboxes[chainId][inbox] = false;
        emit InboxDeauthorized(chainId, inbox);
    }
    
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidNewOwner();
        owner = newOwner;
    }
}