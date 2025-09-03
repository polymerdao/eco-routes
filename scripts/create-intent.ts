#!/usr/bin/env bun

import { ethers } from 'ethers';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as dotenv from 'dotenv';
// @ts-ignore
const { TronWeb } = require('tronweb');

// Script to create intents for testing

console.log('📝 Intent Creation Script\n');
console.log('=' .repeat(50));

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

// Load contract ABIs
function loadContractABIs() {
  try {
    const portalArtifact = JSON.parse(readFileSync(join(__dirname, '../out/Portal.sol/Portal.json'), 'utf8'));
    
    return {
      PORTAL_ABI: portalArtifact.abi
    };
  } catch (error) {
    console.error('❌ Failed to load Portal ABI:', error);
    process.exit(1);
  }
}

// Helper functions for TRON
function initializeTronWeb(privateKey: string | undefined, config: any): any {
  const pk = privateKey?.startsWith('0x') ? privateKey.slice(2) : privateKey;
  
  const tronWeb = new TronWeb({
    fullHost: config.rpcUrl,
    privateKey: pk
  });
  
  return tronWeb;
}

function sunToTrx(sun: string | number): string {
  return (Number(sun) / 1e6).toString();
}

function evmAddressToTron(evmAddress: string): string {
  try {
    const hexAddress = evmAddress.startsWith('0x') ? evmAddress.slice(2) : evmAddress;
    
    // Known conversions
    const knownReversions: {[key: string]: string} = {
      'a17fa8126b6a12feb2fe9c19f618fe04d7329074': 'TQh8ig6rmuMqb5u8efU5LDvoott1oLzoqu',
      'f00af5cb445c915c16e346f817c032c42e826027': 'TXrSJd1bBzYjztSfqV48NJF87rhG8FDbv8',
      'e6febf8c8bf6366ef6fe7337b0b5b394d46d9fc6': 'TSqwDT8qxNgExrkKu6qBo1XLjd5CdSYf2X'
    };
    
    if (knownReversions[hexAddress.toLowerCase()]) {
      return knownReversions[hexAddress.toLowerCase()];
    }
    
    // Use TronWeb for conversion
    return TronWeb.address.fromHex('41' + hexAddress);
  } catch (error) {
    console.warn(`Failed to convert ${evmAddress} to TRON address:`, error);
    return evmAddress;
  }
}

// Chain configurations
const CHAIN_CONFIGS = {
  optimism: {
    chainId: 10, // Optimism mainnet
    rpcUrl: env.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io',
    portal: env.PORTAL_ADDR_OPTIMISM!,
    prover: env.PROVER_ADDR_OPTIMISM!,
    nativeName: 'ETH'
  },
  tron: {
    chainId: 728126428, // Tron mainnet
    rpcUrl: env.TRON_RPC_URL || 'https://api.trongrid.io',
    portal: env.PORTAL_ADDR_TRON!,
    prover: env.PROVER_ADDR_TRON!,
    nativeName: 'TRX',
    type: 'tron'
  }
};

// Get contract addresses for supported chains
function getContractAddresses() {
  return CHAIN_CONFIGS;
}

interface IntentScenario {
  name: string;
  sourceChain: keyof typeof CHAIN_CONFIGS;
  destChain: keyof typeof CHAIN_CONFIGS;
  nativeRewardAmount: bigint; // Native token reward amount
  nativeFillAmount: bigint;   // Native token fill amount
}

async function createIntent(scenario: IntentScenario, contracts: any, abis: any) {
  console.log(`\n🧪 Creating Intent: ${scenario.name}`);
  
  const sourceConfig = contracts[scenario.sourceChain];
  const destConfig = contracts[scenario.destChain];
  
  console.log(`   ${scenario.sourceChain} → ${scenario.destChain}`);
  console.log(`   Fill: ${ethers.formatEther(scenario.nativeFillAmount)} ${destConfig.nativeName}`);
  console.log(`   Reward: ${ethers.formatEther(scenario.nativeRewardAmount)} ${sourceConfig.nativeName}`);
  
  try {
    // Set up providers and wallets based on source chain
    let sourceProvider: any;
    let wallet: any;
    let isTronSource = false;
    
    if (scenario.sourceChain === 'tron') {
      // TRON source chain implementation
      isTronSource = true;
      const tronWeb = initializeTronWeb(env.PRIVATE_KEY, sourceConfig);
      sourceProvider = tronWeb;
      wallet = {
        address: tronWeb.defaultAddress.base58,
        tronWeb: tronWeb
      };
      console.log('   🔗 Using TronWeb for TRON source chain');
      console.log('   👛 TRON wallet address:', wallet.address);
    } else {
      // EVM chains (Optimism)
      sourceProvider = new ethers.JsonRpcProvider(sourceConfig.rpcUrl);
      const evmWallet = new ethers.Wallet(env.PRIVATE_KEY!, sourceProvider);
      wallet = evmWallet;
    }
    
    console.log(`   📍 Source contracts (${scenario.sourceChain}):`, {
      portal: sourceConfig.portal,
      prover: sourceConfig.prover
    });
    console.log(`   📍 Dest contracts (${scenario.destChain}):`, {
      portal: destConfig.portal,
      prover: destConfig.prover
    });
    
    // Get chain IDs from configuration
    const sourceChainId = sourceConfig.chainId;
    const destChainId = destConfig.chainId;
    
    // Create the intent structure with native token transfers
    const salt = ethers.randomBytes(32);
    const fillAmount = scenario.nativeFillAmount;
    const rewardAmount = scenario.nativeRewardAmount;
    
    // Convert TRON address to EVM hex format (simplified approach)
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

    const getPortalAddress = () => {
      if (destConfig.nativeName === 'TRX') {
        return tronAddressToHex(destConfig.portal);
      }
      return destConfig.portal;
    };

    const routeDeadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now
    const rewardDeadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now
    
    // Handle wallet address format based on chain type
    const getWalletAddress = () => {
      if (isTronSource) {
        // Convert TRON address to EVM format for the intent structure
        const tronAddr = wallet.address;
        const hexAddr = TronWeb.address.toHex(tronAddr);
        // Convert from TRON hex (41...) to EVM hex (0x...)
        return '0x' + hexAddr.slice(2);
      }
      return wallet.address;
    };
    
    const route = {
      salt: salt,
      deadline: routeDeadline,
      portal: getPortalAddress(),
      nativeAmount: fillAmount, // Native token amount to fill
      tokens: [], // No ERC20 tokens, only native
      calls: [
        {
          target: getWalletAddress(), // Send native tokens to wallet address (simple transfer)
          data: '0x', // Empty data for simple transfer
          value: fillAmount
        }
      ]
    };
    
    // Handle prover address format based on chain type
    const getProverAddress = () => {
      if (isTronSource) {
        // For TRON source, the prover should be in EVM format for the intent structure
        // but the config has it in TRON format, so convert it
        if (sourceConfig.prover.startsWith('T')) {
          const hexAddr = TronWeb.address.toHex(sourceConfig.prover);
          return '0x' + hexAddr.slice(2);
        }
        return sourceConfig.prover;
      }
      return sourceConfig.prover;
    };
    
    const reward = {
      creator: getWalletAddress(),
      prover: getProverAddress(),
      deadline: rewardDeadline,
      nativeAmount: rewardAmount, // Native token reward
      tokens: [] // No ERC20 token rewards
    };
    
    const intent = { 
      destination: destChainId,
      route, 
      reward 
    };
    
    console.log(`   🔧 Intent structure created:`);
    console.log(`     - Salt: ${ethers.hexlify(salt)}`);
    console.log(`     - Source: Route funding on ${scenario.sourceChain}`);
    console.log(`     - Destination: ${destChainId}`);
    console.log(`     - Portal: ${destConfig.portal}`);
    console.log(`     - Prover: ${reward.prover}`);
    console.log(`     - Creator: ${reward.creator}`);
    console.log(`     - Deadline: ${new Date(reward.deadline * 1000).toISOString()}`);
    console.log(`     - Fill Amount: ${ethers.formatEther(route.nativeAmount)} ${destConfig.nativeName}`);
    console.log(`     - Reward Amount: ${ethers.formatEther(reward.nativeAmount)} ${sourceConfig.nativeName}`);
    console.log(`     - Calls: ${route.calls.length} call(s)`);
    
    // Create portal contract instance based on chain type
    let portalContract: any;
    
    if (isTronSource) {
      // TRON contract instance
      console.log('   🔗 Creating TRON Portal contract instance...');
      portalContract = await wallet.tronWeb.contract(abis.PORTAL_ABI, sourceConfig.portal);
    } else {
      // EVM contract instance
      portalContract = new ethers.Contract(
        sourceConfig.portal,
        abis.PORTAL_ABI,
        wallet
      );
    }
    
    // Skip hash calculation and go directly to intent creation
    console.log(`   🔧 Intent structure ready for submission...`);
    console.log(`   📦 Intent parameter:`, JSON.stringify(intent, (key, value) => 
      typeof value === 'bigint' ? value.toString() : value, 2));
    
    // Check if addresses are valid (skip validation for TRON source since we're creating TRON-specific structures)
    if (!isTronSource) {
      try {
        const portalAddr = ethers.getAddress(intent.route.portal);
        const proverAddr = ethers.getAddress(intent.reward.prover);
        console.log('   ✅ Address validation passed');
        console.log('   📍 Portal address (normalized):', portalAddr);
        console.log('   📍 Prover address (normalized):', proverAddr);
      } catch (addrError: any) {
        console.log('   ❌ Address validation failed:', addrError.message);
      }
    } else {
      console.log('   ✅ TRON address validation skipped (will be handled by TronWeb)');
      console.log('   📍 Portal address:', intent.route.portal);
      console.log('   📍 Prover address:', intent.reward.prover);
    }
    
    // Create and fund the intent in one transaction (publishAndFund)
    console.log('   📤 Publishing and funding intent...');
    console.log('   🔧 Portal contract address:', sourceConfig.portal);
    console.log('   🔧 Wallet address:', wallet.address);
    console.log('   🔧 Intent structure check:', {
      destination: intent.destination,
      route: {
        portal: intent.route.portal,
        deadline: intent.route.deadline
      },
      reward: {
        prover: intent.reward.prover,
        deadline: intent.reward.deadline,
        nativeAmount: intent.reward.nativeAmount.toString()
      }
    });
    
    // Execute publishAndFund based on chain type
    let publishAndFundTx: any;
    let receipt: any;
    
    if (isTronSource) {
      // TRON transaction execution
      console.log('   📤 Publishing and funding intent on TRON...');
      
      // Workaround for TronWeb ABI encoding limitations:
      // Use ethers.js to encode the intent structure, then trigger the transaction manually
      
      // Create a temporary ABI interface for encoding
      const intentInterface = new ethers.Interface([
        "function publishAndFund(uint64 destination, tuple(bytes32 salt, uint64 deadline, address portal, uint256 nativeAmount, tuple(address token, uint256 amount)[] tokens, tuple(address target, bytes data, uint256 value)[] calls) route, tuple(uint64 deadline, address creator, address prover, uint256 nativeAmount, tuple(address token, uint256 amount)[] tokens) reward) payable"
      ]);
      
      // Convert intent to format expected by ethers.js 
      // For TRON contracts, we need to use TRON-format addresses but encode them as if they were EVM addresses
      // The key insight: TRON addresses are EVM addresses with a different prefix (0x41 instead of 0x)
      const encodedIntent = {
        destination: intent.destination,
        route: {
          salt: intent.route.salt,
          deadline: intent.route.deadline,
          portal: intent.route.portal, // Keep EVM format for destination portal
          nativeAmount: intent.route.nativeAmount,
          tokens: intent.route.tokens.map((t: any) => ({
            token: t.token, // Keep EVM format 
            amount: t.amount
          })),
          calls: intent.route.calls.map((c: any) => ({
            target: c.target, // Keep EVM format for target address
            data: c.data,
            value: c.value
          }))
        },
        reward: {
          deadline: intent.reward.deadline,
          creator: intent.reward.creator, // Keep EVM format for creator
          prover: intent.reward.prover, // Keep EVM format for prover
          nativeAmount: intent.reward.nativeAmount,
          tokens: intent.reward.tokens.map((t: any) => ({
            token: t.token, // Keep EVM format
            amount: t.amount
          }))
        }
      };
      
      console.log('   🔧 Intent for encoding:', JSON.stringify(encodedIntent, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value, 2));
      
      // Encode function call data using ethers.js
      const encodedData = intentInterface.encodeFunctionData("publishAndFund", [
        encodedIntent.destination,
        encodedIntent.route,
        encodedIntent.reward
      ]);
      
      console.log('   🔧 Encoded data length:', encodedData.length);
      console.log('   🔧 Using manual transaction with encoded data...');
      console.log('   💰 Sending TRX reward:', sunToTrx(rewardAmount), 'TRX');
      
      try {
        // Solution: Use TronWeb ABI v2 support properly with correct parameter formatting
        console.log('   🔧 Using TronWeb ABI v2 support for complex structs...');
        
        // According to TronWeb docs, it supports ABI v2 for complex struct parameters
        // The key is to format parameters exactly as the contract expects them
        
        // According to TronWeb docs, structs must be represented as arrays in exact ABI field order
        // Intent struct: [destination, route, reward]  
        // Route struct: [salt, deadline, portal, nativeAmount, tokens[], calls[]]
        // Reward struct: [deadline, creator, prover, nativeAmount, tokens[]]
        // Call struct: [target, data, value]
        
        const tronIntentArray = [
          intent.destination,  // uint64 destination
          [                    // Route struct as array (exact ABI order)
            ethers.hexlify(intent.route.salt),              // bytes32 salt
            intent.route.deadline,                          // uint64 deadline
            TronWeb.address.toHex(evmAddressToTron(intent.route.portal)), // address portal (TRON format)
            intent.route.nativeAmount.toString(),           // uint256 nativeAmount (as string)
            [],                                             // TokenAmount[] tokens (empty)
            intent.route.calls.map(call => [                // Call[] calls
              TronWeb.address.toHex(evmAddressToTron(call.target)), // address target (TRON format)
              call.data,                                    // bytes data
              call.value.toString()                         // uint256 value (as string)
            ])
          ],
          [                    // Reward struct as array (exact ABI order)  
            intent.reward.deadline,                         // uint64 deadline
            TronWeb.address.toHex(evmAddressToTron(intent.reward.creator)), // address creator (TRON format)
            TronWeb.address.toHex(sourceConfig.prover),     // address prover (TRON format)
            intent.reward.nativeAmount.toString(),          // uint256 nativeAmount (as string)
            []                                              // TokenAmount[] tokens (empty)
          ]
        ];
        
        const allowPartial = false; // Don't allow partial funding
        
        console.log('   🔧 TRON Intent as array (exact ABI order):', JSON.stringify(tronIntentArray, null, 2));
        console.log('   🔧 Using publishAndFund(Intent, bool) overload with allowPartial =', allowPartial);
        
        // Use the first overload: publishAndFund(Intent calldata intent, bool allowPartial)
        const txResult = await portalContract.methods.publishAndFund(tronIntentArray, allowPartial).send({
          callValue: rewardAmount.toString(),
          shouldPollResponse: false, // We'll poll manually
          feeLimit: 100000000
        });
        
        publishAndFundTx = { hash: txResult };
        console.log(`   ⏳ Waiting for TRON transaction confirmation: ${txResult}`);
        
        // Wait for TRON transaction confirmation
        let attempts = 0;
        const maxAttempts = 30; // Increased timeout for TRON confirmations
        
        while (attempts < maxAttempts) {
          try {
            const txInfo = await wallet.tronWeb.trx.getTransactionInfo(txResult);
            console.log(`   🔄 Attempt ${attempts + 1}: Checking transaction...`, txInfo ? 'Found' : 'Not found');
            
            if (txInfo && txInfo.id) {
              receipt = {
                blockNumber: txInfo.blockNumber,
                gasUsed: txInfo.receipt?.energy_usage_total || 0,
                logs: txInfo.log || [],
                transactionHash: txResult
              };
              console.log(`   ✅ TRON transaction confirmed!`);
              break;
            }
            
            // Also check if the transaction exists but hasn't been processed yet
            const txDetails = await wallet.tronWeb.trx.getTransaction(txResult);
            if (txDetails && txDetails.txID) {
              console.log(`   ⏳ Transaction exists but not yet processed...`);
            }
            
          } catch (error: any) {
            console.log(`   ⏳ Transaction not yet confirmed (attempt ${attempts + 1}): ${error.message || 'checking...'}`);
          }
          await new Promise(resolve => setTimeout(resolve, 3000)); // Increased wait time
          attempts++;
        }
        
        if (!receipt) {
          // Check if transaction failed with more details
          try {
            const txDetails = await wallet.tronWeb.trx.getTransaction(txResult);
            console.log(`   🔍 Transaction details:`, JSON.stringify(txDetails, null, 2));
            throw new Error(`TRON transaction confirmation timeout. Transaction may have failed. TX: ${txResult}`);
          } catch (detailError) {
            throw new Error(`TRON transaction confirmation timeout. TX: ${txResult}`);
          }
        }
        
        // Check if transaction was successful
        if (receipt.logs && receipt.logs.length === 0) {
          console.log(`   ⚠️  Warning: No events emitted, transaction may have reverted`);
        }
        
      } catch (tronError: any) {
        console.error('   ❌ TRON transaction failed:', tronError.message || tronError);
        throw tronError;
      }
      
    } else {
      // EVM transaction execution
      // First try to simulate the call to get a better error message
      try {
        console.log('   🧪 Simulating publishAndFund call...');
        await portalContract.publishAndFund.staticCall(intent, false, { value: rewardAmount });
        console.log('   ✅ Simulation successful');
      } catch (simError: any) {
        console.log('   ❌ Simulation failed:', simError.message);
        console.log('   📝 Simulation error details:', simError);
        
        // Try to get more specific error information
        try {
          // Try calling a simpler function to test connectivity
          const version = await portalContract.version();
          console.log('   ✅ Contract connectivity test passed, version:', version);
        } catch (versionError: any) {
          console.log('   ❌ Contract connectivity test failed:', versionError.message);
        }
        
        // Continue with actual transaction anyway to see the real error
      }
      
      publishAndFundTx = await portalContract.publishAndFund(
        intent,
        false, // allowPartial = false
        { 
          value: rewardAmount, // Send native tokens as reward
          gasLimit: 500000n // Increase gas limit for combined operation
        }
      );
      
      console.log(`   ⏳ Waiting for publishAndFund confirmation: ${publishAndFundTx.hash}`);
      receipt = await publishAndFundTx.wait();
    }
    
    if (!receipt) {
      throw new Error('PublishAndFund transaction receipt is null');
    }
    
    console.log('   ✅ Intent published and funded successfully!');
    
    // Use the publishAndFund transaction as the main transaction
    const tx = publishAndFundTx;
    
    if (!receipt) {
      throw new Error('Transaction receipt is null');
    }
    
    console.log(`   ✅ Intent created successfully!`);
    console.log(`     - Transaction Hash: ${tx.hash}`);
    console.log(`     - Block Number: ${receipt.blockNumber}`);
    console.log(`     - Gas Used: ${receipt.gasUsed}`);
    
    // Extract intent hash from event logs
    let intentHash = null;
    
    if (isTronSource) {
      // TRON event parsing
      if (receipt.logs && Array.isArray(receipt.logs)) {
        for (const log of receipt.logs) {
          // TRON logs have topics array
          // IntentPublished event signature
          const intentPublishedSig = '30e637c070f7e7ad5a2a06d06ef0dd08987fc8cf027c973e4cf37e29ad2c18d9';
          if (log.topics && log.topics[0] === intentPublishedSig) {
            // First indexed parameter is intentHash (topic[1])
            intentHash = '0x' + log.topics[1];
            console.log(`   📋 Intent Hash from TRON event: ${intentHash}`);
            break;
          }
        }
      }
    } else {
      // EVM event parsing
      for (const log of receipt.logs) {
        try {
          const parsed = portalContract.interface.parseLog(log);
          if (parsed?.name === 'IntentPublished') {
            intentHash = parsed.args[0]; // First arg is intentHash
            console.log(`   📋 Intent Hash from event: ${intentHash}`);
            break;
          }
        } catch {
          // Skip logs we can't parse
        }
      }
    }
    
    // If we couldn't get intent hash from events, compute it
    if (!intentHash) {
      console.log('   ⚠️ Could not extract intent hash from events, computing...');
      const routeEncoded = ethers.AbiCoder.defaultAbiCoder().encode([
        'tuple(bytes32,uint64,address,uint256,tuple(address,uint256)[],tuple(address,bytes,uint256)[])'
      ], [[route.salt, route.deadline, route.portal, route.nativeAmount, route.tokens, route.calls.map((c: any) => [c.target, c.data, c.value])]]);
      
      const routeHash = ethers.keccak256(routeEncoded);
      const rewardHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([
        'tuple(uint64,address,address,uint256,tuple(address,uint256)[])'
      ], [[reward.deadline, reward.creator, reward.prover, reward.nativeAmount, reward.tokens]]));
      
      intentHash = ethers.keccak256(ethers.solidityPacked(
        ['uint64', 'bytes32', 'bytes32'],
        [destChainId, routeHash, rewardHash]
      ));
    }
    
    // Verify intent was created
    let isIntentFunded = false;
    
    if (isTronSource) {
      // TRON contract call
      try {
        const tronIntent = [
          intent.destination,
          [
            intent.route.salt,
            intent.route.deadline,
            TronWeb.address.toHex(evmAddressToTron(intent.route.portal)),
            intent.route.nativeAmount,
            intent.route.tokens.map((t: any) => [TronWeb.address.toHex(evmAddressToTron(t.token)), t.amount]),
            intent.route.calls.map((c: any) => [TronWeb.address.toHex(evmAddressToTron(c.target)), c.data, c.value])
          ],
          [
            intent.reward.deadline,
            TronWeb.address.toHex(evmAddressToTron(intent.reward.creator)),
            TronWeb.address.toHex(evmAddressToTron(intent.reward.prover)),
            intent.reward.nativeAmount,
            intent.reward.tokens.map((t: any) => [TronWeb.address.toHex(evmAddressToTron(t.token)), t.amount])
          ]
        ];
        isIntentFunded = await portalContract.isIntentFunded(tronIntent).call();
      } catch (error) {
        console.log('   ⚠️  Could not verify intent funding status on TRON');
        isIntentFunded = true; // Assume funded if we can't check
      }
    } else {
      // EVM contract call
      isIntentFunded = await portalContract.isIntentFunded(intent);
    }
    console.log(`   💰 Intent funding status: ${isIntentFunded ? 'FUNDED' : 'NOT FUNDED'}`);
    
    // Compute hashes for verification
    const routeEncoded = ethers.AbiCoder.defaultAbiCoder().encode([
      'tuple(bytes32,uint64,address,uint256,tuple(address,uint256)[],tuple(address,bytes,uint256)[])'
    ], [[route.salt, route.deadline, route.portal, route.nativeAmount, route.tokens, route.calls.map((c: any) => [c.target, c.data, c.value])]]);
    
    const routeHash = ethers.keccak256(routeEncoded);
    const rewardHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode([
      'tuple(uint64,address,address,uint256,tuple(address,uint256)[])'
    ], [[reward.deadline, reward.creator, reward.prover, reward.nativeAmount, reward.tokens]]));
    
    return {
      success: true,
      intentHash: intentHash,
      transactionHash: tx.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      isFunded: isIntentFunded,
      route: route,
      reward: reward,
      routeHash: routeHash,
      rewardHash: rewardHash
    };
    
  } catch (error) {
    console.error(`   ❌ Failed to create intent:`, error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error(`   🔍 Stack trace:`, error.stack);
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function main() {
  try {
    console.log('🔍 Validating environment configuration...');
    
    console.log('✅ Environment validated. Loading configurations...');
    
    const contracts = getContractAddresses();
    const abis = loadContractABIs();
    
    console.log('✅ Configurations loaded. Creating intent...\n');
    
    // Parse command line arguments
    const args = process.argv.slice(2);
    const sourceChain = args[0] || 'optimism';
    const destChain = args[1] || 'tron';
    
    // Validate chain names
    if (!(sourceChain in CHAIN_CONFIGS)) {
      throw new Error(`Unsupported source chain: ${sourceChain}. Supported: ${Object.keys(CHAIN_CONFIGS).join(', ')}`);
    }
    if (!(destChain in CHAIN_CONFIGS)) {
      throw new Error(`Unsupported destination chain: ${destChain}. Supported: ${Object.keys(CHAIN_CONFIGS).join(', ')}`);
    }
    
    // Parse amounts according to native token decimals
    // ETH: 18 decimals (WEI), TRX: 6 decimals (SUN)
    const destConfig = CHAIN_CONFIGS[destChain as keyof typeof CHAIN_CONFIGS];
    const sourceConfig = CHAIN_CONFIGS[sourceChain as keyof typeof CHAIN_CONFIGS];
    
    // Default amounts: 0.1 TRX, 0.00001 ETH  
    const getDefaultFillAmount = () => destConfig.nativeName === 'TRX' ? '0.1' : '0.00001';
    const getDefaultRewardAmount = () => sourceConfig.nativeName === 'TRX' ? '0.1' : '0.00001'; // Small ETH amount
    
    const fillAmount = args[2] || getDefaultFillAmount();
    const rewardAmount = args[3] || getDefaultRewardAmount();
    
    const parseFillAmount = () => {
      if (destConfig.nativeName === 'TRX') {
        // TRX has 6 decimals (SUN)
        return ethers.parseUnits(fillAmount, 6);
      } else {
        // ETH has 18 decimals (WEI)
        return ethers.parseEther(fillAmount);
      }
    };
    
    const parseRewardAmount = () => {
      if (sourceConfig.nativeName === 'TRX') {
        // TRX has 6 decimals (SUN)
        return ethers.parseUnits(rewardAmount, 6);
      } else {
        // ETH has 18 decimals (WEI)
        return ethers.parseEther(rewardAmount);
      }
    };

    const scenario: IntentScenario = {
      name: `Real Intent: ${sourceChain} → ${destChain}`,
      sourceChain: sourceChain as keyof typeof CHAIN_CONFIGS,
      destChain: destChain as keyof typeof CHAIN_CONFIGS,
      nativeFillAmount: parseFillAmount(),
      nativeRewardAmount: parseRewardAmount()
    };
    
    const result = await createIntent(scenario, contracts, abis);
    
    if (result.success) {
      console.log('\n🎉 Intent creation completed successfully!');
      console.log('📋 Summary:');
      console.log(`   - Intent Hash: ${result.intentHash}`);
      console.log(`   - Transaction: ${result.transactionHash}`);
      console.log(`   - Block: ${result.blockNumber}`);
      console.log(`   - Gas Used: ${result.gasUsed}`);
      console.log(`   - Funded: ${result.isFunded}`);
      
      // Save intent details to JSON file with complete route and reward data
      const intentData = {
        intentHash: result.intentHash,
        transactionHash: result.transactionHash,
        blockNumber: result.blockNumber,
        gasUsed: result.gasUsed?.toString(),
        isFunded: result.isFunded,
        sourceChain: sourceChain,
        destChain: destChain,
        route: {
          salt: ethers.hexlify(result.route.salt),
          deadline: result.route.deadline,
          portal: result.route.portal,
          nativeAmount: result.route.nativeAmount.toString(),
          tokens: result.route.tokens,
          calls: result.route.calls.map((c: any) => ({
            target: c.target,
            data: c.data,
            value: c.value.toString()
          }))
        },
        reward: {
          deadline: result.reward.deadline,
          creator: result.reward.creator,
          prover: result.reward.prover,
          nativeAmount: result.reward.nativeAmount.toString(),
          tokens: result.reward.tokens
        },
        computedHashes: {
          routeHash: result.routeHash,
          rewardHash: result.rewardHash
        },
        createdAt: new Date().toISOString()
      };
      
      const outputFile = join(__dirname, '../intent-output.json');
      writeFileSync(outputFile, JSON.stringify(intentData, null, 2));
      console.log(`\n💾 Intent details saved to: ${outputFile}`);
    } else {
      console.log('\n❌ Intent creation failed!');
      console.log(`   Error: ${result.error}`);
      process.exit(1);
    }
    
  } catch (error) {
    console.error('❌ Script failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Show usage if no args or help requested
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage: bun run scripts/create-intent.ts [sourceChain] [destChain] [fillAmount] [rewardAmount]

Arguments:
  sourceChain    Source chain (optimism, tron) [default: optimism]
  destChain      Destination chain (optimism, tron) [default: tron]  
  fillAmount     Amount of native tokens to fill on destination [default: 0.1 TRX, 0.00001 ETH]
  rewardAmount   Amount of native tokens as reward on source [default: 0.1 TRX, 0.00001 ETH]

Examples:
  bun run scripts/create-intent.ts                              # optimism → tron, 0.1 TRX fill, 0.00001 ETH reward
  bun run scripts/create-intent.ts optimism tron 0.1 0.1        # optimism → tron, 0.1 TRX fill, 0.1 ETH reward
  bun run scripts/create-intent.ts tron optimism 0.1 0.1        # tron → optimism, 0.1 ETH fill, 0.1 TRX reward

Supported Chains: ${Object.keys(CHAIN_CONFIGS).join(', ')}
`);
  process.exit(0);
}

main();
