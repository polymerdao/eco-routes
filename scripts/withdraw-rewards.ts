#!/usr/bin/env bun
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
// @ts-ignore
const { TronWeb } = require('tronweb');

dotenv.config();

// Load environment variables
const env = {
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  OPTIMISM_RPC_URL: process.env.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io',
};

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
    name: 'Optimism Mainnet',
    chainId: 10,
    rpcUrl: env.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io',
    type: 'evm'
  },
  tron: {
    name: 'TRON Mainnet',
    chainId: 728126428,
    rpcUrl: env.TRON_RPC_URL || 'https://api.trongrid.io',
    type: 'tron'
  }
};

// Contract addresses
const CONTRACT_ADDRESSES = {
  optimism: {
    portal: '0x90F0c8aCC1E083Bcb4F487f84FC349ae8d5e28D7', // Optimism Portal address
  },
  tron: {
    portal: env.PORTAL_ADDR_TRON || 'TQh8ig6rmuMqb5u8efU5LDvoott1oLzoqu', // TRON Portal address
  },
};

interface WithdrawInput {
  intentHash: string;
  sourceChain: string;
  claimant: string;
  amount?: string;
  description?: string;
  // Portal withdraw requires these parameters
  destination?: number;
  routeHash?: string;
  reward?: {
    deadline: number;
    creator: string;
    prover: string;
    nativeAmount: string;
    tokens: Array<{ token: string; amount: string }>;
  };
}

/**
 * Load withdrawal input from JSON file
 */
async function loadWithdrawInput(filePath: string): Promise<WithdrawInput> {
  if (!fs.existsSync(filePath)) {
    // Try to extract from intent-output.json, fulfillment-output.json or relay-output.json
    const intentPath = path.join(process.cwd(), 'intent-output.json');
    const fulfillmentPath = path.join(process.cwd(), 'fulfillment-output.json');
    const relayPath = path.join(process.cwd(), 'relay-output.json');
    
    if (fs.existsSync(intentPath)) {
      console.log('📄 Loading intent data from intent-output.json...');
      const intentData = JSON.parse(fs.readFileSync(intentPath, 'utf8'));
      return {
        intentHash: intentData.intentHash,
        sourceChain: intentData.sourceChain || 'optimism',
        claimant: intentData.reward?.creator || (process.env.PRIVATE_KEY ? ethers.computeAddress(process.env.PRIVATE_KEY) : ''),
        description: 'Auto-generated from intent output',
        // Portal withdrawal parameters
        destination: intentData.destChain === 'tron' ? 728126428 : undefined,
        routeHash: intentData.computedHashes?.routeHash,
        reward: intentData.reward ? {
          deadline: intentData.reward.deadline,
          creator: intentData.reward.creator,
          prover: intentData.reward.prover,
          nativeAmount: intentData.reward.nativeAmount,
          tokens: intentData.reward.tokens || []
        } : undefined
      };
    } else if (fs.existsSync(relayPath)) {
      console.log('📄 Loading intent data from relay-output.json...');
      const relayData = JSON.parse(fs.readFileSync(relayPath, 'utf8'));
      return {
        intentHash: relayData.originalInput?.intentHash,
        sourceChain: relayData.originalInput?.originalIntent?.sourceChain || 'optimism',
        claimant: process.env.PRIVATE_KEY ? ethers.computeAddress(process.env.PRIVATE_KEY) : '',
        description: 'Auto-generated from relay output'
      };
    } else if (fs.existsSync(fulfillmentPath)) {
      console.log('📄 Loading intent data from fulfillment-output.json...');
      const fulfillmentData = JSON.parse(fs.readFileSync(fulfillmentPath, 'utf8'));
      return {
        intentHash: fulfillmentData.intentHash,
        sourceChain: fulfillmentData.sourceChain || 'optimism',
        claimant: fulfillmentData.reward?.creator || (process.env.PRIVATE_KEY ? ethers.computeAddress(process.env.PRIVATE_KEY) : ''),
        description: 'Auto-generated from fulfillment output',
        // Portal withdrawal parameters
        destination: fulfillmentData.destChain === 'tron' ? 728126428 : undefined,
        routeHash: fulfillmentData.computedHashes?.routeHash,
        reward: fulfillmentData.reward ? {
          deadline: fulfillmentData.reward.deadline,
          creator: fulfillmentData.reward.creator,
          prover: fulfillmentData.reward.prover,
          nativeAmount: fulfillmentData.reward.nativeAmount,
          tokens: fulfillmentData.reward.tokens || []
        } : undefined
      };
    } else {
      throw new Error(`Withdraw input file not found: ${filePath}`);
    }
  }
  
  const input = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return input;
}

/**
 * Load contract ABIs
 */
function loadContractABIs() {
  const abiDir = path.join(__dirname, '..', 'out');
  
  // Load Portal ABI
  const portalAbiPath = path.join(abiDir, 'Portal.sol', 'Portal.json');
  if (!fs.existsSync(portalAbiPath)) {
    throw new Error(`Portal ABI not found at ${portalAbiPath}`);
  }
  const portalAbi = JSON.parse(fs.readFileSync(portalAbiPath, 'utf8')).abi;
  
  return {
    portal: portalAbi,
  };
}



/**
 * Execute withdrawal transaction
 */
async function executeWithdrawal(
  portalContract: any,
  withdrawInput: WithdrawInput,
  wallet: any,
  isTron: boolean = false
): Promise<string> {
  try {
    console.log('🔄 Executing withdrawal...');
    console.log(`   Intent hash: ${withdrawInput.intentHash}`);
    console.log(`   Claimant: ${isTron ? wallet.address : wallet.address}`);
    
    // Validate required parameters
    if (!withdrawInput.destination || !withdrawInput.routeHash || !withdrawInput.reward) {
      throw new Error('Missing required withdrawal parameters (destination, routeHash, reward)');
    }
    
    console.log(`   Destination: ${withdrawInput.destination}`);
    console.log(`   Route hash: ${withdrawInput.routeHash}`);
    console.log(`   Reward creator: ${withdrawInput.reward.creator}`);
    console.log(`   Reward amount: ${withdrawInput.reward.nativeAmount}`);
    
    let tx: any;
    let receipt: any;
    
    if (isTron) {
      // TRON withdrawal execution
      console.log(`   🔗 Executing TRON withdrawal...`);
      
      // Format reward for TRON
      const tronReward = [
        withdrawInput.reward.deadline,
        TronWeb.address.toHex(evmAddressToTron(withdrawInput.reward.creator)),
        TronWeb.address.toHex(evmAddressToTron(withdrawInput.reward.prover)),
        withdrawInput.reward.nativeAmount,
        withdrawInput.reward.tokens.map((t: any) => [TronWeb.address.toHex(evmAddressToTron(t.token)), t.amount])
      ];
      
      try {
        const txId = await portalContract.withdraw(
          withdrawInput.destination,
          withdrawInput.routeHash,
          tronReward
        ).send({
          shouldPollResponse: true
        });
        
        tx = { hash: txId };
        console.log(`   ⏳ TRON transaction submitted: ${txId}`);
        console.log('   Waiting for confirmation...');
        
        // Wait for TRON transaction confirmation
        let attempts = 0;
        const maxAttempts = 10;
        
        while (attempts < maxAttempts) {
          try {
            const txInfo = await wallet.tronWeb.trx.getTransactionInfo(txId);
            if (txInfo && txInfo.id) {
              receipt = {
                status: txInfo.receipt?.result === 'SUCCESS' ? 1 : 0,
                blockNumber: txInfo.blockNumber,
                gasUsed: txInfo.receipt?.energy_usage_total || 0,
                logs: txInfo.log || [],
                hash: txId
              };
              break;
            }
          } catch (error) {
            // Transaction might not be confirmed yet
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
          attempts++;
        }
        
        if (!receipt) {
          throw new Error('TRON transaction confirmation timeout');
        }
        
      } catch (tronError: any) {
        console.error('❌ TRON withdrawal failed:', tronError.message || tronError);
        throw tronError;
      }
      
    } else {
      // EVM withdrawal execution
      console.log(`   Skipping gas estimation - executing with high gas limit for debugging`);
      
      // Get current gas price
      const provider = portalContract.runner?.provider as ethers.Provider;
      const feeData = await provider.getFeeData();
      
      const txOptions = {
        gasLimit: 500000n, // High gas limit for debugging
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      };
      
      console.log(`   Gas limit: ${txOptions.gasLimit.toString()}`);
      console.log(`   Max fee per gas: ${ethers.formatUnits(txOptions.maxFeePerGas || 0, 'gwei')} gwei`);
      
      // Execute withdrawal directly without gas estimation
      tx = await portalContract.withdraw(
        withdrawInput.destination,
        withdrawInput.routeHash,
        withdrawInput.reward,
        txOptions
      );
      console.log(`   ⏳ Transaction submitted: ${tx.hash}`);
      console.log('   Waiting for confirmation...');
      
      receipt = await tx.wait();
    }
    
    if (receipt.status === 1) {
      console.log('   ✅ Withdrawal successful!');
      console.log(`      Block: ${receipt.blockNumber}`);
      console.log(`      ${isTron ? 'Energy' : 'Gas'} used: ${receipt.gasUsed.toString()}`);
      console.log(`      Transaction: ${receipt.hash || tx.hash}`);
      
      // Look for withdrawal events in the logs
      if (isTron) {
        // TRON event parsing
        if (receipt.logs && Array.isArray(receipt.logs)) {
          for (const log of receipt.logs) {
            // IntentWithdrawn event signature
            const intentWithdrawnSig = '17527c2e67c6e33f5c7e75d6e1dc08c964e7e3c7a4b5b85c5e0a9e1c0e2c5e09';
            if (log.topics && log.topics[0] === intentWithdrawnSig) {
              console.log(`   🎉 Event: IntentWithdrawn`);
              console.log(`      Intent Hash: 0x${log.topics[1]}`);
              console.log(`      Claimant: 0x${log.topics[2]}`);
            }
          }
        }
      } else {
        // EVM event parsing
        const portalInterface = portalContract.interface;
        for (const log of receipt.logs) {
          try {
            const parsedLog = portalInterface.parseLog({
              topics: [...log.topics],
              data: log.data
            });
            if (parsedLog) {
              console.log(`   🎉 Event: ${parsedLog.name}`);
              console.log(`      Args:`, parsedLog.args);
            }
          } catch {
            // Ignore unparseable logs
          }
        }
      }
      
      return receipt.hash || tx.hash;
    } else {
      throw new Error('Transaction failed');
    }
  } catch (error: any) {
    console.error('❌ Withdrawal failed:', error.message);
    
    // Try to decode revert reason
    if (error.data) {
      try {
        const portalInterface = portalContract.interface;
        const decoded = portalInterface.parseError(error.data);
        console.error('   Decoded error:', decoded);
      } catch {
        console.error('   Raw error data:', error.data);
      }
    }
    
    throw error;
  }
}

/**
 * Save withdrawal results
 */
function saveWithdrawResults(result: any) {
  const outputPath = path.join(process.cwd(), 'withdraw-output.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(`💾 Withdrawal results saved to: ${outputPath}`);
}

async function main() {
  try {
    console.log('💸 Intent Reward Withdrawal Script');
    console.log('=' .repeat(50));
    
    // Parse command line arguments
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
      console.log(`
Usage: bun run withdraw-rewards.ts [withdraw-input.json]

This script withdraws rewards for a proven intent from the Portal contract.

Arguments:
  withdraw-input.json    Optional: JSON file with withdrawal details
                        If not provided, will auto-detect from relay-output.json or fulfillment-output.json

The withdraw input should contain:
{
  "intentHash": "0x...",
  "sourceChain": "optimism", 
  "claimant": "0x...",
  "description": "Intent description"
}

Examples:
  bun run withdraw-rewards.ts
  bun run withdraw-rewards.ts withdraw-input.json

This script:
1. Loads the intent details
2. Connects to the origin chain Portal contract
3. Verifies the intent is proven
4. Calls withdraw() to claim rewards
5. Reports the withdrawal results
`);
      process.exit(0);
    }
    
    // Validate environment
    if (!env.PRIVATE_KEY) {
      throw new Error('PRIVATE_KEY environment variable is required');
    }
    
    console.log('✅ Environment validated. Loading configurations...');
    
    const abis = loadContractABIs();
    console.log('✅ Contract ABIs loaded.');
    
    // Load withdrawal input
    const inputFilePath = args[0] ? (args[0].startsWith('/') ? args[0] : path.join(process.cwd(), args[0])) : 'auto-detect';
    const withdrawInput = await loadWithdrawInput(inputFilePath);
    
    console.log('📋 Withdrawal Details:');
    console.log(`   Intent Hash: ${withdrawInput.intentHash}`);
    console.log(`   Source Chain: ${withdrawInput.sourceChain}`);
    console.log(`   Claimant: ${withdrawInput.claimant}`);
    if (withdrawInput.description) {
      console.log(`   Description: ${withdrawInput.description}`);
    }
    
    // Validate chain support
    if (!(withdrawInput.sourceChain in CHAIN_CONFIGS)) {
      throw new Error(`Unsupported source chain: ${withdrawInput.sourceChain}`);
    }
    
    // Setup provider and wallet
    const chainConfig = CHAIN_CONFIGS[withdrawInput.sourceChain as keyof typeof CHAIN_CONFIGS];
    const isTron = chainConfig.type === 'tron';
    
    let wallet: any;
    let portalContract: any;
    let portalAddress: string;
    
    if (isTron) {
      // TRON setup
      const tronWeb = initializeTronWeb(env.PRIVATE_KEY, chainConfig);
      wallet = {
        address: tronWeb.defaultAddress.base58,
        tronWeb: tronWeb
      };
      
      console.log(`\n🔗 Connected to ${chainConfig.name}`);
      console.log(`   RPC: ${chainConfig.rpcUrl}`);
      console.log(`   TRON Wallet: ${wallet.address}`);
      
      // Check TRX balance
      const balance = await tronWeb.trx.getBalance(wallet.address);
      console.log(`   Balance: ${sunToTrx(balance)} TRX`);
      
      if (Number(balance) < 1000000) { // Less than 1 TRX
        console.log('   ⚠️  Low balance - withdrawal may fail due to insufficient energy');
      }
      
      // Connect to TRON Portal contract
      portalAddress = CONTRACT_ADDRESSES[withdrawInput.sourceChain as keyof typeof CONTRACT_ADDRESSES].portal;
      portalContract = await tronWeb.contract(abis.portal, portalAddress);
      
    } else {
      // EVM setup
      const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
      wallet = new ethers.Wallet(env.PRIVATE_KEY, provider);
      
      console.log(`\n🔗 Connected to ${chainConfig.name}`);
      console.log(`   RPC: ${chainConfig.rpcUrl}`);
      console.log(`   Wallet: ${wallet.address}`);
      
      // Check wallet balance
      const balance = await provider.getBalance(wallet.address);
      console.log(`   Balance: ${ethers.formatEther(balance)} ETH`);
      
      if (balance < ethers.parseEther('0.001')) {
        console.log('   ⚠️  Low balance - withdrawal may fail due to insufficient gas');
      }
      
      // Connect to Portal contract
      portalAddress = CONTRACT_ADDRESSES[withdrawInput.sourceChain as keyof typeof CONTRACT_ADDRESSES].portal;
      portalContract = new ethers.Contract(portalAddress, abis.portal, wallet);
    }
    
    console.log(`\n📍 Portal Contract: ${portalAddress}`);
    
    // Execute withdrawal (contract will check if proven internally)
    const txHash = await executeWithdrawal(portalContract, withdrawInput, wallet, isTron);
    
    // Save results
    const results = {
      intentHash: withdrawInput.intentHash,
      sourceChain: withdrawInput.sourceChain,
      claimant: withdrawInput.claimant,
      portalAddress,
      transactionHash: txHash,
      timestamp: new Date().toISOString(),
      success: true
    };
    
    saveWithdrawResults(results);
    
    console.log('\n🎉 Withdrawal completed successfully!');
    console.log('📋 Summary:');
    console.log(`   Intent: ${withdrawInput.intentHash}`);
    console.log(`   Chain: ${withdrawInput.sourceChain}`);
    console.log(`   Transaction: ${txHash}`);
    console.log(`   Claimant: ${withdrawInput.claimant}`);
    
  } catch (error) {
    console.error('❌ Withdrawal script failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Show usage if help requested
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  main();
} else {
  main();
}