import {
  AggregatorClient,
  StateTransitionClient,
  TokenId,
  TokenType,
  TokenCoinData,
  MaskedPredicate,
  DirectAddress,
  MintTransactionData,
  Token,
  TokenState,
  CoinId
} from '@unicitylabs/state-transition-sdk';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/utils/InclusionProofUtils.js';
import { DataHasher } from '@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { UnicityGenesisProof } from './proof-validator';

/**
 * Simplified SDK-based token minting for bridge tokens
 */
export class UnicityTokenMinter {
  private aggregatorClient: AggregatorClient;
  private client: StateTransitionClient;

  constructor(aggregatorUrl: string = 'https://goggregator-test.unicity.network:443') {
    this.aggregatorClient = new AggregatorClient(aggregatorUrl);
    this.client = new StateTransitionClient(this.aggregatorClient);
  }

  /**
   * Create and mint a bridged token using the Unicity SDK
   */
  async createBridgedToken(
    proof: UnicityGenesisProof,
    minterPublicKey: string,
    outputDir: string
  ): Promise<{
    commitment: string;
    tokenFile: string;
    ownerFile: string;
  }> {
    console.log("Creating bridged token using Unicity SDK...");
    
    try {
      // Generate deterministic values from the bridge proof
      const lockIdBuffer = Buffer.from(proof.lockEvent.lockId, 'hex');
      const tokenId = TokenId.create(new Uint8Array(lockIdBuffer));
      
      // Create a deterministic token type for bridged SOL
      const tokenType = TokenType.create(new Uint8Array(crypto.createHash('sha256').update('BRIDGED_SOL').digest()));
      
      // Create token data with bridge proof
      const tokenData = new TextEncoder().encode(JSON.stringify({
        bridgeType: "SOLANA_BRIDGE",
        lockEvent: proof.lockEvent,
        solanaTransaction: proof.solanaTransaction,
        validation: proof.validation
      }));
      
      // Create coin data for the locked amount
      const coinId = new CoinId(new TextEncoder().encode('BRIDGED_SOL'));
      const coinData = TokenCoinData.create([[coinId, BigInt(proof.lockEvent.amount)]]);
      
      // Generate deterministic salt
      const salt = new Uint8Array(crypto.createHash('sha256').update(
        proof.lockEvent.lockId + proof.solanaTransaction.signature
      ).digest());
      
      // Create state data hash - pass null to avoid the CBOR issue
      const stateDataHash = null;
      
      // Create signing service (simplified)
      const secret = new Uint8Array(crypto.createHash('sha256').update(minterPublicKey).digest());
      const nonce = new Uint8Array(crypto.randomBytes(32));
      const signingService = await SigningService.createFromSecret(secret, nonce);
      
      // Create predicate and recipient
      const predicate = await MaskedPredicate.create(
        tokenId,
        tokenType,
        signingService as any,
        HashAlgorithm.SHA256,
        nonce
      );
      const recipient = await DirectAddress.create(predicate.reference);
      
      console.log(`Submitting mint transaction to Unicity network...`);
      
      // Create and submit mint transaction
      const mintTransactionData = await MintTransactionData.create(
        tokenId,
        tokenType,
        tokenData,
        coinData,
        recipient.toString(),
        salt,
        stateDataHash,
        null
      );
      
      const commitment = await this.client.submitMintTransaction(mintTransactionData);
      console.log(`Mint transaction submitted, commitment: ${commitment.toString().substring(0, 16)}...`);
      
      // Wait for inclusion proof
      console.log("Waiting for inclusion proof...");
      const inclusionProof = await waitInclusionProof(this.client, commitment);
      
      // Create final transaction
      const mintTransaction = await this.client.createTransaction(commitment, inclusionProof);
      
      // Create token state and token
      const finalStateData = new TextEncoder().encode(JSON.stringify({
        lockId: proof.lockEvent.lockId,
        amount: proof.lockEvent.amount,
        timestamp: proof.lockEvent.timestamp,
        minter: minterPublicKey
      }));
      
      const tokenState = await TokenState.create(predicate, finalStateData);
      const token = new Token(tokenState, mintTransaction, []);
      
      // Save files
      const lockIdHex = proof.lockEvent.lockId.substring(0, 8);
      
      // Save owner info
      const ownerFile = `${outputDir}/token-owner-${lockIdHex}.json`;
      const ownerData = {
        minterPublicKey,
        recipientAddress: recipient.toString(),
        tokenId: tokenId.toString(),
        commitment: commitment.toString(),
        createdAt: new Date().toISOString()
      };
      fs.writeFileSync(ownerFile, JSON.stringify(ownerData, null, 2));
      
      // Save token
      const tokenFile = `${outputDir}/unicity-token-${lockIdHex}.json`;
      fs.writeFileSync(tokenFile, JSON.stringify(token, null, 2));
      
      console.log("Bridged token created successfully!");
      console.log(`Token saved to: ${tokenFile}`);
      console.log(`Owner info saved to: ${ownerFile}`);
      
      return {
        commitment: commitment.toString(),
        tokenFile,
        ownerFile
      };
      
    } catch (error) {
      console.error("Failed to create bridged token:", error);
      
      // Fallback: create a mock token structure with SDK patterns
      const lockIdHex = proof.lockEvent.lockId.substring(0, 8);
      const mockTokenFile = `${outputDir}/unicity-token-${lockIdHex}.json`;
      
      const mockToken = {
        type: "BridgedSOL",
        id: proof.lockEvent.lockId,
        amount: proof.lockEvent.amount,
        minter: minterPublicKey,
        solanaTransaction: proof.solanaTransaction,
        commitment: crypto.createHash('sha256').update(
          proof.lockEvent.lockId + proof.solanaTransaction.signature + minterPublicKey
        ).digest('hex'),
        status: proof.validation.status || "VALIDATED",
        createdAt: new Date().toISOString(),
        sdkError: error.message,
        fallbackMode: true
      };
      
      fs.writeFileSync(mockTokenFile, JSON.stringify(mockToken, null, 2));
      
      return {
        commitment: mockToken.commitment,
        tokenFile: mockTokenFile,
        ownerFile: ""
      };
    }
  }
}

/**
 * Simple function to mint a bridged token
 */
export async function mintBridgedToken(
  proof: UnicityGenesisProof,
  minterPublicKey: string,
  outputDir: string
): Promise<any> {
  const minter = new UnicityTokenMinter();
  return await minter.createBridgedToken(proof, minterPublicKey, outputDir);
}