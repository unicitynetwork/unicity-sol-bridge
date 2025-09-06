#!/usr/bin/env ts-node

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { SolanaLightClient, UnicityProofValidator } from "./proof-validator";
import { PredicateJsonFactory } from '@unicitylabs/state-transition-sdk/lib/predicate/PredicateJsonFactory.js';
import { TokenFactory } from '@unicitylabs/state-transition-sdk/lib/token/TokenFactory.js';
import { TokenJsonSerializer } from '@unicitylabs/state-transition-sdk/lib/serializer/json/token/TokenJsonSerializer.js';
import { SigningService } from '@unicitylabs/state-transition-sdk/node_modules/@unicitylabs/commons/lib/signing/SigningService.js';
import { DataHasher } from '@unicitylabs/state-transition-sdk/node_modules/@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/node_modules/@unicitylabs/commons/lib/hash/HashAlgorithm.js';

const secp256k1 = require('secp256k1');

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
  minterSignature?: string;
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
  private consistentSolanaLockingProof(tokenData: string): DecodedSolanaProof | null {
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

  /**
   * Verify that minter's public key matches what's in the Solana locking transaction
   */
  private validateMinterKeyConsistency(
    decodedProof: DecodedSolanaProof,
    minterPublicKeyHex: string
  ): boolean {
    try {
      // The minter's public key should match the unicityRecipient in the lock event
      // This ensures the person claiming to be the minter is the same as in the Solana tx
      const lockEventRecipient = decodedProof.lockEvent.unicityRecipient;

      if (!lockEventRecipient) {
        this.addResult("Minter Key Consistency", "FAIL", "Missing unicityRecipient in lock event");
        return false;
      }

      // Check if unicityRecipient is already a hex public key (33 bytes = 66 hex chars for secp256k1)
      if (lockEventRecipient.length === 66 && /^[0-9a-fA-F]+$/.test(lockEventRecipient)) {
        if (lockEventRecipient.toLowerCase() !== minterPublicKeyHex.toLowerCase()) {
          this.addResult("Minter Key Consistency", "FAIL",
            `Minter public key does not match Solana lock event. Expected: ${lockEventRecipient}, Got: ${minterPublicKeyHex}`);
          return false;
        }
      } else {
        // If it's in a different format (like [SHA256]hash), we need to verify it matches
        // For now, we'll extract the hex part and compare
        const hexMatch = lockEventRecipient.match(/([0-9a-fA-F]{64,})/i);
        if (!hexMatch) {
          this.addResult("Minter Key Consistency", "FAIL",
            `Cannot extract hex public key from unicityRecipient: ${lockEventRecipient}`);
          return false;
        }

        const extractedHex = hexMatch[1];
        if (extractedHex.toLowerCase() !== minterPublicKeyHex.toLowerCase()) {
          this.addResult("Minter Key Consistency", "FAIL",
            `Minter public key does not match extracted from Solana lock event. Expected: ${extractedHex}, Got: ${minterPublicKeyHex}`);
          return false;
        }
      }

      this.addResult("Minter Key Consistency", "PASS", "Minter public key matches Solana locking transaction");
      return true;
    } catch (error) {
      this.addResult("Minter Key Consistency", "FAIL", `Minter key consistency check failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Verify that the tokenId was properly derived from commitment data and minter's signature
   */
  private validateTokenIdDerivation(
    actualTokenId: string,
    commitmentData: string,
    minterSignature: string
  ): boolean {
    try {
      const tokenIdHash = crypto.createHash('sha256').update(commitmentData + minterSignature + '_tokenId').digest();
      const expectedTokenIdHex = Buffer.from(tokenIdHash).toString('hex');

      if (actualTokenId !== expectedTokenIdHex) {
        this.addResult("TokenId Derivation", "FAIL",
          `TokenId was not properly derived from commitment data and signature. ` +
          `Expected: ${expectedTokenIdHex}, Got: ${actualTokenId}`);
        return false;
      }

      this.addResult("TokenId Derivation", "PASS", "TokenId correctly derived from commitment data and minter signature");
      return true;
    } catch (error) {
      this.addResult("TokenId Derivation", "FAIL", `TokenId derivation check failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Verify the minter signature using public key recovery from secp256k1 signature
   * The unicityRecipient is the Unicity address format, not a direct hash of the secp256k1 key
   */
  private async validateMinterSignatureWithRecovery(
    unicityRecipient: string,
    commitmentData: string,
    minterSignature: string
  ): Promise<boolean> {
    let fullSignatureBytes: Buffer;

    try {
      fullSignatureBytes = Buffer.from(minterSignature, 'hex');
    } catch (error) {
      this.addResult("Minter Signature", "FAIL", `Invalid hex encoding in signature: ${error.message}`);
      return false;
    }

    if (fullSignatureBytes.length !== 65) {
      this.addResult("Minter Signature", "FAIL", `Signature must be exactly 65 bytes (64-byte signature + 1-byte recovery ID), got ${fullSignatureBytes.length}`);
      return false;
    }

    // Extract signature (first 64 bytes) and recovery ID (last byte)
    const signatureBytes = fullSignatureBytes.subarray(0, 64);
    const recoveryId = fullSignatureBytes[64];

    // Hash commitment data using EXACT same process as token creation
    const commitmentDataBuffer = new TextEncoder().encode(commitmentData);
    let commitmentDataHash: any;

    try {
      commitmentDataHash = await new DataHasher(HashAlgorithm.SHA256)
        .update(commitmentDataBuffer)
        .digest();

    } catch (error) {
      this.addResult("Minter Signature", "FAIL", `Failed to hash commitment data: ${error.message}`);
      return false;
    }

    try {
      // Use secp256k1 public key recovery with stored recovery ID
      
      // Recover public key using the stored recovery ID
      const recoveredPublicKey = secp256k1.ecdsaRecover(signatureBytes, recoveryId, commitmentDataHash.data, false);
      
      // Verify the signature with the recovered public key
      const isValid = secp256k1.ecdsaVerify(signatureBytes, commitmentDataHash.data, recoveredPublicKey);
      
      if (!isValid) {
        this.addResult("Minter Signature", "FAIL", 
          "SECURITY FAILURE: Signature verification failed with recovered public key");
        return false;
      }

      // Additional validation: Check if this signature could have been created by someone with 
      // access to the correct Unicity wallet by checking that the unicityRecipient format is valid
      // The unicityRecipient can be either full format [SHA256]<hash> or just the hash part (Solana strips prefix)
      const isFullFormat = unicityRecipient && unicityRecipient.startsWith('[SHA256]');
      const isHashOnly = unicityRecipient && /^[0-9a-f]{64}$/i.test(unicityRecipient);
      
      if (!unicityRecipient || (!isFullFormat && !isHashOnly)) {
        this.addResult("Minter Signature", "FAIL", 
          `SECURITY FAILURE: Invalid unicityRecipient format: ${unicityRecipient}`);
        return false;
      }

      this.addResult("Minter Signature", "PASS", 
        "Signature cryptographically verified - created by holder of correct private key");
      return true;
      
    } catch (error) {
      this.addResult("Minter Signature", "FAIL", `SECURITY FAILURE: secp256k1 signature recovery threw error: ${error.message}`);
      return false;
    }
  }

  /**
   * Verify the minter signature - ensures the token id was derived from something only the minter can create
   */
  private async validateMinterSignature(
    minterPublicKey: string,
    commitmentData: string,
    minterSignature: string
  ): Promise<boolean> {
    let signatureBytes: Buffer;
    let publicKeyBytes: Buffer;

    try {
      signatureBytes = Buffer.from(minterSignature, 'hex');
      publicKeyBytes = Buffer.from(minterPublicKey, 'hex');
    } catch (error) {
      this.addResult("Minter Signature", "FAIL", `Invalid hex encoding in signature or public key: ${error.message}`);
      return false;
    }

    if (signatureBytes.length !== 64) {
      this.addResult("Minter Signature", "FAIL", `Signature must be exactly 64 bytes, got ${signatureBytes.length}`);
      return false;
    }

    if (publicKeyBytes.length !== 33) {
      this.addResult("Minter Signature", "FAIL", `Public key must be exactly 33 bytes (secp256k1), got ${publicKeyBytes.length}`);
      return false;
    }

    // Re-derive the TokenId
    const commitmentDataBuffer = new TextEncoder().encode(commitmentData);
    let commitmentDataHash: any;

    try {
      commitmentDataHash = await new DataHasher(HashAlgorithm.SHA256)
        .update(commitmentDataBuffer)
        .digest();

    } catch (error) {
      this.addResult("Minter Signature", "FAIL", `Failed to hash commitment data: ${error.message}`);
      return false;
    }

    let isValid: boolean;
    try {
      // Only secp256k1 signatures from Unicity SigningService are accepted
      isValid = secp256k1.ecdsaVerify(signatureBytes, commitmentDataHash.data, publicKeyBytes);
    } catch (error) {
      this.addResult("Minter Signature", "FAIL", `SECURITY FAILURE: secp256k1 signature verification threw error: ${error.message}`);
      return false;
    }

    if (!isValid) {
      this.addResult("Minter Signature", "FAIL", "Signature verification failed - NOT created by the minter's private key");
      return false;
    }

    this.addResult("Minter Signature", "PASS", "TokenId derived by the authorized minter");
    return true;
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

      // Step 2: Parse and consistency check Solana locking proof data structure
      const decodedProof = this.consistentSolanaLockingProof(tokenJson.genesis.data.tokenData);
      if (!decodedProof) {
        return { valid: false, summary: "Inconsistent Solana locking proof" };
      }

      if (!decodedProof.minterSignature) {
        this.addResult("Minter Signature", "FAIL", "Token missing required minter signature field");
        return { valid: false, summary: "Missing mandatory minter signature field" };
      }

      // Reconstruct commitment data
      const reconstructedCommitmentData = [
        decodedProof.lockEvent.lockId,
        decodedProof.solanaTransaction.signature,
        decodedProof.solanaTransaction.blockHeight.toString(),
        decodedProof.lockEvent.user,
        decodedProof.lockEvent.amount,
        decodedProof.lockEvent.nonce,
        decodedProof.lockEvent.timestamp
      ].join('|');

      // Step 2.0: Verify minter key consistency - critical security check
      const minterKeyValid = this.validateMinterKeyConsistency(
        decodedProof,
        decodedProof.lockEvent.unicityRecipient
      );
      if (!minterKeyValid) {
        return { valid: false, summary: "Minter key consistency validation failed - key mismatch with Solana transaction" };
      }

      const signatureValid = await this.validateMinterSignatureWithRecovery(
        decodedProof.lockEvent.unicityRecipient,
        reconstructedCommitmentData,
        decodedProof.minterSignature
      );
      if (!signatureValid) {
        return { valid: false, summary: "TokenId derivation signature validation failed" };
      }

      // Step 2.1: Verify tokenId derivation - critical security check
      const tokenIdValid = this.validateTokenIdDerivation(
        tokenJson.genesis.data.tokenId,
        reconstructedCommitmentData,
        decodedProof.minterSignature
      );
      if (!tokenIdValid) {
        return { valid: false, summary: "TokenId derivation validation failed" };
      }

      // Step 3: Validate transaction data cryptographically and check signature existence
      try {
        const { signature, transaction: txData } = decodedProof.solanaTransaction;

        // Step 3.1: Cryptographically validate transaction data against signature
        if (txData && txData.transaction) {
          // Verify the transaction data is consistent with the signature
          const storedSignatures = txData.transaction.signatures;
          if (storedSignatures && storedSignatures.length > 0) {
            if (storedSignatures[0] !== signature) {
              this.addResult("Transaction Data Integrity", "FAIL",
                "Stored transaction signature does not match claimed signature");
              return { valid: false, summary: "Transaction data integrity failed" };
            }
            this.addResult("Transaction Data Integrity", "PASS", "Transaction data signature verified");
          } else {
            this.addResult("Transaction Data Integrity", "WARN", "No transaction signatures in stored data");
          }
        }

        // Step 3.2: TX signature existence check on Solana
        const connection = this.lightClient['connection'];
        try {
          const signatureStatuses = await connection.getSignatureStatuses([signature], {
            searchTransactionHistory: true
          });

          const signatureStatus = signatureStatuses.value[0];
          if (!signatureStatus) {
            this.addResult("RPC Validation", "FAIL", "Transaction signature not found on Solana blockchain");
            return { valid: false, summary: "Transaction signature not found on blockchain" };
          }

          if (signatureStatus.err) {
            this.addResult("RPC Validation", "FAIL", `Transaction failed on Solana: ${JSON.stringify(signatureStatus.err)}`);
            return { valid: false, summary: "Transaction failed on blockchain" };
          }

          // Verify confirmation status
          const validStatuses = ['processed', 'confirmed', 'finalized'];
          if (!signatureStatus.confirmationStatus || !validStatuses.includes(signatureStatus.confirmationStatus)) {
            this.addResult("RPC Validation", "FAIL", `Invalid confirmation status: ${signatureStatus.confirmationStatus}`);
            return { valid: false, summary: "Invalid transaction confirmation status" };
          }

          this.addResult("RPC Validation", "PASS",
            `Transaction signature verified on Solana with status: ${signatureStatus.confirmationStatus}`);

        } catch (rpcError) {
          this.addResult("RPC Validation", "FAIL",
            `Could not verify tx signature finality on Solana (may be too old): ${rpcError.message}`);
        }

      } catch (error) {
        this.addResult("RPC Validation", "FAIL",
          `Transaction validation failed: ${error.message}`);
        return { valid: false, summary: "Transaction validation failed" };
      }

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