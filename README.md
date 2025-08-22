# Solana-Unicity Bridge

A trustless bridge system enabling SOL to be locked on Solana and minted as tokens on the Unicity network.

## Architecture Overview

The bridge implements a lock/mint model where SOL is locked in a Solana smart contract and corresponding tokens are minted on Unicity with cryptographic proofs of the lock transaction. The system provides complete cryptographic validation from lock details through transaction data to Solana RPC verification of committed transaction signature.

### Core Components

1. **Solana Bridge Contract** - Deployed smart contract that locks SOL and emits lock events
2. **Bridge Monitor** - Service that monitors Solana for lock events and triggers token minting
3. **Proof Validator** - Validates Unicity genesis records of wrapped SOL tokens against Solana RPC which confirms lock tx signatures
4. **Unicity Integration** - Mints tokens on Unicity with embedded proof data

## Prerequisites

- Node.js 18+
- Solana CLI tools
- Some Testnet SOL for spending
- Rust environment to compile the Solana locking contract (optional)
- Solana toolchain to set up the Solana locking contract (optional)

## Installation

```bash
git clone <repository>
cd unicity-bridge
npm install
```

## Solana Contract Setup

The bridge contract is already deployed on Solana testnet at program ID `9q5thPnZG7FKKNr61wceXdfuy2QRLYky8RTJonh2YzyB`. You can use this existing deployment or deploy your own.

### Optional: Deploy Your Own Contract

```bash
# Build the contract
npx @coral-xyz/anchor build

# Deploy to testnet
npx @coral-xyz/anchor deploy --provider.cluster testnet

# Update the program ID in source files after deployment
```

## Unicity Wallet Setup

Create a Unicity wallet before running demonstrations:

```bash
npm run create-wallet
```

This creates a wallet file at `~/.config/unicity/bridge-minter.json` containing the private key and public key for Unicity operations.

## Demo Workflows

### Flow 1: End-to-End Demo in one run

(Did you run Unicity wallet setup? Enough SOL funds? (check with `solana balance`))

Runs the full bridge workflow automatically:

```bash
npm run complete-demo
```

This script:
1. Checks for recent Solana lock transactions
2. If none found, creates a new SOL lock transaction
3. Generates cryptographic proofs
4. Validates the transaction against Solana RPC
5. Mints corresponding tokens on Unicity
6. Saves all artifacts to `output/` directory

Note that the demo script tries hard to try to re-mint based on same lock event multiple times to demonstrate how Unicity poof guarantees uniqueness of spending transactions.

### Flow 2: More Involving Demo with Two Parallel Executions

This demonstrates the bridge tx monitoring in real-time:

**Terminal 1 - Start Bridge Monitor:**
```bash
npm run bridge-monitor
```

The monitor will:
- Connect to Solana testnet
- Start monitoring for lock events
- Display status updates
- Wait for lock transactions to process

At the initialization, it processes possible pending SOL lockups to ensure that some were not missed.

**Terminal 2 - Trigger Lock Transaction:**
```bash
npm run demo-lock <amount> <recipient_address>
```

Example:
```bash
npm run demo-lock 0.1 '[SHA256]15ed2f7f97c6e98c15d8dc4ba8bef3ebefc5ebf049dab7cdd075d334a6bba2f9'
```

This will:
- Lock 0.1 SOL in the bridge contract
- Emit a TokenLocked event with minting authorization to Unicity wallet 15ed2f7f97c6e98c15d8dc4ba8bef3ebefc5ebf049dab7cdd075d334a6bba2f9
- Observe what happens at Terminal 1! Processing starts immediately, even before the finality of Solana block

**Monitor Response:**
When the lock transaction is detected, Terminal 1 will automatically:
1. Capture the lock event details from the blockchain
2. Generate cryptographic proofs
3. Validate transaction signature against Solana RPC
4. Create Unicity genesis record with locking event details
5. Mint bridged tokens on Unicity
6. Save all artifacts to `demo-output/` directory

**Stop Monitor:**
Press `Ctrl+C` in Terminal 1 to stop the bridge monitor gracefully.

### Token Validation

Validate any generated token:

```bash
npm run validate-token demo-output/unicity-token-<id>.json
```

This performs full validation:
- Verifies token structure and metadata
- Validates embedded cryptographic proofs
- Confirms transaction signature against Solana RPC
- Checks proof integrity and authenticity

## Technical Implementation

### Cryptographic Validation Chain

The bridge implements a complete cryptographic validation chain:

```
Lock Details ← Transaction Data ← Transaction Signature ← Solana RPC
```

... where the locking contract ID is fixed (one component for asset id derivation).

1. **Lock Details**: Amount, recipient, timestamp extracted from transaction
2. **Transaction Data**: Complete Solana transaction stored in Unicity genesis
3. **Transaction Signature**: Cryptographically validates the transaction
4. **Solana RPC**: Authoritative source verifying signature authenticity (user is expected to find / run a trusted provider)
5. **Locking Contract ID**: Part of the bridged token identity, must be validated!


### Data Storage

**Genesis Records**: Complete Solana transaction data is embedded in Unicity genesis structures, enabling direct cryptographic validation without external dependencies.

**Proof Validation**: All validation can be performed independently by third parties using only the stored transaction data and Solana RPC access.

Note that Solana does not have a compact inclusion proof of transactions which would allow validating individual transactions based on hash chain and authentic block header. Therefore, transaction signature has to be directly authenticated based on RPC.

## Output Files

Generated artifacts are saved to:
- `output/` - Output files of 'complete demo'
- `demo-output/` - Output files of bridge monitor

### File Types

- `unicity-token-<id>.json` - Generated Unicity token with embedded proofs
- `genesis-record-<id>.json` - Genesis record containing full transaction data (for human reading, as the same data exists in opaque form inside Unicity tokens)
- `token-owner-<id>.json` - Token ownership metadata (for human reading)
- `transferred-token-<id>.json` - Token after any ownership transfers

## Security Model

### Trust Assumptions

- **Minimal Trust**: Only requires trusting Solana network finality
- **No Bridge Operators**: No intermediate trusted parties, data transport agents / oracles, on-chain light clients required
- **Cryptographic Verification**: All operations backed by cryptographic proofs

### Validation Features

- **Transaction Signature Validation**: Direct verification against Solana RPC
- **Replay Protection**: Each lock event can only be processed once
- **Minter ID Provided**: Only designated party can mint Unicity tokens
- **Third-party Verifiable**: Anyone can independently verify token legitimacy

## Configuration

### Bridge Settings

Update bridge program ID in source files if using custom deployment:
- `src/demo-bridge-monitor.ts:22`
- `src/demo-lock-transaction.ts:20`
- `src/complete-demo.ts` (search for program ID)

### Network Configuration

Default: Solana Testnet (`https://api.testnet.solana.com`)

For different networks, update RPC URLs in configuration files.

## Development

### Project Structure

```
src/
├── bridge-client.ts          # Solana blockchain interaction
├── complete-demo.ts          # Automated demo workflow
├── create-unicity-wallet.ts  # Wallet generation
├── demo-bridge-monitor.ts    # Real-time bridge monitoring
├── demo-lock-transaction.ts  # Lock transaction creation
├── proof-validator.ts        # Cryptographic proof validation
├── unicity-integration.ts    # Unicity network integration
└── validate-token.ts         # Token validation utility

programs/unicity-bridge/src/
└── lib.rs                    # Solana bridge contract
```


### Debug Output

This is a fully functional proof of concept. It is very talkative to demonstrate what is going on.
