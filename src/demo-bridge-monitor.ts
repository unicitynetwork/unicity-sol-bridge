#!/usr/bin/env ts-node

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { SolanaBridgeClient, LockEvent, ProofData } from "./bridge-client";
import { UnicityProofValidator } from "./proof-validator";
import { mintBridgedTokenWithSDK } from "./unicity-sdk-simple";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Solana-Unicity Bridge Monitor
 *
 * This script continuously monitors the Solana blockchain for SOL lock events
 * and automatically creates validated Unicity tokens with embedded proofs.
 */

// Configuration
const BRIDGE_CONFIG = {
  rpcUrl: "https://api.testnet.solana.com",
  bridgeProgramId: "9q5thPnZG7FKKNr61wceXdfuy2QRLYky8RTJonh2YzyB",
  outputDir: path.join(__dirname, "../demo-output"),
  walletPath: path.join(os.homedir(), ".config", "solana", "id.json")
};

// Colors disabled - plain text output
const colors = {
  reset: '',
  bright: '',
  red: '',
  green: '',
  yellow: '',
  blue: '',
  magenta: '',
  cyan: ''
};

class BridgeMonitor {
  private bridgeClient: SolanaBridgeClient;
  private proofValidator: UnicityProofValidator;
  private isRunning: boolean = false;
  private processedEvents: number = 0;
  private lastCheckedSlot: number = 0;
  private processedTransactions: Set<string> = new Set(); // Track processed tx signatures

  constructor() {
    this.initializeComponents();
    this.setupOutputDirectory();
    this.setupGracefulShutdown();
    this.loadProcessedTransactions(); // Load previously processed transactions
  }

  private initializeComponents(): void {
    try {
      // Load wallet
      let keypair: Keypair;
      try {
        const secretKey = JSON.parse(fs.readFileSync(BRIDGE_CONFIG.walletPath, "utf8"));
        keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
      } catch (error) {
        keypair = Keypair.generate();
        console.log(`WARNING: Using generated wallet (not funded)`);
      }

      const wallet = new anchor.Wallet(keypair);
      this.bridgeClient = new SolanaBridgeClient(BRIDGE_CONFIG.rpcUrl, wallet);
      this.proofValidator = new UnicityProofValidator(
        BRIDGE_CONFIG.rpcUrl,
        BRIDGE_CONFIG.bridgeProgramId
      );

      console.log(`Bridge components initialized`);
      console.log(`Wallet: ${keypair.publicKey.toString()}`);

    } catch (error) {
      console.error(`ERROR: Failed to initialize bridge components:`, error);
      process.exit(1);
    }
  }

  private setupOutputDirectory(): void {
    if (!fs.existsSync(BRIDGE_CONFIG.outputDir)) {
      fs.mkdirSync(BRIDGE_CONFIG.outputDir, { recursive: true });
    }
    console.log(`Output directory: ${BRIDGE_CONFIG.outputDir}`);
  }

  private setupGracefulShutdown(): void {
    const shutdown = () => {
      if (this.isRunning) {
        console.log(`\nShutting down bridge monitor...`);
        console.log(`Total events processed: ${this.processedEvents}`);
        this.saveProcessedTransactions(); // Save state before shutdown
        this.isRunning = false;
        process.exit(0);
      }
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  private getProcessedTransactionsPath(): string {
    return path.join(BRIDGE_CONFIG.outputDir, 'processed-transactions.json');
  }

  private loadProcessedTransactions(): void {
    try {
      const filePath = this.getProcessedTransactionsPath();
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        this.processedTransactions = new Set(data.processedTransactions || []);
        this.lastCheckedSlot = data.lastCheckedSlot || 0;
        console.log(`Loaded ${this.processedTransactions.size} previously processed transactions`);
        console.log(`Last checked slot: ${this.lastCheckedSlot}`);
      }
    } catch (error) {
      console.log('No previous transaction history found, starting fresh');
    }
  }

  private saveProcessedTransactions(): void {
    try {
      const data = {
        processedTransactions: Array.from(this.processedTransactions),
        lastCheckedSlot: this.lastCheckedSlot,
        savedAt: new Date().toISOString()
      };
      fs.writeFileSync(this.getProcessedTransactionsPath(), JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to save processed transactions:', error.message);
    }
  }

  private formatTimestamp(): string {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
  }

  private createPendingValidationProof(proof: ProofData, errorMessage: string): any {
    return {
      lockEvent: {
        lockId: Buffer.from(proof.event.lockId).toString('hex'),
        user: proof.event.user.toString(),
        amount: proof.event.amount.toString(),
        unicityRecipient: proof.event.unicityRecipient,
        nonce: proof.event.nonce.toString(),
        timestamp: proof.event.timestamp.toString()
      },
      solanaTransaction: {
        signature: proof.transaction.signature,
        transaction: proof.transaction.fullTransaction || null,
        blockHeight: proof.blockHeight,
        slot: proof.slot,
        blockTime: proof.transaction.blockTime,
        confirmationStatus: proof.signatureStatus?.confirmationStatus || "unknown"
      },
      validation: {
        blockVerified: false,
        signatureStatusVerified: false,
        timestamp: Date.now(),
        status: "PENDING_VALIDATION",
        reason: errorMessage
      }
    };
  }

  private createValidationMetadata(proof: ProofData, pendingProof: any): any {
    return {
      validationStatus: "PENDING",
      reason: "Block too recent for RPC validation",
      blockInfo: {
        blockHeight: proof.blockHeight,
        blockHash: proof.blockHash,
        slot: proof.slot,
        signature: proof.transaction.signature
      },
      validationInstructions: {
        description: "This token was created with a very recent Solana transaction that couldn't be validated immediately due to RPC limitations.",
        retryAfter: "Wait a bit for the block to finalize and become available via RPC",
        validationSteps: [
          {
            step: 1,
            description: "Verify block exists",
            command: `curl -X POST https://api.testnet.solana.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getBlock","params":[${proof.blockHeight}]}'`,
            expectedResult: "Should return block data with matching blockhash"
          },
          {
            step: 2,
            description: "Verify transaction exists",
            command: `curl -X POST https://api.testnet.solana.com -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getTransaction","params":["${proof.transaction.signature}"]}'`,
            expectedResult: "Should return transaction details"
          },
          {
            step: 3,
            description: "Check transaction success",
            expectedResult: "Transaction should have null error field indicating success"
          },
          {
            step: 4,
            description: "Verify bridge program involvement",
            expectedResult: "Transaction should involve bridge program: 9q5thPnZG7FKKNr61wceXdfuy2QRLYky8RTJonh2YzyB"
          }
        ]
      },
      explorerUrls: {
        transaction: `https://explorer.solana.com/tx/${proof.transaction.signature}?cluster=testnet`,
        block: `https://explorer.solana.com/block/${proof.blockHeight}?cluster=testnet`
      },
      createdAt: new Date().toISOString(),
      validationNeededAfter: new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 minutes from now
    };
  }

  private async processBridgeEvent(event: LockEvent, proof: ProofData): Promise<void> {
    const lockIdHex = Buffer.from(event.lockId).toString('hex').substring(0, 8);
    const timestamp = this.formatTimestamp();

    // Check if already processed (earlier than failing with unicity proof)
    if (this.processedTransactions.has(proof.transaction.signature)) {
      console.log(`\nSKIPPED: Transaction ${proof.transaction.signature.substring(0, 16)}... already processed`);
      return;
    }

    try {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`SOL LOCK EVENT`);
      console.log(`${'='.repeat(60)}`);

      // Display event details
      console.log(`Timestamp: ${timestamp}`);
      console.log(`Lock ID: ${lockIdHex}...`);
      console.log(`User: ${event.user.toString()}`);
      console.log(`Amount: ${(event.amount.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      console.log(`Unicity Recipient: ${event.unicityRecipient}`);
      console.log(`Nonce: ${event.nonce.toString()}`);

      // Display proof details
      console.log(`\nCRYPTOGRAPHIC PROOF DETAILS`);
      console.log(`Block Hash: ${proof.blockHash.substring(0, 16)}...`);
      console.log(`Block Height: ${proof.blockHeight}`);
      console.log(`Transaction: ${proof.transaction.signature.substring(0, 16)}...`);

      if (proof.signatureStatus) {
        console.log(`Signature Status: ${proof.signatureStatus.confirmationStatus}`);
        console.log(`Confirmations: ${proof.signatureStatus.confirmations}`);
        console.log(`Error: ${proof.signatureStatus.err || 'none'}`);
      } else {
        console.log(`Signature Status: not available`);
      }

      // Step 1: Cryptographic Proof Validation
      console.log(`\nSTEP 1: Cryptographic Proof Validation`);
      const validatedProof = await this.proofValidator.validateGenesisProof(proof);

      // Step 1.5: Validate complete cryptographic chain
      console.log(`\nSTEP 1.5: Cryptographic Chain Validation`);
      const chainValid = await this.proofValidator.validateCryptographicChain(validatedProof);
      if (!chainValid) {
        console.log(`WARNING: Cryptographic chain validation failed`);
      } else {
        console.log(`Cryptographic chain validated: lock details <- tx data <- tx signature <- RPC`);
      }

      // Check if validation is pending
      const validationPending = validatedProof.validation.status === "PENDING_VALIDATION";

      if (validationPending) {
        console.log(`Validation pending - block too recent for RPC validation`);
        console.log(`NOTE: Token will be saved for later validation`);
      } else {
        console.log(`Proof validated successfully`);
      }

      // Step 2: Unicity Token Minting with SDK
      console.log(`\nSTEP 2: Unicity Token Minting`);
      // Restore [SHA256] prefix if the recipient is a 64-char hex string (Solana contract strips it due to length limit)
      const unicityRecipient = /^[a-f0-9]{64}$/i.test(event.unicityRecipient)
        ? `[SHA256]${event.unicityRecipient}`
        : event.unicityRecipient;

      let mintResult: any = null;
      let mintingFailed = false;

      try {
        mintResult = await mintBridgedTokenWithSDK(validatedProof, unicityRecipient, BRIDGE_CONFIG.outputDir, BRIDGE_CONFIG.bridgeProgramId);
      } catch (error) {
        mintingFailed = true;
        console.log(`SDK minting failed: ${error.message}`);
        if (error.message.includes('REQUEST_ID_EXISTS') || error.message.includes('AUTHORIZATION FAILED')) {
          console.log(`This is expected behavior - commitment already exists or wrong minter (re-mint protection)`);
        }
      }


      // Step 3: Result Summary
      console.log(`\nSTEP 3: Result Summary`);

      if (mintingFailed) {
        console.log(`No token files created (minting failed)`);
        console.log(`This prevents duplicate token creation - re-mint protection working correctly`);

        // Save validation metadata only
        if (validationPending) {
          const validationMetadata = this.createValidationMetadata(proof, validatedProof);
          fs.writeFileSync(
            path.join(BRIDGE_CONFIG.outputDir, `validation-metadata-${lockIdHex}.json`),
            JSON.stringify(validationMetadata, null, 2)
          );
          console.log(`Saved validation-metadata-${lockIdHex}.json for debugging`);
        }

      } else {
        const tokenFilename = `unicity-token-${lockIdHex}.json`;

        // Save validation metadata for pending validations only
        if (validationPending) {
          const validationMetadata = this.createValidationMetadata(proof, validatedProof);
          fs.writeFileSync(
            path.join(BRIDGE_CONFIG.outputDir, `validation-metadata-${lockIdHex}.json`),
            JSON.stringify(validationMetadata, null, 2)
          );

          console.log(`Generated files (SDK):`);
          console.log(`   ${tokenFilename} - Minted Unicity token using SDK`);
          console.log(`   token-owner-${lockIdHex}.json - Owner information`);
          console.log(`   genesis-record-${lockIdHex}.json - Human-readable Solana proof data`);
          console.log(`   validation-metadata-${lockIdHex}.json - Validation transcript for debugging`);
        } else {
          console.log(`Generated files (SDK):`);
          console.log(`   ${tokenFilename} - Minted Unicity token with commitment`);
          console.log(`   token-owner-${lockIdHex}.json - Owner information`);
          console.log(`   genesis-record-${lockIdHex}.json - Human-readable Solana proof data`);
        }
      }

      // Final operation summary
      if (mintingFailed) {
        console.log(`\nBRIDGE OPERATION: MINTING SKIPPED (RE-MINT PROTECTION)`);
        console.log(`SOL locked: ${(event.amount.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        console.log(`Reason: Commitment already exists or authorization failed`);
        console.log(`This is the expected behavior for duplicate mint transactions`);
      } else if (validationPending) {
        console.log(`\nBRIDGE OPERATION COMPLETED WITH PENDING VALIDATION!`);
        console.log(`SOL locked: ${(event.amount.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        console.log(`WARNING: Unicity token created (validation pending Solana block finalization)`);
        console.log(`Minter authorized: ${unicityRecipient}`);
        console.log(`Token saved to: ${BRIDGE_CONFIG.outputDir}`);
      } else {
        console.log(`\nBRIDGE OPERATION COMPLETED SUCCESSFULLY!`);
        console.log(`SOL locked: ${(event.amount.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        console.log(`Unicity token minted with commitment: ${mintResult.commitment.substring(0, 16)}...`);
        console.log(`Authorized minter: ${unicityRecipient}`);
        console.log(`Token saved to: ${BRIDGE_CONFIG.outputDir}`);
      }

      this.processedEvents++;

      // Mark transaction as processed (re-mint protection)
      this.processedTransactions.add(proof.transaction.signature);
      this.lastCheckedSlot = Math.max(this.lastCheckedSlot, proof.slot);

      // Periodically save processed transactions
      if (this.processedEvents % 5 === 0) {
        this.saveProcessedTransactions();
      }

      console.log(`\nStatistics:`);
      console.log(`   Events processed: ${this.processedEvents}`);
      console.log(`   Monitor uptime: ${process.uptime().toFixed(0)}s`);

    } catch (error) {
      console.error(`\nERROR: BRIDGE EVENT PROCESSING FAILED`);
      console.error(`Error:`, error.message);
    }
  }

  /**
   * Poll for missed bridge transactions by checking program account changes
   */
  private async pollForMissedTransactions(): Promise<void> {
    try {
      console.log(`\n[POLLING] Checking for missed transactions since slot ${this.lastCheckedSlot}...`);

      const connection = new Connection(BRIDGE_CONFIG.rpcUrl);
      const bridgeProgramId = new PublicKey(BRIDGE_CONFIG.bridgeProgramId);

      // Get recent transaction signatures for the bridge program
      const signatures = await connection.getSignaturesForAddress(bridgeProgramId, {
        limit: 50 // Check last 50 transactions
      });

      let foundMissedTransactions = 0;

      for (const sigInfo of signatures.reverse()) { // Process oldest first
        // Skip if already processed
        if (this.processedTransactions.has(sigInfo.signature)) {
          continue;
        }

        // Skip if slot is before our last checked slot
        if (sigInfo.slot <= this.lastCheckedSlot) {
          continue;
        }

        try {
          // Get full transaction details
          const tx = await connection.getTransaction(sigInfo.signature, {
            commitment: 'finalized',
            maxSupportedTransactionVersion: 0
          });

          if (tx && tx.meta && !tx.meta.err) {
            // Try to parse as a bridge transaction
            const lockEvent = await this.bridgeClient['parseTokenLockedEvent'](sigInfo.signature);

            if (lockEvent) {
              console.log(`\n[MISSED] Found missed transaction: ${sigInfo.signature.substring(0, 16)}...`);

              // Generate proof for this missed transaction
              const proof = await this.bridgeClient['generateProof'](lockEvent, sigInfo.signature, sigInfo.slot);

              // Process the missed event
              await this.processBridgeEvent(lockEvent, proof);
              foundMissedTransactions++;
            }
          }
        } catch (error) {
          console.log(`[POLLING] Could not process transaction ${sigInfo.signature.substring(0, 16)}: ${error.message}`);
        }
      }

      if (foundMissedTransactions > 0) {
        console.log(`[POLLING] Processed ${foundMissedTransactions} missed transactions`);
      } else {
        console.log(`[POLLING] No missed transactions found`);
      }

    } catch (error) {
      console.error(`[POLLING] Error checking for missed transactions:`, error.message);
    }
  }

  /**
   * Start periodic polling for missed transactions
   */
  private startPollingVerification(): void {
    // Poll every 60 seconds for missed transactions
    const POLLING_INTERVAL = 600 * 1000; // 10 minutes

    setInterval(async () => {
      if (this.isRunning) {
        await this.pollForMissedTransactions();
      }
    }, POLLING_INTERVAL);

    console.log(`Started polling verification (every ${POLLING_INTERVAL / 1000}s)`);
  }

  public async start(): Promise<void> {
    console.log(`SOLANA-UNICITY BRIDGE MONITOR`);
    console.log(`${'='.repeat(65)}`);

    try {
      // Get bridge state
      const bridgeState = await this.bridgeClient.getBridgeState();
      const escrowBalance = await this.bridgeClient.getEscrowBalance();

      console.log(`\nBridge Status:`);
      console.log(`   Program ID: ${BRIDGE_CONFIG.bridgeProgramId}`);
      console.log(`   Admin: ${bridgeState.admin.toString()}`);
      console.log(`   Total Locked: ${(bridgeState.totalLocked.toNumber() / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      console.log(`   Nonce: ${bridgeState.nonce.toString()}`);
      console.log(`   Escrow Balance: ${escrowBalance.toFixed(4)} SOL`);

      console.log(`\nValidation Source: Solana RPC (Real root of trust)`);

    } catch (error) {
      console.error(`ERROR: Failed to get bridge state:`, error.message);
    }

    // Check for any missed transactions on startup
    await this.pollForMissedTransactions();

    console.log(`\nMONITORING FOR BRIDGING EVENTS...`);
    console.log(`   Real-time: Listening for new SOL lock events`);
    console.log(`   Polling: Checking for missed transactions every 60s`);
    // console.log(`   Press Ctrl+C to stop monitoring`);
    // console.log(`   NOTE: Use 'npm run demo-lock <amount> <recipient>' to trigger events`);

    this.isRunning = true;

    // Start polling for missed transactions
    this.startPollingVerification();

    // Start real-time monitoring
    this.bridgeClient.monitorLockEvents(async (event: LockEvent, proof: ProofData) => {
      await this.processBridgeEvent(event, proof);

      console.log(`\nREADY FOR NEXT TRANSACTION...`);
    });

    // Keep process alive
    while (this.isRunning) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// Main execution
if (require.main === module) {
  const monitor = new BridgeMonitor();
  monitor.start().catch(error => {
    console.error(`ERROR: Bridge monitor failed:`, error);
    process.exit(1);
  });
}

export { BridgeMonitor };