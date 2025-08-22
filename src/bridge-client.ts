import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, LAMPORTS_PER_SOL, SystemProgram, GetProgramAccountsFilter } from "@solana/web3.js";
import { UnicityBridge } from "../target/types/unicity_bridge";
import BN from "bn.js";
import * as crypto from "crypto";

export interface LockEvent {
  lockId: number[];
  user: PublicKey;
  amount: BN;
  unicityRecipient: string;
  nonce: BN;
  timestamp: BN;
}

export interface ProofData {
  event: LockEvent;
  slot: number;
  blockHash: string;
  blockHeight: number;
  transaction: {
    signature: string;
    slot: number;
    blockTime: number;
    fullTransaction?: any; // Complete transaction data from RPC for cryptographic validation
  };
  signatureStatus: {
    confirmationStatus?: string;
    confirmations?: number | null;
    err: any;
    slot?: number;
  } | null;
}

export class SolanaBridgeClient {
  private connection: Connection;
  private program: Program<UnicityBridge>;
  private provider: anchor.AnchorProvider;

  constructor(rpcUrl: string, wallet: anchor.Wallet) {
    this.connection = new Connection(rpcUrl);
    this.provider = new anchor.AnchorProvider(this.connection, wallet, {});
    anchor.setProvider(this.provider);
    this.program = anchor.workspace.unicityBridge as Program<UnicityBridge>;
  }

  /**
   * Initialize the bridge contract
   */
  async initializeBridge(admin: PublicKey): Promise<string> {
    const [bridgeStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bridge_state")],
      this.program.programId
    );

    try {
      const tx = await this.program.methods
        .initialize(admin)
        .accountsPartial({
          bridgeState: bridgeStatePda,
          user: this.provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log("Bridge initialized with transaction:", tx);
      return tx;
    } catch (error) {
      console.error("Failed to initialize bridge:", error);
      throw error;
    }
  }

  /**
   * Lock SOL in the bridge
   */
  async lockSol(amount: number, unicityRecipient: string): Promise<string> {
    const [bridgeStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bridge_state")],
      this.program.programId
    );

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow")],
      this.program.programId
    );

    const amountLamports = new BN(amount);

    try {
      const tx = await this.program.methods
        .lockSol(amountLamports, unicityRecipient)
        .accountsPartial({
          bridgeState: bridgeStatePda,
          escrow: escrowPda,
          user: this.provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.log(`Locked ${amount / LAMPORTS_PER_SOL} SOL for ${unicityRecipient}. Transaction:`, tx);
      return tx;
    } catch (error) {
      console.error("Failed to lock SOL:", error);
      throw error;
    }
  }

  /**
   * Monitor for TokenLocked events
   */
  async monitorLockEvents(callback: (event: LockEvent, proof: ProofData) => void): Promise<void> {
    console.log("Starting to monitor lock events...");

    // Set up event listener for program logs
    this.connection.onLogs(
      this.program.programId,
      async (logs, ctx) => {
        // Look for TokenLocked event in logs
        const tokenLockedLog = logs.logs.find(log =>
          log.includes("TokenLocked") || log.includes("Program log:")
        );

        if (tokenLockedLog && logs.signature) {
          try {
            // Get transaction details
            const txDetails = await this.connection.getTransaction(logs.signature, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: 0
            });

            if (txDetails && txDetails.meta) {
              // Parse event from transaction
              const event = await this.parseTokenLockedEvent(logs.signature);
              if (event) {
                // Generate proof
                const proof = await this.generateProof(event, logs.signature, ctx.slot);
                callback(event, proof);
              }
            }
          } catch (error) {
            console.error("Error processing lock event:", error);
          }
        }
      },
      "confirmed"
    );
  }

  /**
   * Parse TokenLocked event from transaction signature
   */
  private async parseTokenLockedEvent(signature: string): Promise<LockEvent | null> {
    try {
      const txDetails = await this.connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });

      if (!txDetails || !txDetails.meta) {
        console.error(`Fetching Solana transaction failed. Tx signature: ${signature}`);
        return null;
      }

      // Try to parse events using Anchor's event parser
      try {
        const eventParser = new anchor.EventParser(this.program.programId, this.program.coder);
        const eventsGenerator = eventParser.parseLogs(txDetails.meta.logMessages || []);
        const events = Array.from(eventsGenerator);

        // Find TokenLocked event
        const tokenLockedEvent = events.find(event => event.name === 'TokenLocked' || event.name === 'tokenLocked');

        if (tokenLockedEvent && tokenLockedEvent.data) {
          const eventData = tokenLockedEvent.data;

          return {
            lockId: Array.from(eventData.lockId),
            user: eventData.user || this.provider.wallet.publicKey,
            amount: new BN(eventData.amount || 0),
            unicityRecipient: eventData.unicityRecipient || "",
            nonce: new BN(eventData.nonce || 0),
            timestamp: new BN(eventData.timestamp || 0)
          };
        }
      } catch (eventParseError) {
        console.log("Anchor event parsing failed:", eventParseError);
      }
      return null;
    } catch (error) {
      console.error("Error parsing TokenLocked event:", error);
    }
    return null;
  }

  /**
   * Generate proof for a lock event using Solana's signature status validation
   */
  private async generateProof(event: LockEvent, signature: string, slot: number): Promise<ProofData> {
    // Get transaction details for block information
    const txDetails = await this.connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });

    if (!txDetails) {
      throw new Error(`Transaction not found: ${signature}`);
    }

    // Validate transaction execution using Solana's signature status API
    const signatureStatuses = await this.connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true
    });

    const signatureStatus = signatureStatuses.value[0];

    if (!signatureStatus) {
      throw new Error(`Could not get signature status for transaction: ${signature}`);
    }

    // Verify transaction succeeded (no error)
    if (signatureStatus.err) {
      throw new Error(`Transaction failed with error: ${JSON.stringify(signatureStatus.err)}`);
    }

    // Get block hash from transaction details or attempt to fetch block
    let blockHash = '';
    let blockTime = txDetails.blockTime || 0;
    
    try {
      const block = await this.connection.getBlock(slot, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0
      });
      if (block) {
        blockHash = block.blockhash;
        blockTime = block.blockTime || blockTime;
      }
    } catch (error) {
      // Block may not be available yet - use transaction details
      console.log(`Could not fetch block ${slot}, using transaction details`);
    }

    const proof: ProofData = {
      event,
      slot,
      blockHash,
      blockHeight: slot, // Use slot as blockHeight since blockHeight may not be available
      transaction: {
        signature,
        slot,
        blockTime,
        fullTransaction: txDetails // Store complete transaction data for cryptographic validation
      },
      signatureStatus
    };

    return proof;
  }

  /**
   * Verify a proof using Solana's signature status validation
   */
  static verifyProof(proof: ProofData): boolean {
    console.log("Verifying proof for lock event:");
    console.log("- Lock ID:", Buffer.from(proof.event.lockId).toString('hex'));
    console.log("- User:", proof.event.user.toString());
    console.log("- Amount:", proof.event.amount.toString());
    console.log("- Unicity Recipient:", proof.event.unicityRecipient);
    console.log("- Block Hash:", proof.blockHash);
    console.log("- Block Height:", proof.blockHeight);
    console.log("- Transaction Signature:", proof.transaction.signature);
    
    if (proof.signatureStatus) {
      console.log("- Signature Status:", proof.signatureStatus.confirmationStatus);
      console.log("- Confirmations:", proof.signatureStatus.confirmations);
      console.log("- Error:", proof.signatureStatus.err || 'none');
      console.log("- Signature Slot:", proof.signatureStatus.slot);
    }

    // Basic validation
    if (!proof.event.lockId || proof.event.lockId.length !== 32) {
      console.error("Invalid lock ID");
      return false;
    }

    if (!proof.event.user || !proof.event.amount || proof.event.amount.lte(new BN(0))) {
      console.error("Invalid event data");
      return false;
    }

    if (!proof.transaction.signature) {
      console.error("Invalid proof data: missing transaction signature");
      return false;
    }

    // Validate signature status
    if (!proof.signatureStatus) {
      console.error("Invalid signature status: not available");
      return false;
    }

    if (proof.signatureStatus.err) {
      console.error("Transaction failed:", proof.signatureStatus.err);
      return false;
    }

    // Check confirmation status
    if (!proof.signatureStatus.confirmationStatus || 
        !['processed', 'confirmed', 'finalized'].includes(proof.signatureStatus.confirmationStatus)) {
      console.error("Invalid confirmation status:", proof.signatureStatus.confirmationStatus);
      return false;
    }

    console.log("✅ Signature status validation successful");
    console.log("📋 Transaction confirmed with status:", proof.signatureStatus.confirmationStatus);
    console.log("📋 Confirmations:", proof.signatureStatus.confirmations);
    
    return true;
  }

  /**
   * Get bridge state
   */
  async getBridgeState(): Promise<any> {
    const [bridgeStatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bridge_state")],
      this.program.programId
    );

    try {
      const bridgeState = await this.program.account.bridgeState.fetch(bridgeStatePda);
      return bridgeState;
    } catch (error) {
      console.error("Failed to fetch bridge state:", error);
      throw error;
    }
  }

  /**
   * Get escrow balance
   */
  async getEscrowBalance(): Promise<number> {
    const [escrowPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow")],
      this.program.programId
    );

    try {
      const balance = await this.connection.getBalance(escrowPda);
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      console.error("Failed to fetch escrow balance:", error);
      throw error;
    }
  }
}

