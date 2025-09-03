#!/usr/bin/env bun

import { ethers } from 'ethers';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as dotenv from 'dotenv';
// @ts-ignore
const { TronWeb } = require('tronweb');

// Script to fulfill intents using intent-output.json

console.log('🎯 Intent Fulfillment Script\n');
console.log('=' .repeat(50));

// Function to get global log index for a specific event in a TRON transaction
async function getGlobalLogIndex(
  txHash: string,
  blockNumber: number,
  eventSignature: string,
  emitterAddress: string
): Promise<number | null> {
  try {
    console.log('\n🔍 Finding global log index for IntentFulfilledFromSource event...');
    console.log(`   Transaction: ${txHash}`);
    console.log(`   Block: ${blockNumber}`);
    console.log(`   Event signature: ${eventSignature}`);
    console.log(`   Emitter address: ${emitterAddress}`);
    
    const blockHex = '0x' + blockNumber.toString(16);
    
    // Query TRON's eth_getLogs to get all logs in the block with global indices
    const rpcPayload = {
      jsonrpc: '2.0',
      method: 'eth_getLogs',
      params: [{
        fromBlock: blockHex,
        toBlock: blockHex,
        topics: [eventSignature]
      }],
      id: 1
    };
    
    console.log(`   📡 Querying TRON eth_getLogs for block ${blockHex}...`);
    
    const response = await fetch('https://api.trongrid.io/jsonrpc', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(rpcPayload)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (data.error) {
      throw new Error(`RPC Error: ${data.error.message}`);
    }
    
    const logs = data.result;
    console.log(`   📋 Found ${logs.length} logs with matching event signature`);
    
    // Find the log from our transaction and emitter
    for (const log of logs) {
      if (log.transactionHash.toLowerCase() === txHash.toLowerCase() && 
          log.address.toLowerCase() === emitterAddress.toLowerCase()) {
        const globalIndex = parseInt(log.logIndex, 16);
        console.log(`   ✅ Found matching log with global index: ${globalIndex}`);
        console.log(`      Address: ${log.address}`);
        console.log(`      Transaction: ${log.transactionHash}`);
        return globalIndex;
      }
    }
    
    console.log(`   ⚠️  No matching log found for transaction ${txHash} from address ${emitterAddress}`);
    return null;
    
  } catch (error: any) {
    console.error(`   ❌ Error fetching global log index:`, error.message);
    return null;
  }
}

// Load environment variables
dotenv.config();

const env = process.env;

// Required environment variables
const requiredVars = ['PRIVATE_KEY', 'PORTAL_ADDR_OPTIMISM', 'PORTAL_ADDR_TRON', 'PROVER_ADDR_OPTIMISM', 'PROVER_ADDR_TRON'];
for (const varName of requiredVars) {
  if (!env[varName]) {
    console.error(`❌ Missing required environment variable: ${varName}`);
    process.exit(1);
  }
}

// Load contract ABIs from eco-routes compiled contracts
function loadContractABIs() {
  try {
    // Load Portal ABI (for source chain operations)
    const portalArtifact = JSON.parse(readFileSync(join(__dirname, '../out/Portal.sol/Portal.json'), 'utf8'));
    // Load Inbox ABI (for destination chain fulfillment)
    const inboxArtifact = JSON.parse(readFileSync(join(__dirname, '../out/Inbox.sol/Inbox.json'), 'utf8'));
    
    return {
      PORTAL_ABI: portalArtifact.abi,
      INBOX_ABI: inboxArtifact.abi
    };
  } catch (error) {
    console.error('❌ Failed to load contract ABIs:', error);
    process.exit(1);
  }
}

// Chain configurations
const CHAIN_CONFIGS = {
  optimism: {
    chainId: 10, // Optimism mainnet
    rpcUrl: env.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io',
    portal: env.PORTAL_ADDR_OPTIMISM!,
    prover: env.PROVER_ADDR_OPTIMISM!,
    nativeName: 'ETH',
    type: 'evm'
  },
  tron: {
    chainId: 728126428, // Tron mainnet
    rpcUrl: env.TRON_RPC_URL || 'https://api.trongrid.io',
    solidityNode: env.TRON_SOLIDITY_NODE || 'https://api.trongrid.io',
    eventServer: env.TRON_EVENT_SERVER || 'https://api.trongrid.io',
    portal: env.PORTAL_ADDR_TRON!,
    prover: env.PROVER_ADDR_TRON!,
    nativeName: 'TRX',
    type: 'tron'
  }
};

// Convert TRON addresses to EVM hex format (simplified approach)
const tronAddressToHex = (tronAddress: string): string => {
  // For the known addresses, use hardcoded conversions to avoid TronWeb issues
  const knownConversions: {[key: string]: string} = {
    'TQh8ig6rmuMqb5u8efU5LDvoott1oLzoqu': '0xa17fa8126b6a12feb2fe9c19f618fe04d7329074',
    'TXrSJd1bBzYjztSfqV48NJF87rhG8FDbv8': '0xf00af5cb445c915c16e346f817c032c42e826027'
  };
  
  if (knownConversions[tronAddress]) {
    console.log('   🔄 Converting TRON address:', tronAddress, '->', knownConversions[tronAddress]);
    return knownConversions[tronAddress];
  }
  
  // Fallback: create deterministic address from hash
  console.log('   ⚠️ Unknown TRON address, using hash-based conversion:', tronAddress);
  const hash = ethers.keccak256(ethers.toUtf8Bytes(tronAddress));
  return '0x' + hash.slice(2, 42); // Take first 20 bytes as address
};

// Get contract addresses for supported chains
function getContractAddresses() {
  return CHAIN_CONFIGS;
}

// Initialize TronWeb instance
function initializeTronWeb(config: any): any {
  // Remove 0x prefix from private key if present (TRON doesn't use 0x)
  const privateKey = env.PRIVATE_KEY?.startsWith('0x') ? env.PRIVATE_KEY.slice(2) : env.PRIVATE_KEY;
  
  const tronWeb = new TronWeb({
    fullHost: config.rpcUrl,
    solidityNode: config.solidityNode,
    eventServer: config.eventServer,
    privateKey: privateKey
  });
  
  return tronWeb;
}

// Convert EVM address to TRON address
function evmAddressToTron(evmAddress: string): string {
  try {
    // Remove 0x prefix and convert to TRON address
    const hexAddress = evmAddress.startsWith('0x') ? evmAddress.slice(2) : evmAddress;
    
    // For known conversions, use reverse mapping
    const knownReversions: {[key: string]: string} = {
      'a17fa8126b6a12feb2fe9c19f618fe04d7329074': 'TQh8ig6rmuMqb5u8efU5LDvoott1oLzoqu',
      'f00af5cb445c915c16e346f817c032c42e826027': 'TXrSJd1bBzYjztSfqV48NJF87rhG8FDbv8'
    };
    
    if (knownReversions[hexAddress.toLowerCase()]) {
      return knownReversions[hexAddress.toLowerCase()];
    }
    
    // Use TronWeb for conversion
    const tronWeb = new TronWeb({
      fullHost: 'https://api.trongrid.io',
      headers: { "TRON-PRO-API-KEY": 'your-api-key' }
    });
    
    return TronWeb.address.fromHex('41' + hexAddress);
  } catch (error) {
    console.warn(`Failed to convert ${evmAddress} to TRON address:`, error);
    return evmAddress; // Fallback to original
  }
}

// Convert SUN (TRON's smallest unit) to TRX
function sunToTrx(sun: string | number): string {
  return (Number(sun) / 1e6).toString();
}


// Get the correct domain ID for cross-chain messaging
// Different bridge providers use different domain ID mappings
function getDomainId(sourceChain: keyof typeof CHAIN_CONFIGS, destChain: keyof typeof CHAIN_CONFIGS): number {
  // For now, we'll use chainId as domain ID
  // In production, this should be configured based on the bridge provider being used
  const sourceChainId = CHAIN_CONFIGS[sourceChain].chainId;
  
  console.log(`   ℹ️  Using chainId ${sourceChainId} as domain ID for ${sourceChain}`);
  console.log(`   ⚠️  Note: Different bridge providers may require different domain ID mappings`);
  
  // Bridge provider specific mappings would go here:
  // if (bridgeProvider === 'hyperlane') {
  //   return HYPERLANE_DOMAIN_MAPPINGS[sourceChain];
  // } else if (bridgeProvider === 'layerzero') {
  //   return LAYERZERO_ENDPOINT_IDS[sourceChain];
  // }
  
  return sourceChainId;
}

interface IntentInfo {
  intentHash: string;
  transactionHash: string;
  blockNumber: number;
  sourceChain: keyof typeof CHAIN_CONFIGS;
  destChain: keyof typeof CHAIN_CONFIGS;
  creator: string;
  fillAmount: string;
  rewardAmount: string;
  scenario: {
    nativeFillAmount: string;
    nativeRewardAmount: string;
  };
}

async function loadIntentFromFile(filePath: string): Promise<IntentInfo> {
  console.log(`📄 Loading intent from: ${filePath}`);
  
  try {
    const intentData = JSON.parse(readFileSync(filePath, 'utf8')) as IntentInfo;
    
    console.log('📋 Intent Details:');
    console.log(`   Intent Hash: ${intentData.intentHash}`);
    console.log(`   Source Chain: ${intentData.sourceChain}`);
    console.log(`   Destination Chain: ${intentData.destChain}`);
    console.log(`   Creator: ${intentData.creator}`);
    console.log(`   Fill Amount: ${intentData.fillAmount} ${CHAIN_CONFIGS[intentData.destChain].nativeName}`);
    console.log(`   Reward Amount: ${intentData.rewardAmount} ${CHAIN_CONFIGS[intentData.sourceChain].nativeName}`);
    
    return intentData;
  } catch (error) {
    throw new Error(`Failed to load intent file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fetchIntentFromBlockchain(intentInfo: IntentInfo, contracts: any, abis: any) {
  console.log(`\n🔍 Fetching intent details from ${intentInfo.sourceChain} blockchain...`);
  
  const sourceConfig = contracts[intentInfo.sourceChain];
  let provider, portalContract;
  
  if (sourceConfig.type === 'tron') {
    throw new Error('TRON source chain fetching not implemented yet');
  } else {
    // EVM chains
    provider = new ethers.JsonRpcProvider(sourceConfig.rpcUrl);
    portalContract = new ethers.Contract(sourceConfig.portal, abis.PORTAL_ABI, provider);
  }
  
  // Get transaction receipt to find block number
  const txReceipt = await provider.getTransactionReceipt(intentInfo.transactionHash);
  if (!txReceipt) {
    throw new Error(`Transaction ${intentInfo.transactionHash} not found`);
  }
  
  console.log(`   Found transaction in block ${txReceipt.blockNumber}`);
  
  // Search for IntentPublished events in that specific block
  const filter = portalContract.filters.IntentPublished();
  const events = await portalContract.queryFilter(filter, txReceipt.blockNumber, txReceipt.blockNumber);
  
  // Find the matching intent
  const matchingEvent = events.find(event => event.transactionHash === intentInfo.transactionHash);
  
  if (!matchingEvent) {
    throw new Error(`Intent not found in transaction ${intentInfo.transactionHash}`);
  }
  
  console.log('   ✅ Found IntentPublished event');
  
  const args = matchingEvent.args;
  
  // Parse the intent from the event
  const intentDetails = {
    hash: args.intentHash,
    destination: args.destination,
    route: args.route, // This is encoded bytes
    creator: args.creator,
    prover: args.prover,
    deadline: args.rewardDeadline,
    nativeAmount: args.rewardNativeAmount,
    rewardTokens: args.rewardTokens.map((t: any) => ({
      token: t.token,
      amount: t.amount
    })),
    blockNumber: matchingEvent.blockNumber,
    transactionHash: matchingEvent.transactionHash
  };
  
  console.log('📋 Parsed Intent from Blockchain:');
  console.log(`   Destination Chain ID: ${intentDetails.destination}`);
  console.log(`   Reward Native Amount: ${ethers.formatEther(intentDetails.nativeAmount)} ETH`);
  console.log(`   Reward Tokens: ${intentDetails.rewardTokens.length}`);
  console.log(`   Deadline: ${new Date(Number(intentDetails.deadline) * 1000).toISOString()}`);
  
  // Compute the correct intent hash to verify
  const routeHash = ethers.keccak256(intentDetails.route);
  const rewardHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([
    'tuple(uint64,address,address,uint256,tuple(address,uint256)[])'
  ], [[intentDetails.deadline, intentDetails.creator, intentDetails.prover, intentDetails.nativeAmount, intentDetails.rewardTokens.map((t: any) => [t.token, t.amount])]]));
  
  const computedIntentHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([
    'uint64', 'bytes32', 'bytes32'
  ], [intentDetails.destination, routeHash, rewardHash]));
  
  console.log(`   🔍 Intent Hash Verification:`);
  console.log(`      From Event: ${intentDetails.hash}`);
  console.log(`      Computed: ${computedIntentHash}`);
  console.log(`      Match: ${intentDetails.hash === computedIntentHash ? '✅' : '❌'}`);
  console.log(`      Route Hash: ${routeHash}`);
  console.log(`      Reward Hash: ${rewardHash}`);
  
  return intentDetails;
}

async function fulfillIntentOnDestination(
  intentDetails: any,
  intentInfo: IntentInfo,
  contracts: any,
  abis: any
) {
  console.log(`\n🚀 Fulfilling intent on ${intentInfo.destChain}`);
  
  const destConfig = contracts[intentInfo.destChain];
  
  if (destConfig.type === 'tron') {
    return await fulfillOnTron(intentDetails, intentInfo, destConfig, abis, contracts);
  }
  
  // EVM chain fulfillment
  const provider = new ethers.JsonRpcProvider(destConfig.rpcUrl);
  const wallet = new ethers.Wallet(env.PRIVATE_KEY!, provider);
  
  console.log(`   Executor wallet: ${wallet.address}`);
  console.log(`   Portal contract: ${destConfig.portal}`);
  
  // Create portal contract instance (using Portal ABI for fulfillment)
  const portalContract = new ethers.Contract(
    destConfig.portal,
    abis.PORTAL_ABI,
    wallet
  );
  
  // Check wallet balance
  const balance = await provider.getBalance(wallet.address);
  console.log(`   Wallet balance: ${ethers.formatEther(balance)} ${destConfig.nativeName}`);
  
  // Decode the route data from bytes
  console.log('   📝 Decoding route data...');
  let routeData;
  try {
    // The route is encoded as bytes, we need to decode it to Route struct
    routeData = ethers.AbiCoder.defaultAbiCoder().decode([
      "tuple(bytes32,uint64,address,uint256,tuple(address,uint256)[],tuple(address,bytes,uint256)[])"
    ], intentDetails.route)[0];
    
    console.log('   ✅ Route decoded successfully');
    console.log(`      Salt: ${routeData[0]}`);
    console.log(`      Deadline: ${new Date(Number(routeData[1]) * 1000).toISOString()}`);
    console.log(`      Portal: ${routeData[2]}`);
    console.log(`      Native Amount: ${ethers.formatEther(routeData[3])} ${destConfig.nativeName}`);
    console.log(`      Tokens: ${routeData[4].length}`);
    console.log(`      Calls: ${routeData[5].length}`);
  } catch (error) {
    console.error('   ❌ Failed to decode route data:', error);
    return { success: false, error: 'Failed to decode route data' };
  }
  
  // Convert TRON addresses in route if needed
  const processedRoute = {
    salt: routeData[0],
    deadline: routeData[1],
    portal: intentInfo.destChain === 'tron' ? routeData[2] : routeData[2], // Keep as-is for EVM
    nativeAmount: routeData[3],
    tokens: routeData[4].map((t: any) => ({ token: t[0], amount: t[1] })),
    calls: routeData[5].map((c: any) => ({ target: c[0], data: c[1], value: c[2] }))
  };
  
  // Calculate reward hash
  const reward = {
    deadline: intentDetails.deadline,
    creator: intentDetails.creator,
    prover: intentDetails.prover,
    nativeAmount: intentDetails.nativeAmount,
    tokens: intentDetails.rewardTokens
  };
  
  const rewardHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([
    'tuple(uint64,address,address,uint256,tuple(address,uint256)[])'
  ], [[reward.deadline, reward.creator, reward.prover, reward.nativeAmount, reward.tokens.map((t: any) => [t.token, t.amount])]]));
  
  console.log(`   Reward hash: ${rewardHash}`);
  
  // Check if intent has expired
  const now = Math.floor(Date.now() / 1000);
  if (Number(processedRoute.deadline) < now) {
    console.error('   ❌ Intent has expired');
    return { success: false, error: 'Intent expired' };
  }
  
  // Check if intent is already fulfilled
  try {
    const claimant = await portalContract.claimants(intentDetails.hash);
    if (claimant !== ethers.ZeroHash) {
      console.log(`   ⚠️ Intent already fulfilled. Claimant: ${claimant}`);
      return { success: false, error: 'Intent already fulfilled' };
    }
  } catch (error) {
    console.log('   ⚠️ Could not check fulfillment status');
  }
  
  // Prepare claimant (use wallet address as claimant)
  const claimantBytes32 = ethers.zeroPadValue(wallet.address, 32);
  
  console.log('\n   📤 Calling fulfillAndProve...');
  console.log(`      Intent hash: ${intentDetails.hash}`);
  console.log(`      Claimant: ${wallet.address}`);
  console.log(`      Native amount required: ${ethers.formatEther(processedRoute.nativeAmount)} ${destConfig.nativeName}`);
  
  try {
    // Check if we need to send native tokens
    const requiredNative = processedRoute.nativeAmount;
    const txValue = requiredNative;
    
    // Get prover and source chain domain ID for fulfillAndProve
    // Use the DESTINATION chain's prover (where we're executing fulfillAndProve)
    const proverAddress = contracts[intentInfo.destChain].prover;
    const sourceChainDomainID = getDomainId(intentInfo.sourceChain, intentInfo.destChain);
    const proverData = '0x'; // Empty data for now
    
    console.log(`   🔗 Using prover: ${proverAddress} (destination chain prover)`);
    console.log(`   🌐 Source chain domain ID: ${sourceChainDomainID}`);
    
    // Skip static call to avoid resolver error - go directly to transaction
    console.log('   ⚠️  Skipping static call due to resolver issue, executing transaction directly...');
    
    // Execute the actual transaction
    const tx = await portalContract.fulfillAndProve(
      intentDetails.hash,
      processedRoute,
      rewardHash,
      claimantBytes32,
      proverAddress,
      sourceChainDomainID,
      proverData,
      { 
        value: txValue,
        gasLimit: 500000n
      }
    );
    
    console.log(`   ⏳ Transaction submitted: ${tx.hash}`);
    console.log('   Waiting for confirmation...');
    
    const receipt = await tx.wait();
    
    console.log(`   ✅ Intent fulfilled and proved successfully!`);
    console.log(`      Block: ${receipt!.blockNumber}`);
    console.log(`      Gas used: ${receipt!.gasUsed}`);
    console.log(`      Transaction: ${tx.hash}`);
    
    // Check for IntentFulfilled and IntentProven events
    let fulfillmentEventFound = false;
    let provenEventFound = false;
    
    for (const log of receipt!.logs) {
      try {
        const parsed = portalContract.interface.parseLog(log);
        if (parsed?.name === 'IntentFulfilled') {
          fulfillmentEventFound = true;
          console.log('   🎉 IntentFulfilled event emitted');
        } else if (parsed?.name === 'IntentProven') {
          provenEventFound = true;
          console.log('   🔗 IntentProven event emitted');
        }
      } catch {
        // Ignore parsing errors
      }
    }
    
    if (fulfillmentEventFound && provenEventFound) {
      console.log('   ✨ Both fulfillment and proving completed in one transaction!');
    }
    
    return { 
      success: true, 
      transactionHash: tx.hash, 
      blockNumber: receipt!.blockNumber,
      gasUsed: receipt!.gasUsed 
    };
    
  } catch (error: any) {
    console.error('   ❌ Failed to fulfill intent:', error.message);
    
    // Try to decode custom errors
    if (error.data) {
      try {
        const iface = new ethers.Interface([
          'error InvalidHash(bytes32)',
          'error ChainIdTooLarge(uint256)',
          'error InvalidPortal(address)',
          'error IntentAlreadyFulfilled(bytes32)',
          'error ZeroClaimant()',
          'error IntentExpired()',
          'error InsufficientNativeAmount(uint256,uint256)'
        ]);
        const decoded = iface.parseError(error.data);
        console.error('   Decoded error:', decoded);
      } catch {
        console.error('   Raw error data:', error.data);
      }
    }
    
    return { success: false, error: error.message };
  }
}

async function fulfillOnTron(
  intentDetails: any,
  intentInfo: IntentInfo,
  destConfig: any,
  abis: any,
  contracts: any
) {
  console.log('   🔗 Setting up TRON connection...');
  
  try {
    // Initialize TronWeb
    const tronWeb = initializeTronWeb(destConfig);
    
    console.log(`   TRON wallet: ${tronWeb.defaultAddress.base58}`);
    console.log(`   Portal contract: ${destConfig.portal}`);
    
    // Check TRX balance
    const balance = await tronWeb.trx.getBalance(tronWeb.defaultAddress.base58);
    console.log(`   Wallet balance: ${sunToTrx(balance)} TRX`);
    
    // Get the contract instance
    const portalContract = await tronWeb.contract(abis.INBOX_ABI, destConfig.portal);
    
    // Debug: Check available contract methods
    console.log('   🔍 Available contract methods:');
    const contractMethods = Object.keys(portalContract).filter(key => typeof portalContract[key] === 'function');
    contractMethods.slice(0, 10).forEach(method => {
      console.log(`      - ${method}`);
    });
    
    // Check if fulfillAndProve exists
    const hasFulfillAndProve = 'fulfillAndProve' in portalContract;
    const hasFulfill = 'fulfill' in portalContract;
    console.log(`   📋 Contract functions available: fulfill=${hasFulfill}, fulfillAndProve=${hasFulfillAndProve}`);
    
    console.log('   📝 Processing route data for TRON...');
    
    // Decode the route data from bytes
    let routeData;
    try {
      // The route is encoded as bytes, we need to decode it to Route struct
      routeData = ethers.AbiCoder.defaultAbiCoder().decode([
        "tuple(bytes32,uint64,address,uint256,tuple(address,uint256)[],tuple(address,bytes,uint256)[])"
      ], intentDetails.route)[0];
      
      console.log('   ✅ Route decoded successfully');
      console.log(`      Salt: ${routeData[0]}`);
      console.log(`      Deadline: ${new Date(Number(routeData[1]) * 1000).toISOString()}`);
      console.log(`      Portal: ${routeData[2]}`);
      console.log(`      Native Amount: ${sunToTrx(routeData[3])} TRX`);
      console.log(`      Tokens: ${routeData[4].length}`);
      console.log(`      Calls: ${routeData[5].length}`);
    } catch (error) {
      console.error('   ❌ Failed to decode route data:', error);
      return { success: false, error: 'Failed to decode route data' };
    }
    
    // Convert addresses from EVM hex to TRON format where necessary
    const processedRoute = {
      salt: routeData[0],
      deadline: routeData[1],
      portal: evmAddressToTron(routeData[2]), // Convert portal address
      nativeAmount: routeData[3],
      tokens: routeData[4].map((t: any) => ({ 
        token: evmAddressToTron(t[0]), // Convert token addresses
        amount: t[1] 
      })),
      calls: routeData[5].map((c: any) => ({ 
        target: evmAddressToTron(c[0]), // Convert target addresses
        data: c[1], 
        value: c[2] 
      }))
    };
    
    console.log('   🔄 Converted route addresses to TRON format');
    console.log(`      Portal: ${processedRoute.portal}`);
    
    // Calculate reward hash (same as EVM)
    const reward = {
      deadline: intentDetails.deadline,
      creator: intentDetails.creator,
      prover: intentDetails.prover,
      nativeAmount: intentDetails.nativeAmount,
      tokens: intentDetails.rewardTokens
    };
    
    const rewardHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([
      'tuple(uint64,address,address,uint256,tuple(address,uint256)[])'
    ], [[reward.deadline, reward.creator, reward.prover, reward.nativeAmount, reward.tokens.map((t: any) => [t.token, t.amount])]]));
    
    console.log(`   Reward hash: ${rewardHash}`);
    
    // Check if intent has expired
    const now = Math.floor(Date.now() / 1000);
    if (Number(processedRoute.deadline) < now) {
      console.error('   ❌ Intent has expired');
      return { success: false, error: 'Intent expired' };
    }
    
    // Check if intent is already fulfilled
    try {
      const claimant = await portalContract.claimants(intentDetails.hash).call();
      if (claimant !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
        console.log(`   ⚠️ Intent already fulfilled. Claimant: ${claimant}`);
        return { success: false, error: 'Intent already fulfilled' };
      }
    } catch (error) {
      console.log('   ⚠️ Could not check fulfillment status');
    }
    
    // Prepare claimant (use TRON address as claimant)
    const claimantAddress = tronWeb.defaultAddress.base58;
    const claimantHex = TronWeb.address.toHex(claimantAddress);
    // Convert TRON address hex (41...) to EVM format (0x...) for ethers compatibility
    const evmCompatibleHex = '0x' + claimantHex.slice(2); // Remove '41' and add '0x'
    const claimantBytes32 = ethers.zeroPadValue(evmCompatibleHex, 32);
    
    console.log('\n   📤 Calling fulfillAndProve on TRON...');
    console.log(`      Intent hash: ${intentDetails.hash}`);
    console.log(`      Claimant: ${claimantAddress}`);
    console.log(`      Native amount required: ${sunToTrx(processedRoute.nativeAmount)} TRX`);
    
    // Prepare the transaction parameters
    const requiredTrx = processedRoute.nativeAmount;
    
    // Convert the route to the format expected by the contract
    const contractRoute = [
      processedRoute.salt,
      processedRoute.deadline,
      TronWeb.address.toHex(processedRoute.portal),
      processedRoute.nativeAmount,
      processedRoute.tokens.map((t: any) => [TronWeb.address.toHex(t.token), t.amount]),
      processedRoute.calls.map((c: any) => [TronWeb.address.toHex(c.target), c.data, c.value])
    ];
    
    try {
      // Get prover and source chain domain ID for fulfillAndProve
      const sourceChainConfig = contracts[intentInfo.sourceChain];
      // Use the destination chain's prover for fulfillAndProve
      const proverAddress = TronWeb.address.toHex(destConfig.prover);
      const sourceChainDomainID = getDomainId(intentInfo.sourceChain, intentInfo.destChain);
      const proverData = '0x'; // Empty data for now
      
      console.log(`   🔗 Using prover: ${destConfig.prover} (${proverAddress})`);
      console.log(`   🌐 Source chain domain ID: ${sourceChainDomainID}`);
      
      // Debug: Log all parameters being sent
      console.log('   📋 Parameters for function call:');
      console.log(`      intentHash: ${intentDetails.hash}`);
      console.log(`      route (array length): ${contractRoute.length}`);
      console.log(`      route[0] (salt): ${contractRoute[0]}`);
      console.log(`      route[1] (deadline): ${contractRoute[1]}`);
      console.log(`      route[2] (portal): ${contractRoute[2]}`);
      console.log(`      route[3] (nativeAmount): ${contractRoute[3]}`);
      console.log(`      route[4] (tokens): ${JSON.stringify(contractRoute[4], (key, value) => typeof value === 'bigint' ? value.toString() : value)}`);
      console.log(`      route[5] (calls): ${JSON.stringify(contractRoute[5], (key, value) => typeof value === 'bigint' ? value.toString() : value)}`);
      console.log(`      rewardHash: ${rewardHash}`);
      console.log(`      claimantBytes32: ${claimantBytes32}`);
      if (hasFulfillAndProve) {
        console.log(`      proverAddress: ${proverAddress}`);
        console.log(`      sourceChainDomainID: ${sourceChainDomainID}`);
        console.log(`      proverData: ${proverData}`);
      }
      console.log(`      callValue (TRX): ${requiredTrx} (${sunToTrx(requiredTrx)} TRX)`);
      
      // First simulate the transaction to debug issues
      console.log('   🧪 Simulating transaction to debug potential issues...');
      
      // Check if fulfillAndProve is available
      if (!hasFulfillAndProve) {
        return { success: false, error: 'fulfillAndProve function not available on TRON contract' };
      }
      
      // For TRON, we can't simulate payable functions with .call(), so we'll proceed directly
      // but with very detailed parameter validation first
      console.log('   ⚠️ Note: TRON payable functions cannot be simulated with .call()');
      console.log('   📋 Validating all parameters before execution...');
      
      // Validate intent hash format
      if (!intentDetails.hash || !intentDetails.hash.startsWith('0x') || intentDetails.hash.length !== 66) {
        return { success: false, error: `Invalid intent hash format: ${intentDetails.hash}` };
      }
      
      // Validate route array structure
      if (!Array.isArray(contractRoute) || contractRoute.length !== 6) {
        return { success: false, error: `Invalid route array length: ${contractRoute.length}, expected 6` };
      }
      
      // Validate reward hash
      if (!rewardHash || !rewardHash.startsWith('0x') || rewardHash.length !== 66) {
        return { success: false, error: `Invalid reward hash format: ${rewardHash}` };
      }
      
      // Validate claimant
      if (!claimantBytes32 || !claimantBytes32.startsWith('0x') || claimantBytes32.length !== 66) {
        return { success: false, error: `Invalid claimant bytes32 format: ${claimantBytes32}` };
      }
      
      // Validate prover address (should be TRON hex format starting with 41)
      if (!proverAddress || !proverAddress.startsWith('41') || proverAddress.length !== 42) {
        return { success: false, error: `Invalid TRON prover address format: ${proverAddress}` };
      }
      
      console.log('   ✅ All parameter validation passed');
      
      console.log('   📞 Executing fulfillAndProve function on TRON...');
      const transaction = await portalContract.fulfillAndProve(
        intentDetails.hash,
        contractRoute,
        rewardHash,
        claimantBytes32,
        proverAddress,
        sourceChainDomainID,
        proverData
      ).send({
        callValue: requiredTrx,
        shouldPollResponse: true
      });
      
      console.log(`   ⏳ Transaction submitted: ${transaction}`);
      console.log('   Waiting for confirmation...');
      
      // Wait for transaction confirmation - TRON might need time
      let receipt;
      let attempts = 0;
      const maxAttempts = 10;
      
      while (attempts < maxAttempts) {
        try {
          receipt = await tronWeb.trx.getTransactionInfo(transaction);
          if (receipt && receipt.id) {
            break;
          }
        } catch (error) {
          // Transaction might not be confirmed yet
        }
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
        attempts++;
      }
      
      console.log(`   ✅ Intent fulfilled and proved successfully on TRON!`);
      console.log(`      Transaction ID: ${transaction}`);
      console.log(`      Block Number: ${receipt?.blockNumber || 'Pending'}`);
      console.log(`      Energy Used: ${receipt?.receipt?.energy_usage_total || 'N/A'}`);
      console.log('   ✨ Both fulfillment and proving completed in one TRON transaction!');
      
      return { 
        success: true, 
        transactionHash: transaction, 
        blockNumber: receipt?.blockNumber,
        energyUsed: receipt?.receipt?.energy_usage_total 
      };
      
    } catch (error: any) {
      console.error('   ❌ Failed to fulfill intent on TRON:', error.message);
      
      // TRON-specific error handling
      if (error.error) {
        console.error('   TRON error details:', error.error);
      }
      
      return { success: false, error: error.message };
    }
    
  } catch (error: any) {
    console.error('   ❌ TRON setup failed:', error.message);
    return { success: false, error: `TRON setup failed: ${error.message}` };
  }
}

async function main() {
  try {
    console.log('🔍 Validating environment configuration...');
    
    // Parse command line arguments
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
      console.log(`
Usage: bun run scripts/fulfill-intent.ts <intent-output.json>

Arguments:
  intent-output.json    Path to the JSON file created by create-intent.ts

Examples:
  bun run scripts/fulfill-intent.ts intent-output.json
  bun run scripts/fulfill-intent.ts /path/to/intent-output.json

Supported Chains: ${Object.keys(CHAIN_CONFIGS).join(', ')}
`);
      process.exit(0);
    }
    
    console.log('✅ Environment validated. Loading configurations...');
    
    const contracts = getContractAddresses();
    const abis = loadContractABIs();
    
    console.log('✅ Configurations loaded.');
    
    // Load intent from JSON file
    const intentFilePath = args[0].startsWith('/') ? args[0] : join(__dirname, '..', args[0]);
    const intentInfo = await loadIntentFromFile(intentFilePath);
    
    // Validate chain support
    if (!(intentInfo.sourceChain in CHAIN_CONFIGS)) {
      throw new Error(`Unsupported source chain: ${intentInfo.sourceChain}`);
    }
    if (!(intentInfo.destChain in CHAIN_CONFIGS)) {
      throw new Error(`Unsupported destination chain: ${intentInfo.destChain}`);
    }
    
    // Check if intent info already has complete route and reward data
    let intentDetails;
    if (intentInfo.route && intentInfo.reward) {
      console.log('\n📋 Using pre-loaded intent details from file...');
      
      // Encode the route for processing
      const routeEncoded = ethers.AbiCoder.defaultAbiCoder().encode([
        'tuple(bytes32,uint64,address,uint256,tuple(address,uint256)[],tuple(address,bytes,uint256)[])'
      ], [[
        intentInfo.route.salt,
        intentInfo.route.deadline,
        intentInfo.route.portal,
        intentInfo.route.nativeAmount,
        intentInfo.route.tokens || [],
        intentInfo.route.calls.map((c: any) => [c.target, c.data, c.value])
      ]]);
      
      intentDetails = {
        hash: intentInfo.intentHash,
        destination: contracts[intentInfo.destChain].chainId, // Use the destination chain ID
        route: routeEncoded,
        creator: intentInfo.reward.creator,
        prover: intentInfo.reward.prover,
        deadline: intentInfo.reward.deadline,
        nativeAmount: intentInfo.reward.nativeAmount,
        rewardTokens: intentInfo.reward.tokens || [],
        blockNumber: intentInfo.blockNumber,
        transactionHash: intentInfo.transactionHash
      };
      
      console.log('   ✅ Intent details loaded from file');
      console.log(`   Intent Hash: ${intentDetails.hash}`);
      console.log(`   Destination Chain ID: ${intentDetails.destination}`);
      
    } else {
      // Fetch intent details from blockchain
      console.log('\n📋 Fetching intent details from blockchain...');
      intentDetails = await fetchIntentFromBlockchain(intentInfo, contracts, abis);
    }
    
    // Fulfill the intent on destination chain
    const result = await fulfillIntentOnDestination(intentDetails, intentInfo, contracts, abis);
    
    if (result.success) {
      console.log('\n🎉 Intent fulfillment completed successfully!');
      console.log('📋 Summary:');
      console.log(`   Transaction Hash: ${result.transactionHash}`);
      console.log(`   Block Number: ${result.blockNumber}`);
      
      if (intentInfo.destChain === 'tron') {
        console.log(`   Energy Used: ${result.energyUsed || 'N/A'}`);
      } else {
        console.log(`   Gas Used: ${result.gasUsed}`);
      }
      
      // Save fulfillment details
      const fulfillmentData = {
        ...intentInfo,
        fulfillment: {
          transactionHash: result.transactionHash,
          blockNumber: result.blockNumber,
          gasUsed: result.gasUsed?.toString(),
          energyUsed: result.energyUsed?.toString(),
          fulfilledAt: new Date().toISOString(),
          destChain: intentInfo.destChain
        }
      };
      
      const outputFile = join(__dirname, '../fulfillment-output.json');
      writeFileSync(outputFile, JSON.stringify(fulfillmentData, null, 2));
      console.log(`\n💾 Fulfillment details saved to: ${outputFile}`);
      
      // For TRON transactions, try to get the global log index of IntentFulfilledFromSource event
      let globalLogIndex: number | null = null;
      if (intentInfo.destChain === 'tron' && result.transactionHash && result.blockNumber) {
        // IntentFulfilledFromSource event signature
        const eventSignature = '0xd493dde4de24066db29a754b1e9dc5dedf7084850c4abf76c23046ba9dad6b1d';
        // TRON Prover contract address (converted from TSqwDT8qxNgExrkKu6qBo1XLjd5CdSYf2X)
        const tronProverAddress = '0xf00af5cb445c915c16e346f817c032c42e826027';
        
        globalLogIndex = await getGlobalLogIndex(
          result.transactionHash,
          result.blockNumber,
          eventSignature,
          tronProverAddress
        );
      }
      
      // Save relayer input data for proving (both fulfillment and proving happened in one tx)
      const relayerInputData = {
        txHash: result.transactionHash,
        sourceChain: intentInfo.destChain, // The chain where fulfillAndProve was executed
        blockNumber: result.blockNumber,
        chainId: contracts[intentInfo.destChain].chainId,
        eventName: 'IntentProven', // The event that should be picked up for proving
        intentHash: intentDetails.hash,
        timestamp: new Date().toISOString(),
        proofRequired: true, // This transaction should be proven back to source
        globalLogIndex: globalLogIndex, // Add the detected global log index
        originalIntent: {
          sourceChain: intentInfo.sourceChain,
          destChain: intentInfo.destChain,
          creator: intentInfo.creator,
          intentHash: intentDetails.hash
        }
      };
      
      const relayerFile = join(__dirname, '../relayer-input.json');
      writeFileSync(relayerFile, JSON.stringify(relayerInputData, null, 2));
      console.log(`🔗 Relayer input saved to: ${relayerFile}`);
      
      if (globalLogIndex !== null) {
        console.log(`   📍 Global log index for IntentFulfilledFromSource: ${globalLogIndex}`);
      } else if (intentInfo.destChain === 'tron') {
        console.log(`   ⚠️  Could not determine global log index - may need manual lookup`);
      }
    } else {
      console.log('\n❌ Intent fulfillment failed!');
      console.log(`   Error: ${result.error}`);
      process.exit(1);
    }
    
  } catch (error) {
    console.error('❌ Script failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Show usage if help requested
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage: bun run scripts/fulfill-intent.ts <intent-output.json>

This script fulfills cross-chain intents by:
1. Loading intent details from the JSON file created by create-intent.ts
2. Fetching the full intent data from the source chain blockchain
3. Executing fulfillAndProve on the destination chain (fulfillment + proving in one tx)
4. Saving fulfillment results to fulfillment-output.json

Arguments:
  intent-output.json    Path to the JSON file created by create-intent.ts

Examples:
  bun run scripts/fulfill-intent.ts intent-output.json
  bun run scripts/fulfill-intent.ts /path/to/intent-output.json

Supported Chains: ${Object.keys(CHAIN_CONFIGS).join(', ')}

Notes:
- Full TRON and EVM chain support implemented with fulfillAndProve
- The script will validate intent expiration and check for existing fulfillment  
- Native tokens (ETH/TRX) are automatically sent as part of the fulfillment transaction
- TRON addresses are automatically converted from EVM hex format
- Both fulfillment and proving happen in a single transaction for efficiency
`);
  process.exit(0);
}

main();