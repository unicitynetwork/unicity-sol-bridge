import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { SolanaBridgeClient, LockEvent, ProofData } from "./bridge-client";
import { UnicityProofValidator, ProofUtils } from "./proof-validator";
import { UnicityBridgeIntegration } from "./unicity-integration";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/**
 * Load Unicity wallet to get the public key for use as recipient
 */
function loadUnicityWallet(): {
  secret: Uint8Array;
  nonce: Uint8Array;
  publicKey: string;
} | null {
  const walletFile = path.join(os.homedir(), '.config', 'unicity', 'bridge-minter.json');

  if (!fs.existsSync(walletFile)) {
    console.error('Unicity wallet not found. Run: npx ts-node src/create-unicity-wallet.ts --generate');
    return null;
  }

  try {
    const walletData = JSON.parse(fs.readFileSync(walletFile, 'utf8'));
    return {
      secret: new Uint8Array(walletData.secretKey),
      nonce: new Uint8Array(walletData.nonce),
      publicKey: walletData.publicKey
    };
  } catch (error) {
    console.error('Failed to load Unicity wallet:', error.message);
    return null;
  }
}

/**
 * Check for recent missed transactions and return the most recent one
 */
async function checkForRecentEvents(
  bridgeClient: SolanaBridgeClient,
  bridgeProgramId: string,
  rpcUrl: string
): Promise<{event: LockEvent, proof: ProofData} | null> {
  try {
    console.log("Checking for recent bridge events...");

    const connection = new Connection(rpcUrl);
    const programId = new PublicKey(bridgeProgramId);

    // Get recent transaction signatures for the bridge program
    const signatures = await connection.getSignaturesForAddress(programId, {
      limit: 10 // Check last 10 transactions
    });

    // Process from most recent to oldest
    for (const sigInfo of signatures) {
      try {
        // Get full transaction details
        const tx = await connection.getTransaction(sigInfo.signature, {
          commitment: 'finalized',
          maxSupportedTransactionVersion: 0
        });

        if (tx && tx.meta && !tx.meta.err) {
          // Try to parse as a bridge transaction using private methods
          const lockEvent = await (bridgeClient as any).parseTokenLockedEvent(sigInfo.signature);

          if (lockEvent) {
            console.log(`Found recent event: ${sigInfo.signature.substring(0, 16)}...`);

            // Generate proof for this transaction
            const proof = await (bridgeClient as any).generateProof(lockEvent, sigInfo.signature, sigInfo.slot);

            return { event: lockEvent, proof };
          }
        }
      } catch (error) {
        // Ignore parse errors for non-bridge transactions
        continue;
      }
    }

    console.log("No recent bridge events found");
    return null;

  } catch (error) {
    console.log(`Could not check for recent events: ${error.message}`);
    return null;
  }
}

/**
 *  End-to-end demo flow of the Solana-Unicity bridge
 */
async function completeDemo() {
  console.log("Solana-Unicity Bridge Demo");
  console.log("=====================================");

  // Configuration, change the bridgeProgramId after re-deploying the Solana contract
  const rpcUrl = "https://api.testnet.solana.com";
  const bridgeProgramId = "9q5thPnZG7FKKNr61wceXdfuy2QRLYky8RTJonh2YzyB";

  // Load Unicity wallet first to get the recipient address
  console.log("\nSetup: Loading Unicity Wallet");
  const unicityWallet = loadUnicityWallet();
  if (!unicityWallet) {
    console.error("Cannot proceed without Unicity wallet");
    console.error("Please run: npx ts-node src/create-unicity-wallet.ts --generate");
    process.exit(1);
  }

  const unicityRecipient = unicityWallet.publicKey; // This already has [SHA256] prefix
  console.log("- Public Key:", unicityWallet.publicKey);
  console.log("- Recipient Format:", unicityRecipient);

  // Setup Solana wallet
  let keypair: Keypair;
  try {
    const walletPath = path.join(os.homedir(), ".config", "solana", "id.json");
    const secretKey = JSON.parse(fs.readFileSync(walletPath, "utf8"));
    keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));
  } catch (error) {
    keypair = Keypair.generate();
    console.log(`No Solana wallet found, creating an ephemeral one on the fly`);
  }

  console.log("Solana Wallet Address:", keypair.publicKey.toString());

  // Initialize components
  const wallet = new anchor.Wallet(keypair);
  const bridgeClient = new SolanaBridgeClient(rpcUrl, wallet);
  const proofValidator = new UnicityProofValidator(rpcUrl, bridgeProgramId);
  const unicityIntegration = new UnicityBridgeIntegration();

  console.log("\nBridge Setup");

  // Prepare output directory
  const outputDir = path.join(__dirname, "../output");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log("\nSetting up Event Monitoring");
  console.log("=====================================");

  // First check for any recent events that might have been missed
  const recentEvent = await checkForRecentEvents(bridgeClient, bridgeProgramId, rpcUrl);

  // Set up event monitoring FIRST, then create transaction
  let eventProcessed = false;

  const eventPromise = new Promise<void>((resolve, reject) => {
    console.log("Starting event listener...");

    // If we found a recent event, process it immediately
    if (recentEvent) {
      console.log("Processing recent event found during startup...");
      setTimeout(async () => {
        if (!eventProcessed) {
          eventProcessed = true;
          await processEvent(recentEvent.event, recentEvent.proof, resolve, reject);
        }
      }, 100);
    }

    bridgeClient.monitorLockEvents(async (event: LockEvent, proof: ProofData) => {
      if (eventProcessed) return; // Only process first event
      eventProcessed = true;
      await processEvent(event, proof, resolve, reject);
    });
  });

  // Helper function to process events (reduces code duplication)
  async function processEvent(event: LockEvent, proof: ProofData, resolve: () => void, reject: (error: any) => void) {
      console.log("\nLOCK EVENT DETECTED!");
      console.log("========================");

      try {
        // Proof Validation
        console.log("\nValidating the proof of Solana locking tx...");
        const validatedProof = await proofValidator.validateGenesisProof(proof);
        console.log("Proof validation OK!");

        // Validate complete cryptographic chain
        console.log("\nValidating cryptographic chain...");
        const chainValid = await proofValidator.validateCryptographicChain(validatedProof);
        if (!chainValid) {
          throw new Error("Cryptographic chain validation failed");
        }
        console.log("Cryptographic chain validation OK");

        // Restore [SHA256] prefix if the recipient is a 64-char hex string (Solana contract strips it due to length limit)
        const eventRecipient = /^[a-f0-9]{64}$/i.test(event.unicityRecipient)
          ? `[SHA256]${event.unicityRecipient}`
          : event.unicityRecipient;

        console.log("\nMinting the bridged token using Unicity Strate Transition SDK...");

        let mintResult;
        let tokenAlreadyExists = false;

        try {
          mintResult = await unicityIntegration.mintBridgedTokens(validatedProof, eventRecipient);

          console.log("\nDone,");
          console.log("- Token Name:", mintResult.tokenConfig.tokenName);
          console.log("- Symbol:", mintResult.tokenConfig.symbol);
          console.log("- Amount:", (Number(mintResult.tokenConfig.totalSupply) / LAMPORTS_PER_SOL).toFixed(4), "bSOL");
          console.log("- Holder:", eventRecipient);
          console.log("- Commitment:", mintResult.commitment); // todo: stringify
          console.log("- Status:", mintResult.status);

        } catch (mintError) {
          if (mintError.message.includes('REQUEST_ID_EXISTS') || mintError.message.includes('already exists')) {
            console.log("\nTOKEN ALREADY MINTED");
            console.log("(This is the correct behavior - double spending prevented)");
            tokenAlreadyExists = true;
          } else {
            throw mintError; // Re-throw other errors
          }
        }
        if (tokenAlreadyExists) {
          reject(new Error('TOKEN_ALREADY_EXISTS'));
          return;
        }

        const lockIdHex = Buffer.from(event.lockId).toString('hex');

        console.log("\nFiles generated in ./output/:");
        console.log(`- unicity-token-${lockIdHex.substring(0, 8)}.json (self-contained Unicity Token)`);
        console.log(`- token-owner-${lockIdHex.substring(0, 8)}.json (Token Owner information)`);
        console.log(`- genesis-record-${lockIdHex.substring(0, 8)}.json (Human-readable genesis record)`);

        const isVerifiable = ProofUtils.verifyProofIntegrity(validatedProof);
        console.log("Proof integrity check:", isVerifiable ? "PASSED" : "FAILED");

        resolve(); // Complete the promise

      } catch (error) {
        console.error("\n❌ Bridged token minting failed, error:", error.message);
        console.error(error);
        reject(error);
      }
  }

  // Track if we need to create a fresh transaction
  let needsFreshTransaction = true;

  if (recentEvent) {
    console.log("\nFound recent event - will check if already minted");
    needsFreshTransaction = false; // Initially assume we don't need fresh transaction
  }

  console.log("Waiting for lock event to be detected and processed...");

  try {
    await eventPromise;
    console.log("\n✅ Event processing completed!");
  } catch (error) {
    console.error("\n❌ Event processing failed:", error.message);
    // If event processing failed due to already minted token, we'll create fresh transaction
    if (error.message.includes('TOKEN_ALREADY_EXISTS') ||
        error.message.includes('already exists') ||
        error.message.includes('REQUEST_ID_EXISTS')) {
      needsFreshTransaction = true;
      console.log("Will create a fresh Solana locking transaction");
    } else {
      process.exit(1);
    }
  }

  // Create fresh transaction if needed
  if (needsFreshTransaction) {
    console.log("\nCreating Solana transaction to lock funds in bridge contract");

    // Create lock transaction with Unicity recipient
    const lockAmount = 0.042; // SOL amount to lock
    const amountLamports = Math.floor(lockAmount * LAMPORTS_PER_SOL);

    console.log("- Amount:", lockAmount, "SOL");
    console.log("- Recipient:", unicityRecipient);
    console.log("- Solana Sender:", keypair.publicKey.toString());

    // Strip [SHA256] prefix for Solana contract (due to length limit)
    const contractRecipient = unicityRecipient.startsWith('[SHA256]')
      ? unicityRecipient.substring(8)
      : unicityRecipient;

    // IMPORTANT: Start event monitoring BEFORE sending transaction to avoid race condition
    console.log("\nSetting up event monitoring BEFORE sending transaction...");

    const freshEventPromise = new Promise<void>((resolve, reject) => {
      let freshEventProcessed = false;

      bridgeClient.monitorLockEvents(async (event: LockEvent, proof: ProofData) => {
        if (freshEventProcessed) return; // Only process first fresh event
        freshEventProcessed = true;

        console.log("\nSolana token locking event captured!");

        await processEvent(event, proof, resolve, reject);
      });
    });

    console.log("Event monitoring started. Now sending transaction...");

    try {
      const lockResult = await bridgeClient.lockSol(amountLamports, contractRecipient);
      console.log("Lock transaction finalized");
      console.log("- Transaction Signature:", lockResult);
      console.log("- Explorer:", `https://explorer.solana.com/tx/${lockResult}?cluster=testnet`);

    } catch (error) {
      console.error("❌ Failed to create lock transaction:", error.message);
      process.exit(1);
    }

    try {
      await freshEventPromise;
    } catch (error) {
      console.error("\n❌ Transaction processing failed:", error.message);
      process.exit(1);
    }
  }

  console.log("\nWaiting for Solana asset locking events, hit Ctrl+C to cancel");
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log("\n Shutting down...");
  process.exit(0);
});

// Export for testing
export { completeDemo };

if (require.main === module) {
  completeDemo().catch(console.error);
}