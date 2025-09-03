# Cross-Chain Intent Scripts

This directory contains scripts for managing cross-chain intents between TRON and Optimism using the Eco Routes protocol.

## Prerequisites

1. **Environment Setup**: Copy `.env.example` to `.env` and fill in the required values:
   ```bash
   cp .env.example .env
   ```

2. **Contract Compilation**: Ensure contracts are compiled and ABIs are available in the `out/` directory:
   ```bash
   forge build
   ```

3. **Dependencies**: Install Node.js dependencies (if not already installed):
   ```bash
   npm install
   # or
   bun install
   ```

## Scripts

### 1. Create Intent (`create-intent.ts`)

Creates a cross-chain intent on the source chain.

**Usage:**
```bash
# Create TRON → Optimism intent
bun run scripts/create-intent.ts

# Create Optimism → TRON intent  
bun run scripts/create-intent.ts
```

**What it does:**
- Prompts for intent details (route, reward, etc.)
- Supports both TRON and Optimism as source chains
- Creates the intent and saves output to `intent-output.json`

### 2. Fulfill Intent (`fulfill-intent.ts`)

Fulfills an existing intent on the destination chain.

**Usage:**
```bash
bun run scripts/fulfill-intent.ts intent-output.json
```

**What it does:**
- Loads intent data from the output file
- Fulfills the intent on the destination chain
- Saves fulfillment details to `fulfillment-output.json`

### 3. Relay Intent Fulfilled (`relay-intent-fulfilled.ts`)

Relays proof of fulfillment back to the source chain.

**Usage:**
```bash
bun run scripts/relay-intent-fulfilled.ts relayer-input.json
```

**What it does:**
- Fetches proof from Polymer API
- Submits proof to the source chain's Prover contract
- Enables reward withdrawal

### 4. Withdraw Rewards (`withdraw-rewards.ts`)

Withdraws earned rewards from a proven intent.

**Usage:**
```bash
# Auto-detect from fulfillment output
bun run scripts/withdraw-rewards.ts withdraw-input.json

# Or specify input file
bun run scripts/withdraw-rewards.ts custom-withdraw.json
```

**What it does:**
- Validates the intent is proven
- Calls withdraw on the Portal contract
- Transfers rewards to the claimant

## Complete Flow Example

Here's a complete cross-chain intent flow from TRON to Optimism:

```bash
# 1. Create intent on TRON
bun run scripts/create-intent.ts
# Follow prompts to create TRON → Optimism intent

# 2. Fulfill intent on Optimism
bun run scripts/fulfill-intent.ts intent-output.json

# 3. Relay proof back to TRON
bun run scripts/relay-intent-fulfilled.ts relayer-input.json

# 4. Withdraw rewards on TRON
bun run scripts/withdraw-rewards.ts withdraw-input.json
```

## Configuration

### Environment Variables

- `PRIVATE_KEY`: Private key for transactions (0x prefixed)
- `OPTIMISM_RPC_URL`: Optimism RPC endpoint
- `TRON_RPC_URL`: TRON RPC endpoint
- `PORTAL_ADDR_OPTIMISM`: Portal contract address on Optimism
- `PORTAL_ADDR_TRON`: Portal contract address on TRON (base58)
- `PROVER_ADDR_OPTIMISM`: Prover contract address on Optimism  
- `PROVER_ADDR_TRON`: Prover contract address on TRON (base58)
- `POLYMER_API_KEY`: API key for Polymer proof service

### Contract Addresses

The contracts are deployed on both TRON and Optimism mainnets. Addresses are configured in the `.env` file.

## Supported Chains

- **TRON Mainnet** (Chain ID: 728126428)
- **Optimism Mainnet** (Chain ID: 10)

## Notes

- Scripts automatically handle address format conversion between TRON (base58) and EVM (0x) formats
- TRON amounts use 6 decimals (SUN), Optimism uses 18 decimals (ETH)
- All scripts include proper error handling and confirmation waiting
- Output files contain all necessary data for subsequent steps in the flow
