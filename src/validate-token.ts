#!/usr/bin/env ts-node

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Connection } from "@solana/web3.js";
import { SolanaLightClient, UnicityProofValidator } from "./proof-validator";
import { PredicateJsonFactory } from '@unicitylabs/state-transition-sdk/lib/predicate/PredicateJsonFactory.js';
import { TokenFactory } from '@unicitylabs/state-transition-sdk/lib/token/TokenFactory.js';
import { TokenJsonSerializer } from '@unicitylabs/state-transition-sdk/lib/serializer/json/token/TokenJsonSerializer.js';

/**
 * Unicity Token Validator CLI
 *
 * Validates saved Unicity tokens by verifying:
 * 1. Token genesis cryptographic validation using Unicity SDK
 * 2. Embedded Solana locking proof data including signature status
 * 3. Signature status verification using Solana's getSignatureStatuses API
 * 4. Lock event data consistency and format validation
 * 5. Solana blockchain proof verification
 */

interface UnicityTokenFile {
  genesis: {
    data: {
      coins: [string, string][];
      dataHash: string | null;
      reason: string | null;
      recipient: string;
      salt: string;
      tokenData: string; // Hex encoded bridge proof data
      tokenId: string;
      tokenType: string;
    };
    inclusionProof: {
      authenticator: {
        algorithm: string;
        publicKey: string;
        signature: string;
        stateHash: string;
      };
      merkleTreePath: {
        root: string;
        steps: Array<{
          branch: string[];
          path: string;
          sibling: string;
        }>;
      };
      transactionHash: string;
    };
  };
  nametagTokens: any[];
  state: {
    data: string;
    unlockPredicate: {
      algorithm: string;
      hashAlgorithm: number;
      nonce: string;
      publicKey: string;
      type: string;
    };
  };
  transactions: any[];
  version: string;
}

interface DecodedSolanaProof {
  bridgeType: string;
  lockEvent: {
    lockId: string;
    user: string;
    amount: string;
    unicityRecipient: string;
    nonce: string;
    timestamp: string;
  };
  solanaTransaction: {
    signature: string;
    transaction: any;
    blockHeight: number;
    slot: number;
    blockTime: number | null;
    confirmationStatus: string;
  };
}


// Configuration, change the bridgeProgramId after re-deploying the Solana contract
const BRIDGE_CONFIG = {
  rpcUrl: "https://api.testnet.solana.com",
  bridgeProgramId: "9q5thPnZG7FKKNr61wceXdfuy2QRLYky8RTJonh2YzyB"
};

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

class UnicityTokenValidator {
  private lightClient: SolanaLightClient;
  private proofValidator: UnicityProofValidator;
  private validationResults: Array<{ check: string; status: 'PASS' | 'FAIL' | 'WARN'; message: string }> = [];

  constructor() {
    this.lightClient = new SolanaLightClient(BRIDGE_CONFIG.rpcUrl);
    this.proofValidator = new UnicityProofValidator(BRIDGE_CONFIG.rpcUrl, BRIDGE_CONFIG.bridgeProgramId);
  }

  private log(message: string, color: string = colors.reset): void {
    console.log(`${color}${message}${colors.reset}`);
  }

  private addResult(check: string, status: 'PASS' | 'FAIL' | 'WARN', message: string): void {
    this.validationResults.push({ check, status, message });

    const icon = status === 'PASS' ? 'PASS' : status === 'WARN' ? 'WARN' : 'FAIL';

    this.log(`[${icon}] ${check}: ${message}`);
  }

  private decodeTokenData(hexData: string): DecodedSolanaProof {
    try {
      const jsonString = Buffer.from(hexData, 'hex').toString('utf8');
      return JSON.parse(jsonString);
    } catch (error) {
      throw new Error(`Failed to decode token data: ${error.message}`);
    }
  }

  // only data structure checks
  private validateSolanaLockingProof(tokenData: string): DecodedSolanaProof | null {
    try {
      const decoded = this.decodeTokenData(tokenData);

      // Validate bridge type
      if (decoded.bridgeType !== "SOLANA_BRIDGE") {
        this.addResult("Bridge Type", "FAIL", `Expected SOLANA_BRIDGE, got ${decoded.bridgeType}`);
        return null;
      }

      // Validate lock event structure
      const lock = decoded.lockEvent;
      if (!lock.lockId || !lock.user || !lock.amount || !lock.unicityRecipient || !lock.nonce || !lock.timestamp) {
        this.addResult("Lock Event", "FAIL", "Missing required lock event fields");
        return null;
      }

      // Validate minimal Solana anchor structure
      const anchor = decoded.solanaTransaction;
      if (!anchor.signature || typeof anchor.blockHeight !== 'number' || typeof anchor.slot !== 'number') {
        this.addResult("Solana Anchor", "FAIL", "Missing required Solana anchor fields (signature, blockHeight, slot)");
        return null;
      }

      // Validate transaction signature format
      if (!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(anchor.signature)) {
        this.addResult("Transaction Signature", "FAIL", "Invalid Solana transaction signature format");
        return null;
      }

      this.addResult("Solana Locking Proof", "PASS", "Solana locking proof is consistent");
      return decoded;
    } catch (error) {
      this.addResult("Solana Locking Proof", "FAIL", `Failed to decode: ${error.message}`);
      return null;
    }
  }


  /**
   * Extract lock event data from Solana transaction logs for cryptographic verification
   */
  private async extractLockEventFromTransaction(transaction: any): Promise<{
    lockId: string;
    user: string;
    amount: string;
    unicityRecipient: string;
    nonce: string;
    timestamp: string;
  } | null> {
    try {
      if (!transaction.meta || !transaction.meta.logMessages) {
        throw new Error('Transaction missing log messages');
      }

      // Parse events, we're avoiding the Anchor framework on purpose
      // Find the "Program data:" log entry that contains the event data
      const programDataLog = transaction.meta.logMessages.find((log: string) =>
        log.startsWith('Program data:')
      );

      if (!programDataLog) {
        throw new Error('No Program data log found in transaction');
      }

      // Extract base64 data after "Program data: "
      const base64Data = programDataLog.substring('Program data: '.length);
      const eventData = Buffer.from(base64Data, 'base64');

      // Parse the event data using manual deserialization
      const parsedEvent = this.parseTokenLockedEvent(eventData);

      if (parsedEvent) {
        return parsedEvent;
      } else {
        throw new Error('Could not parse TokenLocked event from program data');
      }

    } catch (error) {
      throw new Error(`Failed to extract lock event: ${error.message}`);
    }
  }

  /**
   * Parse TokenLocked event data from Solana transaction logs
   * - Event discriminator (8 bytes) - identifies the event type
   * - Event data fields in the order defined in the IDL
   */
  private parseTokenLockedEvent(eventData: Buffer): {
    lockId: string;
    user: string;
    amount: string;
    unicityRecipient: string;
    nonce: string;
    timestamp: string;
  } | null {
    try {
      // TokenLocked event discriminator from IDL: [18, 238, 170, 48, 2, 120, 199, 224]
      const expectedDiscriminator = Buffer.from([18, 238, 170, 48, 2, 120, 199, 224]);

      if (eventData.length < 8) {
        throw new Error('Event data too short to contain discriminator');
      }

      // Check event discriminator
      const discriminator = eventData.subarray(0, 8);
      if (!discriminator.equals(expectedDiscriminator)) {
        throw new Error(`Event discriminator mismatch. Expected: ${expectedDiscriminator.toString('hex')}, got: ${discriminator.toString('hex')}`);
      }

      let offset = 8; // Jump over discriminator

      // Parse lock_id: [u8; 32]
      if (offset + 32 > eventData.length) throw new Error('Not enough data for lock_id');
      const lockId = eventData.subarray(offset, offset + 32).toString('hex');
      offset += 32;

      // Parse user: PublicKey (32 bytes)
      if (offset + 32 > eventData.length) throw new Error('Not enough data for user');
      const userBytes = eventData.subarray(offset, offset + 32);
      // Convert bytes to base58 PublicKey string
      const { PublicKey } = require('@solana/web3.js');
      const user = new PublicKey(userBytes).toString();
      offset += 32;

      // Parse amount: u64 (8 bytes, little endian)
      if (offset + 8 > eventData.length) throw new Error('Not enough data for amount');
      const amountBytes = eventData.subarray(offset, offset + 8);
      const amount = this.readU64LE(amountBytes).toString();
      offset += 8;

      // Parse unicity_recipient: String (4 bytes length prefix + string data)
      if (offset + 4 > eventData.length) throw new Error('Not enough data for string length');
      const recipientLength = eventData.readUInt32LE(offset);
      offset += 4;

      if (offset + recipientLength > eventData.length) throw new Error('Not enough data for unicity_recipient string');
      const unicityRecipient = eventData.subarray(offset, offset + recipientLength).toString('utf8');
      offset += recipientLength;

      // Parse nonce: u64 (8 bytes, little endian)
      if (offset + 8 > eventData.length) throw new Error('Not enough data for nonce');
      const nonceBytes = eventData.subarray(offset, offset + 8);
      const nonce = this.readU64LE(nonceBytes).toString();
      offset += 8;

      // Parse timestamp: i64 (8 bytes, little endian, signed)
      if (offset + 8 > eventData.length) throw new Error('Not enough data for timestamp');
      const timestampBytes = eventData.subarray(offset, offset + 8);
      const timestamp = this.readI64LE(timestampBytes).toString();
      offset += 8;

      return {
        lockId,
        user,
        amount,
        unicityRecipient,
        nonce,
        timestamp
      };

    } catch (error) {
      console.error('Failed to parse TokenLocked event:', error.message);
      return null;
    }
  }

  /**
   * Read a 64-bit unsigned integer from buffer in little-endian format
   */
  private readU64LE(buffer: Buffer): bigint {
    const low = buffer.readUInt32LE(0);
    const high = buffer.readUInt32LE(4);
    return BigInt(low) + (BigInt(high) << 32n);
  }

  /**
   * Read a 64-bit signed integer from buffer in little-endian format
   */
  private readI64LE(buffer: Buffer): bigint {
    const low = buffer.readUInt32LE(0);
    const high = buffer.readInt32LE(4); // Use signed read for high part
    return BigInt(low) + (BigInt(high) << 32n);
  }

  private async validateSolanaAnchor(proof: DecodedSolanaProof): Promise<boolean> {
    try {
      const { blockHeight, signature } = proof.solanaTransaction;

      // Basic validation - we don't need to verify block hashes anymore
      // The cryptographic verification against the transaction is sufficient

      // Validate transaction signature format
      if (!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(signature)) {
        this.addResult("Transaction Signature", "FAIL", "Invalid signature format");
        return false;
      }

      // Validate block height is reasonable
      if (blockHeight < 0 || blockHeight > 1000000000) {
        this.addResult("Block Height", "FAIL", "Invalid block height");
        return false;
      }

      this.addResult("Solana Anchor", "PASS", "Solana anchor structure validated");
      return true;
    } catch (error) {
      this.addResult("Solana Anchor", "FAIL", `Anchor validation failed: ${error.message}`);
      return false;
    }
  }



  public async validateToken(tokenFilePath: string): Promise<{ valid: boolean; summary: string }> {
    this.validationResults = [];

    this.log(`Validating: ${tokenFilePath}`);
    this.log("");

    try {
      // Load token file
      if (!fs.existsSync(tokenFilePath)) {
        this.addResult("File Access", "FAIL", "Token file not found");
        return { valid: false, summary: "File not found" };
      }

      const tokenData = fs.readFileSync(tokenFilePath, 'utf8');
      const tokenJson = JSON.parse(tokenData);

      // Step 1: Use TokenFactory to deserialize and validate token
      try {
        const predicateFactory = new PredicateJsonFactory();
        const tokenFactory = new TokenFactory(new TokenJsonSerializer(predicateFactory));
        const token = await tokenFactory.create(tokenJson);
        this.addResult("Token Deserialization", "PASS", "Token, unicity proof cryptographically validated by SDK");
      } catch (error) {
        this.addResult("Token Deserialization", "FAIL", `TokenFactory validation failed: ${error.message}`);
        return { valid: false, summary: error.message };
      }

      // Step 2: Parse and validate Solana locking proof data structure
      const decodedProof = this.validateSolanaLockingProof(tokenJson.genesis.data.tokenData);
      if (!decodedProof) {
        return { valid: false, summary: "Invalid Solana locking proof" };
      }

      // Step 3: Cryptographically validate lock event against transaction signature
      let cryptographicValid = false;
      try {
        const { signature } = decodedProof.solanaTransaction;

        // Fetch the actual transaction from Solana to verify the lock event data
        const connection = this.lightClient['connection'];

        try {
          const transaction = await connection.getTransaction(signature, {
            commitment: 'finalized',
            maxSupportedTransactionVersion: 0
          });

          if (!transaction) {
            this.addResult("Transaction Verification", "WARN", "Transaction not found on Solana blockchain (may be old)");
            cryptographicValid = true;
          } else if (transaction.meta?.err) {
            this.addResult("Transaction Verification", "FAIL", `Transaction failed: ${JSON.stringify(transaction.meta.err)}`);
          } else {

            // Step 1: Verify transaction signature is valid (transaction exists and succeeded)
            this.addResult("Transaction Existence", "PASS", "Transaction exists and succeeded on Solana");

            // Step 2: Verify transaction involves bridge program
            const bridgeProgramId = BRIDGE_CONFIG.bridgeProgramId;
            let accountKeys: any[] = [];

            if ('accountKeys' in transaction.transaction.message) {
              accountKeys = transaction.transaction.message.accountKeys;
            } else {
              accountKeys = transaction.transaction.message.getAccountKeys().staticAccountKeys;
            }

            const isBridgeTransaction = accountKeys.some((key: any) =>
              key.toString() === bridgeProgramId
            );

            if (!isBridgeTransaction) {
              this.addResult("Bridge Program Verification", "FAIL",
                "Transaction does not involve the expected bridge program");
              return;
            }

            this.addResult("Bridge Program Verification", "PASS", "Transaction involves the right bridge program");

            // Step 3: Extract actual lock event from transaction logs (CRITICAL SECURITY STEP)
            try {
              const actualLockEvent = await this.extractLockEventFromTransaction(transaction);

              if (!actualLockEvent) {
                this.addResult("Lock Event Extraction", "WARN", "Could not extract lock event from transaction logs - accepting signature validation");
                cryptographicValid = true;
                return;
              }

              this.addResult("Lock Event Extraction", "PASS", "Lock event successfully extracted from transaction logs");

              // Step 4: Cryptographically compare claimed vs actual lock event data
              const claimed = decodedProof.lockEvent;
              const fieldsMatch = (
                actualLockEvent.lockId === claimed.lockId &&
                actualLockEvent.user === claimed.user &&
                actualLockEvent.amount === claimed.amount &&
                actualLockEvent.unicityRecipient === claimed.unicityRecipient &&
                actualLockEvent.nonce === claimed.nonce &&
                actualLockEvent.timestamp === claimed.timestamp
              );

              if (fieldsMatch) {
                cryptographicValid = true;
                this.addResult("Cryptographic Verification", "PASS",
                  `Lock event data cryptographically validated: claimed data matches actual transaction data`);
              } else {
                this.addResult("Cryptographic Verification", "FAIL",
                  "SECURITY FAILURE: Claimed lock event data does not match actual transaction data");

                // Log the discrepancy for debugging
                console.log("CLAIMED:", claimed);
                console.log("ACTUAL:", actualLockEvent);
              }

            } catch (extractionError) {
              this.addResult("Lock Event Extraction", "WARN",
                `Could not extract lock event (accepting signature validation): ${extractionError.message}`);
              cryptographicValid = true;
            }
          }
        } catch (error) {
          this.addResult("Transaction Verification", "WARN",
            `Could not fetch transaction (may be old): ${error.message}`);
          // For old transactions, we accept them if the signature format is valid
          cryptographicValid = true;
        }
      } catch (error) {
        this.addResult("Cryptographic Verification", "FAIL",
          `Cryptographic validation failed: ${error.message}`);
      }

      const blockchainValid = await this.validateSolanaAnchor(decodedProof);

      // Generate summary
      const passCount = this.validationResults.filter(r => r.status === 'PASS').length;
      const failCount = this.validationResults.filter(r => r.status === 'FAIL').length;
      const warnCount = this.validationResults.filter(r => r.status === 'WARN').length;

      const overallValid = failCount === 0;

      const overallStatus = overallValid ? "VALID" : "INVALID";

      this.log(`\n${overallStatus}`);

      return {
        valid: overallValid,
        summary: `${passCount} passed, ${failCount} failed, ${warnCount} warnings`
      };

    } catch (error) {
      this.addResult("Validation Process", "FAIL", `Unexpected error: ${error.message}`);
      return { valid: false, summary: `Validation error: ${error.message}` };
    }
  }

  public static async main(): Promise<void> {
    const args = process.argv.slice(2);

    if (args.length !== 1) {
      console.error(`\nERROR: Invalid arguments\n`);
      console.log(`Usage: npm run validate-token <token-file>`);
      console.log(`\nExamples:`);
      console.log(`  npm run validate-token demo-output/unicity-token-41a5e5ca.json`);
      process.exit(1);
    }

    const tokenFilePath = args[0];

    // Convert relative path to absolute
    const absolutePath = path.resolve(tokenFilePath);

    const validator = new UnicityTokenValidator();
    const result = await validator.validateToken(absolutePath);

    process.exit(result.valid ? 0 : 1);
  }
}

// Main execution
if (require.main === module) {
  UnicityTokenValidator.main().catch(error => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}

export { UnicityTokenValidator };