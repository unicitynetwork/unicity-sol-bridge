#!/usr/bin/env ts-node

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { SolanaBridgeClient } from "./bridge-client";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

/**
 * SOL Lock Transaction Script
 *
 * Triggers SOL lock transactions on Solana testnet to demonstrate the bridge.
 * Usage: npm run demo-lock <amount> <recipient>
 */

// Configuration, change the bridgeProgramId after re-deploying the Solana contract
const BRIDGE_CONFIG = {
  rpcUrl: "https://api.testnet.solana.com",
  bridgeProgramId: "9q5thPnZG7FKKNr61wceXdfuy2QRLYky8RTJonh2YzyB",
  walletPath: path.join(os.homedir(), ".config", "solana", "id.json")
};

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

class LockTransactionDemo {
  private bridgeClient: SolanaBridgeClient;
  private wallet: anchor.Wallet;

  constructor() {
    this.initializeWallet();
    this.bridgeClient = new SolanaBridgeClient(BRIDGE_CONFIG.rpcUrl, this.wallet);
  }

  private initializeWallet(): void {
    try {
      const secretKey = JSON.parse(fs.readFileSync(BRIDGE_CONFIG.walletPath, "utf8"));
      const keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
      this.wallet = new anchor.Wallet(keypair);

      console.log(`Wallet loaded successfully`);
      console.log(`Public Key: ${keypair.publicKey.toString()}`);

    } catch (error) {
      console.error(`ERROR: Failed to load wallet from ${BRIDGE_CONFIG.walletPath}`);
      console.error(`NOTE: Make sure you have a funded Solana testnet wallet configured`);
      console.error(`NOTE: Run: solana-keygen new --outfile ~/.config/solana/id.json`);
      console.error(`NOTE: Then: solana airdrop 2 --url testnet`);
      process.exit(1);
    }
  }

  private formatTimestamp(): string {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
  }

  public async executeLockTransaction(amountSol: number, originalRecipient: string): Promise<void> {
    const timestamp = this.formatTimestamp();

    console.log(`SOL LOCK TRANSACTION`);
    console.log(`${'='.repeat(60)}`);

    try {
      // Pre-transaction checks
      console.log(`\nTransaction Details:`);
      console.log(`Timestamp: ${timestamp}`);
      console.log(`Amount: ${amountSol} SOL`);
      // Extract hex part from Unicity key for Solana contract (64 char limit)
    const isUnicityKey = originalRecipient.startsWith('[SHA256]');
    const contractRecipient = isUnicityKey ? originalRecipient.substring(8) : originalRecipient;

    console.log(`Unicity Recipient: ${originalRecipient}`);
    if (isUnicityKey) {
      console.log(`Contract Recipient: ${contractRecipient}`);
    }
      console.log(`Solana User: ${this.wallet.publicKey.toString()}`);

      // Check wallet balance
      console.log(`\nSTEP 1: Wallet Balance Check`);
      const connection = new Connection(BRIDGE_CONFIG.rpcUrl, 'confirmed');
      const balance = await connection.getBalance(this.wallet.publicKey);
      const balanceSol = balance / LAMPORTS_PER_SOL;

      console.log(`Current Balance: ${balanceSol.toFixed(4)} SOL`);

      if (balanceSol < amountSol + 0.01) { // Reserve for transaction fees
        throw new Error(`Insufficient balance. Need ${amountSol + 0.01} SOL, have ${balanceSol.toFixed(4)} SOL`);
      }
      console.log(`Sufficient balance available`);

      // Get bridge state
      console.log(`\nSTEP 2: Bridge State Verification`);
      const bridgeState = await this.bridgeClient.getBridgeState();
      const escrowBalance = await this.bridgeClient.getEscrowBalance();

      console.log(`Bridge Status:`);
      console.log(`   Program ID: ${BRIDGE_CONFIG.bridgeProgramId}`);
      console.log(`   Admin: ${bridgeState.admin.toString()}`);
      console.log(`   Current Nonce: ${bridgeState.nonce.toString()}`);
      console.log(`   Total Previously Locked: ${(bridgeState.totalLocked.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      console.log(`   Escrow Balance: ${escrowBalance.toFixed(4)} SOL`);
      console.log(`Bridge contract accessible and operational`);

      // Execute lock transaction
      console.log(`\nSTEP 3: SOL Lock Transaction Execution`);
      console.log(`Broadcasting transaction to Solana testnet...`);

      const amountLamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
      const lockResult = await this.bridgeClient.lockSol(amountLamports, contractRecipient);

      console.log(`Transaction broadcast successfully!`);
      console.log(`Transaction Signature: ${lockResult}`);
      console.log(`Explorer: https://explorer.solana.com/tx/${lockResult}?cluster=testnet`);

      // Wait for confirmation
      console.log(`\nSTEP 4: Transaction Confirmation`);
      console.log(`Waiting for network confirmation...`);

      // Poll for confirmation (simplified - in production would use WebSocket)
      let confirmed = false;
      let attempts = 0;
      const maxAttempts = 30;

      while (!confirmed && attempts < maxAttempts) {
        try {
          const status = await connection.getSignatureStatus(lockResult);
          if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') {
            confirmed = true;
            console.log(`Transaction confirmed on Solana network!`);
            console.log(`Confirmation Status: ${status.value.confirmationStatus}`);
            break;
          }
        } catch (error) {
          // Ignore transient errors
        }

        attempts++;
        await new Promise(resolve => setTimeout(resolve, 2000));

        if (attempts % 5 === 0) {
          console.log(`Still waiting for confirmation (${attempts}/${maxAttempts})...`);
        }
      }

      if (!confirmed) {
        console.log(`WARNING: Transaction may still be pending confirmation`);
        console.log(`NOTE: Check the explorer link above for current status`);
      }

      // Post-transaction verification
      console.log(`\nSTEP 5: Post-Transaction Verification`);

      try {
        const newBridgeState = await this.bridgeClient.getBridgeState();
        const newEscrowBalance = await this.bridgeClient.getEscrowBalance();

        console.log(`Updated Bridge State:`);
        console.log(`   New Nonce: ${newBridgeState.nonce.toString()} (${newBridgeState.nonce.toNumber() - bridgeState.nonce.toNumber() > 0 ? '+' + (newBridgeState.nonce.toNumber() - bridgeState.nonce.toNumber()) : 'unchanged'})`);
        console.log(`   Total Locked: ${(newBridgeState.totalLocked.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL (+${((newBridgeState.totalLocked.toNumber() - bridgeState.totalLocked.toNumber()) / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
        console.log(`   Escrow Balance: ${newEscrowBalance.toFixed(4)} SOL (+${(newEscrowBalance - escrowBalance).toFixed(4)} SOL)`);

        if (newBridgeState.nonce.toNumber() > bridgeState.nonce.toNumber()) {
          console.log(`Bridge state updated - lock event recorded`);
        }

      } catch (error) {
        console.log(`WARNING: Could not verify bridge state immediately (${error.message})`);
        console.log(`NOTE: This is normal for recently confirmed transactions`);
      }

      // Generate lock ID for reference
      const lockId = Buffer.from(`${lockResult}-${originalRecipient}-${amountLamports}`, 'utf8');
      const lockIdHex = crypto.createHash('sha256').update(lockId).digest('hex').substring(0, 8);

      // Success summary
      console.log(`\nOK`);
      console.log(`${'='.repeat(65)}`);
      console.log(`${amountSol} SOL locked on Solana testnet`);
      console.log(`Lock ID: ${lockIdHex}...`);
      console.log(`Transaction: ${lockResult}`);
      console.log(`Explorer: https://explorer.solana.com/tx/${lockResult}?cluster=testnet`);


      console.log(`\nTransaction Summary:`);
      console.log(`   Locked Amount: ${amountSol} SOL (${amountLamports} lamports)`);
      console.log(`   Unicity Recipient: ${originalRecipient}`);
      console.log(`   Solana User: ${this.wallet.publicKey.toString()}`);
      console.log(`   Timestamp: ${timestamp}`);
      console.log(`   Reference Lock ID: ${lockIdHex}`);

    } catch (error) {
      console.error(`\nERROR: LOCK TRANSACTION FAILED`);
      console.error(`${'='.repeat(50)}`);
      console.error(`Error:`, error.message);

      if (error.message.includes('insufficient')) {
        console.error(`\nNOTE: SOLUTION:`);
        console.error(`   1. Check wallet balance: solana balance --url testnet`);
        console.error(`   2. Request testnet SOL: solana airdrop 2 --url testnet`);
        console.error(`   3. Verify wallet: solana address --url testnet`);
      } else if (error.message.includes('network') || error.message.includes('connection')) {
        console.error(`\nNOTE: SOLUTION:`);
        console.error(`   1. Check internet connection`);
        console.error(`   2. Verify Solana testnet is accessible`);
        console.error(`   3. Try again in a few moments`);
      }

      process.exit(1);
    }
  }

  public static async main(): Promise<void> {
    const args = process.argv.slice(2);

    console.log(`SOLANA-UNICITY BRIDGE - LOCK TRANSACTION POC`);
    console.log(`${'='.repeat(70)}\n`);

    // Validate arguments
    if (args.length !== 2) {
      console.error(`ERROR: Invalid arguments\n`);
      console.log(`Usage: npm run demo-lock <amount> <minter>\n`);
      console.log(`Examples:`);
      console.log(`  npm run demo-lock 0.1 unicity-user-identifier`);
      console.log(`Parameters:`);
      console.log(`  <amount>    - Amount of SOL to lock (e.g., 0.1, 0.05, 1.0)`);
      console.log(`  <recipient> - Unicity recipient identifier (public key)\n`);
      process.exit(1);
    }

    const [amountStr, recipient] = args;

    // Validate amount
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0 || amount > 10) {
      console.error(`ERROR: Invalid amount: ${amountStr}`);
      console.error(`Amount must be a number between 0 and 10 SOL`);
      process.exit(1);
    }

    // Validate recipient format - accept Unicity public keys
    const isUnicityKey = recipient.startsWith('[SHA256]') && recipient.length === 72;
    const isSimpleRecipient = /^[a-zA-Z0-9_]+$/.test(recipient) && recipient.length >= 3 && recipient.length <= 50;

    if (!isUnicityKey && !isSimpleRecipient) {
      console.error(`ERROR: Invalid recipient: ${recipient}`);
      console.error(`Recipient must be either:`);
      console.error(`  1. Simple identifier: 3-50 characters, alphanumeric and underscores only`);
      console.error(`  2. Unicity public key: [SHA256]<64 hex chars>`);
      process.exit(1);
    }

    if (isUnicityKey) {
      console.log(`Using Unicity public key as recipient: ${recipient.substring(0, 20)}...`);
    }

    console.log(`Starting lock transaction...\n`);

    const demo = new LockTransactionDemo();
    await demo.executeLockTransaction(amount, recipient);
  }
}

// Main execution
if (require.main === module) {
  LockTransactionDemo.main().catch(error => {
    console.error(`ERROR: `, error);
    process.exit(1);
  });
}

export { LockTransactionDemo };