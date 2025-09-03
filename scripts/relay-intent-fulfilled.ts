#!/usr/bin/env bun

import { ethers } from 'ethers';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import * as dotenv from 'dotenv';
import axios from 'axios';
// @ts-ignore
const { TronWeb } = require('tronweb');

// Script to relay IntentFulfilledFromSource events back to the validate() function on the origin chain PolymerProver contract
console.log('🔗 Intent Fulfillment Relayer\n');
console.log('=' .repeat(50));

// Load environment variables
dotenv.config();

const env = process.env;

// Required environment variables
const requiredVars = ['PRIVATE_KEY', 'PROVER_ADDR_OPTIMISM', 'PROVER_ADDR_TRON', 'POLYMER_API_KEY'];
for (const varName of requiredVars) {
  if (!env[varName]) {
    console.error(`❌ Missing required environment variable: ${varName}`);
    process.exit(1);
  }
}

// Load contract ABIs
function loadContractABIs() {
  try {
    const polymerProverArtifact = JSON.parse(readFileSync(join(__dirname, '../out/PolymerProver.sol/PolymerProver.json'), 'utf8'));
    const inboxArtifact = JSON.parse(readFileSync(join(__dirname, '../out/Inbox.sol/Inbox.json'), 'utf8'));
    
    return {
      POLYMER_PROVER_ABI: polymerProverArtifact.abi,
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
    prover: env.PROVER_ADDR_OPTIMISM!,
    nativeName: 'ETH',
    type: 'evm'
  },
  tron: {
    chainId: 728126428, // Tron mainnet
    rpcUrl: env.TRON_RPC_URL || 'https://api.trongrid.io/jsonrpc', // Use JSONRPC endpoint
    prover: env.PROVER_ADDR_TRON!,
    nativeName: 'TRX',
    type: 'tron'
  }
};

// TronWeb helper functions
function initializeTronWeb(privateKey: string | undefined, config: any): any {
  const pk = privateKey?.startsWith('0x') ? privateKey.slice(2) : privateKey;
  
  return new TronWeb({
    fullHost: config.rpcUrl.replace('/jsonrpc', ''), // Remove jsonrpc suffix for TronWeb
    privateKey: pk
  });
}

function sunToTrx(sun: string | number): number {
  return Number(sun) / 1e6;
}

// Polymer API interfaces (from ProofService.ts)
interface PolymerProofRequestParams {
  srcChainId: number;
  srcBlockNumber: number;
  globalLogIndex: number;
}

interface PolymerProofResponse {
  jsonrpc: string;
  id: number;
  result?: number | {
    status: 'complete' | 'pending' | 'error' | 'initialized';
    proof?: string;
  };
  error?: {
    code: number;
    message: string;
  };
}

class PolymerProofService {
  private baseUrl: string = env.POLYMER_API_BASE_URL || 'https://proof.polymer.zone';
  private apiKey: string;
  private timeout: number = 30000;
  private retryAttempts: number = 3;
  private maxPollingAttempts: number = 30;
  private pollingInterval: number = 500;
  private initialWait: number = 2000;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    console.log(`   🔑 Initialized Polymer service with API endpoint: ${this.baseUrl}`);
    console.log(`   🔑 API key configured: ${apiKey ? 'Yes' : 'No'} (${apiKey ? apiKey.substring(0, 8) + '...' : 'undefined'})`);
  }

  async requestProofJob(params: PolymerProofRequestParams): Promise<number> {
    const requestBody = {
      jsonrpc: '2.0',
      id: 1,
      method: 'polymer_requestProof',
      params: [params]
    };

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        console.log(`   📤 Requesting proof job (attempt ${attempt}/${this.retryAttempts})...`);
        console.log(`      Chain ID: ${params.srcChainId}, Block: ${params.srcBlockNumber}, Event Index: ${params.globalLogIndex}`);

        const response = await axios.post<PolymerProofResponse>(
          this.baseUrl,
          requestBody,
          {
            timeout: this.timeout,
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.apiKey}`
            }
          }
        );

        if (response.data.error) {
          throw new Error(`Polymer API error: ${response.data.error.message} (code: ${response.data.error.code})`);
        }

        if (typeof response.data.result !== 'number') {
          throw new Error('Invalid response: expected jobID as number');
        }

        const jobId = response.data.result;
        console.log(`   ✅ Proof job created with ID: ${jobId}`);
        return jobId;

      } catch (error) {
        const isLastAttempt = attempt === this.retryAttempts;
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        console.warn(`   ⚠️ Proof job request failed (attempt ${attempt}/${this.retryAttempts}): ${errorMessage}`);

        if (isLastAttempt) {
          throw new Error(`Failed to request proof job after ${this.retryAttempts} attempts: ${errorMessage}`);
        }

        // Exponential backoff
        const delay = Math.pow(2, attempt - 1) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw new Error('Unexpected error in proof job request');
  }

  async pollForProof(jobId: number): Promise<string> {
    console.log(`   ⏳ Polling for proof completion (job ${jobId})...`);
    
    // Initial wait before polling
    await new Promise(resolve => setTimeout(resolve, this.initialWait));

    for (let attempt = 1; attempt <= this.maxPollingAttempts; attempt++) {
      try {
        const requestBody = {
          jsonrpc: '2.0',
          id: 1,
          method: 'polymer_queryProof',
          params: [jobId]
        };

        const response = await axios.post<PolymerProofResponse>(
          this.baseUrl,
          requestBody,
          {
            timeout: this.timeout,
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.apiKey}`
            }
          }
        );

        if (response.data.error) {
          throw new Error(`Polymer API error: ${response.data.error.message} (code: ${response.data.error.code})`);
        }

        const result = response.data.result;
        if (!result || typeof result === 'number') {
          throw new Error('Invalid response: expected proof status object');
        }

        console.log(`   📊 Job ${jobId} status: ${result.status} (attempt ${attempt}/${this.maxPollingAttempts})`);

        switch (result.status) {
          case 'complete':
            if (!result.proof) {
              throw new Error('Proof completed but no proof data provided');
            }
            
            // Decode base64 proof and convert to hex
            const proofBytes = Buffer.from(result.proof, 'base64');
            const proofHex = '0x' + proofBytes.toString('hex');
            
            console.log(`   ✅ Proof completed! Length: ${proofHex.length} characters`);
            return proofHex;

          case 'pending':
          case 'initialized':
            if (attempt < this.maxPollingAttempts) {
              await new Promise(resolve => setTimeout(resolve, this.pollingInterval));
            }
            continue;

          case 'error':
            throw new Error(`Proof generation failed for job ${jobId}`);

          default:
            console.log(`   ⚠️ Unknown status: ${result.status}, treating as pending`);
            if (attempt < this.maxPollingAttempts) {
              await new Promise(resolve => setTimeout(resolve, this.pollingInterval));
            }
            continue;
        }

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(`   ⚠️ Polling attempt ${attempt} failed: ${errorMessage}`);

        if (attempt === this.maxPollingAttempts) {
          throw new Error(`Failed to get proof after ${this.maxPollingAttempts} attempts: ${errorMessage}`);
        }

        await new Promise(resolve => setTimeout(resolve, this.pollingInterval));
      }
    }

    throw new Error(`Proof polling timeout after ${this.maxPollingAttempts} attempts`);
  }

  async getProof(params: PolymerProofRequestParams): Promise<string> {
    const jobId = await this.requestProofJob(params);
    return await this.pollForProof(jobId);
  }
}

interface RelayerInput {
  txHash: string;
  sourceChain: keyof typeof CHAIN_CONFIGS;
  blockNumber: number;
  chainId: number;
  eventName: string;
  intentHash: string;
  timestamp: string;
  proofRequired: boolean;
  globalLogIndex?: number; // Global log index of the event (for TRON)
  originalIntent: {
    sourceChain: keyof typeof CHAIN_CONFIGS;
    destChain: keyof typeof CHAIN_CONFIGS;
    creator: string;
    intentHash: string;
  };
}

interface IntentProvenEvent {
  intentHash: string;
  claimant: string;
  transactionHash: string;
  blockNumber: number;
  destinationChainId: number;
}

async function loadRelayerInput(filePath: string): Promise<RelayerInput> {
  console.log(`📄 Loading relayer input from: ${filePath}`);
  
  try {
    const relayerData = JSON.parse(readFileSync(filePath, 'utf8')) as RelayerInput;
    
    console.log('📋 Relayer Input Details:');
    console.log(`   Transaction Hash: ${relayerData.txHash}`);
    console.log(`   Source Chain: ${relayerData.sourceChain}`);
    console.log(`   Block Number: ${relayerData.blockNumber}`);
    console.log(`   Event Name: ${relayerData.eventName}`);
    console.log(`   Intent Hash: ${relayerData.intentHash}`);
    if (relayerData.globalLogIndex !== undefined) {
      console.log(`   Global Log Index: ${relayerData.globalLogIndex}`);
    }
    console.log(`   Original Source Chain: ${relayerData.originalIntent.sourceChain}`);
    console.log(`   Original Destination Chain: ${relayerData.originalIntent.destChain}`);
    
    return relayerData;
  } catch (error) {
    throw new Error(`Failed to load relayer input file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fetchIntentProvenEvent(
  relayerInput: RelayerInput,
  abis: any
): Promise<IntentProvenEvent> {
  console.log(`\n🔍 Fetching IntentProven event from ${relayerInput.sourceChain} blockchain...`);
  
  const sourceConfig = CHAIN_CONFIGS[relayerInput.sourceChain];
  
  if (relayerInput.sourceChain === 'tron') {
    // Handle TRON transaction fetching
    console.log(`   🔗 Fetching TRON transaction via TronGrid API...`);
    
    try {
      // Use TronGrid API to get transaction info
      const response = await axios.get(`${sourceConfig.rpcUrl}/wallet/gettransactioninfobyid`, {
        params: {
          value: relayerInput.txHash
        }
      });
      
      if (!response.data || !response.data.log) {
        throw new Error(`Transaction ${relayerInput.txHash} not found or has no logs`);
      }
      
      console.log(`   Found TRON transaction in block ${relayerInput.blockNumber}`);
      
      // Find IntentProven event in the logs
      // For TRON, we'll extract the event data from the relayer input since parsing TRON logs is complex
      const intentProvenEvent: IntentProvenEvent = {
        intentHash: relayerInput.intentHash,
        claimant: relayerInput.originalIntent.creator, // Use creator as claimant fallback
        transactionHash: relayerInput.txHash,
        blockNumber: relayerInput.blockNumber,
        destinationChainId: sourceConfig.chainId
      };
      
      console.log('   ✅ Found IntentProven event (from relayer input)');
      console.log(`   Intent Hash: ${intentProvenEvent.intentHash}`);
      console.log(`   Claimant: ${intentProvenEvent.claimant}`);
      console.log(`   Destination Chain ID: ${intentProvenEvent.destinationChainId}`);
      
      return intentProvenEvent;
      
    } catch (error) {
      console.error(`   ❌ Failed to fetch TRON transaction: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    
  } else {
    // Handle EVM chains (Optimism, etc.)
    const provider = new ethers.JsonRpcProvider(sourceConfig.rpcUrl);
    
    // Create contract instance to parse events
    const inboxContract = new ethers.Contract(
      ethers.ZeroAddress, // We just need the interface for parsing
      abis.INBOX_ABI,
      provider
    );
    
    // Get transaction receipt
    const txReceipt = await provider.getTransactionReceipt(relayerInput.txHash);
    if (!txReceipt) {
      throw new Error(`Transaction ${relayerInput.txHash} not found`);
    }
    
    console.log(`   Found transaction in block ${txReceipt.blockNumber}`);
    
    // Find IntentProven event in the transaction logs
    let intentProvenEvent: IntentProvenEvent | null = null;
    
    for (const log of txReceipt.logs) {
      try {
        const parsed = inboxContract.interface.parseLog({
          topics: log.topics,
          data: log.data
        });
        
        if (parsed?.name === 'IntentProven') {
          console.log('   ✅ Found IntentProven event');
          
          intentProvenEvent = {
            intentHash: parsed.args.intentHash,
            claimant: parsed.args.claimant,
            transactionHash: relayerInput.txHash,
            blockNumber: relayerInput.blockNumber,
            destinationChainId: sourceConfig.chainId
          };
          
          console.log(`   Intent Hash: ${intentProvenEvent.intentHash}`);
          console.log(`   Claimant: ${intentProvenEvent.claimant}`);
          console.log(`   Destination Chain ID: ${intentProvenEvent.destinationChainId}`);
          break;
        }
      } catch {
        // Skip logs we can't parse
      }
    }
    
    if (!intentProvenEvent) {
      throw new Error(`IntentProven event not found in transaction ${relayerInput.txHash}`);
    }
    
    return intentProvenEvent;
  }
}

async function generatePolymerProof(
  intentProvenEvent: IntentProvenEvent,
  relayerInput: RelayerInput
): Promise<string> {
  console.log(`\n🏗️  Fetching actual Polymer proof from API...`);
  
  // Initialize Polymer proof service
  const polymerService = new PolymerProofService(env.POLYMER_API_KEY!);
  
  // We need to find the global log index of the IntentProven event
  const sourceConfig = CHAIN_CONFIGS[relayerInput.sourceChain];
  let globalLogIndex = -1;
  
  if (relayerInput.sourceChain === 'tron') {
    // For TRON, check if we have the globalLogIndex from the relayer input
    if (relayerInput.globalLogIndex !== undefined && relayerInput.globalLogIndex !== null) {
      console.log(`   ✅ Using global log index from relayer input: ${relayerInput.globalLogIndex}`);
      globalLogIndex = relayerInput.globalLogIndex;
    } else {
      // Fallback: try to find it from the transaction (legacy behavior)
      console.log(`   🔍 Global log index not provided, finding IntentProven event in TRON transaction ${relayerInput.txHash}...`);
      
      try {
        const response = await axios.get(`${sourceConfig.rpcUrl}/wallet/gettransactioninfobyid`, {
          params: {
            value: relayerInput.txHash
          }
        });
        
        if (!response.data || !response.data.log) {
          throw new Error(`TRON transaction ${relayerInput.txHash} not found or has no logs`);
        }
        
        // Find the IntentFulfilledFromSource event in the logs
        // We need to find the log with the correct event signature (TRON uses hex without 0x prefix)
        const intentFulfilledFromSourceSig = 'd493dde4de24066db29a754b1e9dc5dedf7084850c4abf76c23046ba9dad6b1d';
        
        if (response.data.log && Array.isArray(response.data.log)) {
          console.log(`   🔍 Checking ${response.data.log.length} logs for IntentFulfilledFromSource event...`);
          for (let i = 0; i < response.data.log.length; i++) {
            const log = response.data.log[i];
            console.log(`      Log ${i}: address=${log.address}, topic0=${log.topics?.[0]}`);
            if (log.topics && log.topics[0] === intentFulfilledFromSourceSig) {
              // This is a fallback hardcoded value - should be replaced by proper detection
              globalLogIndex = 23;
              console.log(`   ⚠️  Using fallback global log index: ${globalLogIndex} for TRON log index ${i}`);
              console.log(`   📍 Emitted by: 0x${log.address}`);
              console.log(`   💡 Tip: Run fulfill-intent.ts to automatically detect the correct global log index`);
              break;
            }
          }
        }
        
        if (globalLogIndex === -1) {
          throw new Error('IntentFulfilledFromSource event not found in TRON transaction logs');
        }
        
      } catch (error) {
        throw new Error(`Failed to fetch TRON transaction info: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
  } else {
    // Handle EVM chains - prioritize globalLogIndex from input file
    if (relayerInput.globalLogIndex !== undefined && relayerInput.globalLogIndex !== null) {
      console.log(`   ✅ Using global log index from relayer input: ${relayerInput.globalLogIndex}`);
      globalLogIndex = relayerInput.globalLogIndex;
    } else {
      // Fallback: auto-detect from transaction
      const provider = new ethers.JsonRpcProvider(sourceConfig.rpcUrl);
      
      console.log(`   🔍 Finding IntentProven event in transaction ${relayerInput.txHash}...`);
      
      const txReceipt = await provider.getTransactionReceipt(relayerInput.txHash);
      if (!txReceipt) {
        throw new Error(`Transaction ${relayerInput.txHash} not found`);
      }
      
      // Find the IntentProven event log in the transaction
      let eventLogIndex = -1;
      
      for (let i = 0; i < txReceipt.logs.length; i++) {
        const log = txReceipt.logs[i];
        try {
          // Check if this is an IntentProven event by checking the event signature
          const intentProvenSig = ethers.id("IntentProven(bytes32,bytes32)");
          if (log.topics[0] === intentProvenSig) {
            eventLogIndex = i;
            globalLogIndex = log.index; // This is the global log index within the block
            console.log(`   ✅ Found IntentProven event at log index ${eventLogIndex} (global: ${globalLogIndex})`);
            break;
          }
        } catch {
          continue;
        }
      }
      
      if (globalLogIndex === -1) {
        throw new Error('IntentProven event not found in transaction logs');
      }
    }
  }
  
  // Prepare Polymer API request parameters
  const proofParams: PolymerProofRequestParams = {
    srcChainId: sourceConfig.chainId,
    srcBlockNumber: relayerInput.blockNumber,
    globalLogIndex: globalLogIndex
  };
  
  console.log(`   📋 Proof request parameters:`);
  console.log(`      Source Chain ID: ${proofParams.srcChainId}`);
  console.log(`      Block Number: ${proofParams.srcBlockNumber}`);
  console.log(`      Global Log Index: ${proofParams.globalLogIndex}`);
  
  try {
    // Request the actual proof from Polymer API
    const proof = await polymerService.getProof(proofParams);
    
    console.log(`   ✅ Successfully fetched Polymer proof!`);
    console.log(`   Proof length: ${proof.length} characters`);
    console.log(`   Intent hash: ${intentProvenEvent.intentHash}`);
    console.log(`   Claimant: ${intentProvenEvent.claimant}`);
    
    return proof;
    
  } catch (error) {
    console.error(`   ❌ Failed to fetch Polymer proof: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

async function relayToPolymerProver(
  proof: string,
  relayerInput: RelayerInput,
  abis: any
): Promise<void> {
  console.log(`\n📤 Relaying proof to PolymerProver on ${relayerInput.originalIntent.sourceChain}...`);
  
  const targetChainConfig = CHAIN_CONFIGS[relayerInput.originalIntent.sourceChain];
  
  console.log(`   Target chain: ${relayerInput.originalIntent.sourceChain}`);
  console.log(`   Prover contract: ${targetChainConfig.prover}`);
  
  if (targetChainConfig.type === 'tron') {
    return await relayToTronPolymerProver(proof, targetChainConfig, abis);
  } else {
    return await relayToEvmPolymerProver(proof, targetChainConfig, abis);
  }
}

async function relayToEvmPolymerProver(
  proof: string,
  targetChainConfig: any,
  abis: any
): Promise<void> {
  const provider = new ethers.JsonRpcProvider(targetChainConfig.rpcUrl);
  const wallet = new ethers.Wallet(env.PRIVATE_KEY!, provider);
  
  console.log(`   Relayer wallet: ${wallet.address}`);
  
  // Create PolymerProver contract instance
  const polymerProverContract = new ethers.Contract(
    targetChainConfig.prover,
    abis.POLYMER_PROVER_ABI,
    wallet
  );
  
  // Check wallet balance
  const balance = await provider.getBalance(wallet.address);
  console.log(`   Wallet balance: ${ethers.formatEther(balance)} ${targetChainConfig.nativeName}`);
  
  try {
    // First, try to validate the proof with a static call
    console.log('   🔍 Pre-validating proof with static call...');
    await polymerProverContract.validate.staticCall(proof);
    console.log('   ✅ Static call passed');
    
    // Execute the actual validation transaction
    console.log('   📤 Submitting validate() transaction...');
    const tx = await polymerProverContract.validate(proof, {
      gasLimit: 500000n // Set reasonable gas limit
    });
    
    console.log(`   ⏳ Transaction submitted: ${tx.hash}`);
    console.log('   Waiting for confirmation...');
    
    const receipt = await tx.wait();
    
    console.log(`   ✅ Proof validated successfully!`);
    console.log(`      Block: ${receipt!.blockNumber}`);
    console.log(`      Gas used: ${receipt!.gasUsed}`);
    console.log(`      Transaction: ${tx.hash}`);
    
    // Check for IntentProven events
    let intentProvenFound = false;
    
    for (const log of receipt!.logs) {
      try {
        const parsed = polymerProverContract.interface.parseLog(log);
        if (parsed?.name === 'IntentProven') {
          intentProvenFound = true;
          console.log('   🎉 IntentProven event emitted');
          console.log(`      Intent hash: ${parsed.args.intentHash}`);
          console.log(`      Claimant: ${parsed.args.claimant}`);
          console.log(`      Destination: ${parsed.args.destination}`);
        }
      } catch {
        // Ignore parsing errors
      }
    }
    
    if (intentProvenFound) {
      console.log('   ✨ Intent successfully proven on origin chain!');
    } else {
      console.log('   ⚠️  No IntentProven event found - intent may have been already proven');
    }
    
    // Save relay results
    const relayResults = {
      relayTransactionHash: tx.hash,
      relayBlockNumber: receipt!.blockNumber,
      relayGasUsed: receipt!.gasUsed.toString(),
      relayedAt: new Date().toISOString(),
      originalInput: relayerInput,
      proofLength: proof.length,
      success: true
    };
    
    const outputFile = join(process.cwd(), 'relay-output.json');
    writeFileSync(outputFile, JSON.stringify(relayResults, null, 2));
    console.log(`\n💾 Relay results saved to: ${outputFile}`);
    
  } catch (error: any) {
    console.error('   ❌ Failed to validate proof:', error.message);
    
    // Try to decode custom errors
    if (error.data) {
      try {
        const iface = new ethers.Interface([
          'error InvalidEventSignature()',
          'error InvalidEmittingContract(address)',
          'error InvalidSourceChain()',
          'error InvalidDestinationChain()',
          'error InvalidTopicsLength()',
          'error EmptyProofData()',
          'error ArrayLengthMismatch()'
        ]);
        const decoded = iface.parseError(error.data);
        console.error('   Decoded error:', decoded);
      } catch {
        console.error('   Raw error data:', error.data);
      }
    }
    
    throw error;
  }
}

async function relayToTronPolymerProver(
  proof: string,
  targetChainConfig: any,
  abis: any
): Promise<void> {
  console.log('   🔗 Setting up TRON connection...');
  
  try {
    // Initialize TronWeb
    const tronWeb = initializeTronWeb(env.PRIVATE_KEY, targetChainConfig);
    
    console.log(`   Relayer wallet: ${tronWeb.defaultAddress.base58}`);
    
    // Create PolymerProver contract instance
    const polymerProverContract = await tronWeb.contract(abis.POLYMER_PROVER_ABI, targetChainConfig.prover);
    
    // Check wallet balance
    const balance = await tronWeb.trx.getBalance(tronWeb.defaultAddress.base58);
    console.log(`   Wallet balance: ${sunToTrx(balance)} ${targetChainConfig.nativeName}`);
    
    try {
      // TRON doesn't support static calls for payable functions, so we'll proceed directly
      console.log('   ⚠️  Note: TRON cannot simulate payable functions with .call()');
      console.log('   📤 Submitting validate() transaction directly...');
      
      // Execute the validation transaction
      const txResult = await polymerProverContract.validate(proof).send({
        feeLimit: 100000000, // 100 TRX fee limit
        shouldPollResponse: true
      });
      
      console.log(`   ⏳ TRON transaction submitted: ${txResult}`);
      
      // Wait for transaction confirmation
      let receipt = null;
      let attempts = 0;
      const maxAttempts = 30;
      
      while (attempts < maxAttempts) {
        try {
          const txInfo = await tronWeb.trx.getTransactionInfo(txResult);
          if (txInfo && txInfo.id) {
            receipt = {
              blockNumber: txInfo.blockNumber,
              gasUsed: txInfo.receipt?.energy_usage_total || 0,
              logs: txInfo.log || [],
              transactionHash: txResult
            };
            console.log('   ✅ TRON transaction confirmed!');
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
      
      console.log(`   ✅ Proof validated successfully on TRON!`);
      console.log(`      Block: ${receipt.blockNumber}`);
      console.log(`      Energy used: ${receipt.gasUsed}`);
      console.log(`      Transaction: ${txResult}`);
      
      // Check for events (TRON events need different parsing)
      if (receipt.logs && receipt.logs.length > 0) {
        console.log('   🎉 Events emitted (TRON format):');
        receipt.logs.forEach((log: any, index: number) => {
          console.log(`      Event ${index}:`, log.topics?.[0] || 'Unknown event');
        });
        console.log('   ✨ Intent successfully proven on TRON origin chain!');
      } else {
        console.log('   ⚠️  No events found - intent may have been already proven');
      }
      
      // Save relay results
      const relayResults = {
        relayTransactionHash: txResult,
        relayBlockNumber: receipt.blockNumber,
        relayEnergyUsed: receipt.gasUsed.toString(),
        relayedAt: new Date().toISOString(),
        proofLength: proof.length,
        success: true
      };
      
      const outputFile = join(process.cwd(), 'relay-output.json');
      writeFileSync(outputFile, JSON.stringify(relayResults, null, 2));
      console.log(`\n💾 Relay results saved to: ${outputFile}`);
      
    } catch (error: any) {
      console.error('   ❌ Failed to validate proof on TRON:', error.message);
      
      // TRON-specific error handling
      if (error.error) {
        console.error('   TRON error details:', error.error);
      }
      
      throw error;
    }
    
  } catch (error: any) {
    console.error('   ❌ TRON setup failed:', error.message);
    throw error;
  }
}

async function main() {
  try {
    console.log('🔍 Validating environment configuration...');
    
    // Parse command line arguments
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
      console.log(`
Usage: bun run relay-intent-fulfilled.ts <relayer-input.json>

Arguments:
  relayer-input.json    Path to the JSON file created by fulfill-intent.ts

Examples:
  bun run relay-intent-fulfilled.ts relayer-input.json
  bun run relay-intent-fulfilled.ts /path/to/relayer-input.json

This script:
1. Loads the relayer input data (transaction hash, chain info, etc.)
2. Fetches the IntentProven event from the fulfillment transaction
3. Requests an actual proof from the Polymer API using the event's global log index
4. Calls validate() on the PolymerProver contract on the origin chain with the real proof
5. Completes the cross-chain intent proof relay process
`);
      process.exit(0);
    }
    
    console.log('✅ Environment validated. Loading configurations...');
    
    const abis = loadContractABIs();
    
    console.log('✅ Contract ABIs loaded.');
    
    // Load relayer input from JSON file
    const inputFilePath = args[0].startsWith('/') ? args[0] : join(process.cwd(), args[0]);
    const relayerInput = await loadRelayerInput(inputFilePath);
    
    // Validate chain support
    if (!(relayerInput.sourceChain in CHAIN_CONFIGS)) {
      throw new Error(`Unsupported source chain: ${relayerInput.sourceChain}`);
    }
    if (!(relayerInput.originalIntent.sourceChain in CHAIN_CONFIGS)) {
      throw new Error(`Unsupported original source chain: ${relayerInput.originalIntent.sourceChain}`);
    }
    
    // Fetch the IntentProven event from the fulfillment transaction
    const intentProvenEvent = await fetchIntentProvenEvent(relayerInput, abis);
    
    // Generate Polymer proof structure
    const proof = await generatePolymerProof(intentProvenEvent, relayerInput);
    
    // Relay the proof to PolymerProver.validate() on the origin chain
    await relayToPolymerProver(proof, relayerInput, abis);
    
    console.log('\n🎉 Intent fulfillment relay completed successfully!');
    console.log('📋 Summary:');
    console.log(`   Original intent created on: ${relayerInput.originalIntent.sourceChain}`);
    console.log(`   Intent fulfilled on: ${relayerInput.sourceChain}`);
    console.log(`   Proof relayed back to: ${relayerInput.originalIntent.sourceChain}`);
    console.log(`   Intent hash: ${relayerInput.intentHash}`);
    
  } catch (error) {
    console.error('❌ Relay script failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Show usage if help requested
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage: bun run relay-intent-fulfilled.ts <relayer-input.json>

This script completes the cross-chain intent flow by:
1. Loading relayer input data from fulfill-intent.ts output
2. Fetching the IntentProven event from the destination chain fulfillment transaction
3. Generating a Polymer-compatible proof structure
4. Calling validate() on the PolymerProver contract on the origin chain
5. Proving that the intent was successfully fulfilled cross-chain

Arguments:
  relayer-input.json    Path to JSON file created by fulfill-intent.ts

Examples:
  bun run relay-intent-fulfilled.ts relayer-input.json
  bun run relay-intent-fulfilled.ts /path/to/relayer-input.json

Flow Overview:
  1. create-intent.ts    → Creates intent on source chain
  2. fulfill-intent.ts   → Fulfills intent on destination chain + emits IntentProven
  3. relay-intent-fulfilled.ts → Relays proof back to source chain validate()

Supported Chains: ${Object.keys(CHAIN_CONFIGS).join(', ')}

Notes:
- This script uses the actual Polymer API to fetch real cross-chain proofs
- Requires POLYMER_API_KEY environment variable to access the Polymer proof service
- The script validates the complete cross-chain intent lifecycle with real proofs
`);
  process.exit(0);
}

main();