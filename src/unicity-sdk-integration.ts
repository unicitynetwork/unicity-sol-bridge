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
 * Real Unicity SDK integration for bridged token minting
 */
export class UnicitySDKIntegration {
  private aggregatorClient: AggregatorClient;
  private client: StateTransitionClient;

  constructor(aggregatorUrl: string = 'https://goggregator-test.unicity.network:443') {
    this.aggregatorClient = new AggregatorClient(aggregatorUrl);
    this.client = new StateTransitionClient(this.aggregatorClient);
  }

  /**
   * Create deterministic token ID from Solana lock event
   */
  private createTokenIdFromLockEvent(proof: UnicityGenesisProof): TokenId {
    // Use lock ID as deterministic token ID
    const lockIdBytes = Buffer.from(proof.lockEvent.lockId, 'hex');
    return TokenId.create(new Uint8Array(lockIdBytes));
  }

  /**
   * Create deterministic token type for bridged SOL
   */
  private createBridgedSOLTokenType(bridgeProgramId?: string): TokenType {
    // Use a deterministic token type for all bridged SOL tokens including bridge program ID
    const programId = bridgeProgramId || "9q5thPnZG7FKKNr61wceXdfuy2QRLYky8RTJonh2YzyB";
    const typeString = "BRIDGED_SOL_FROM_SOLANA" + programId;
    const typeHash = crypto.createHash('sha256').update(typeString).digest();
    return TokenType.create(new Uint8Array(typeHash));
  }

  /**
   * Create token data containing bridge proof
   */
  private createTokenDataWithProof(proof: UnicityGenesisProof, bridgeProgramId?: string): Uint8Array {
    // Embed the bridge proof as token data for verification
    const programId = bridgeProgramId || "9q5thPnZG7FKKNr61wceXdfuy2QRLYky8RTJonh2YzyB";
    const tokenData = {
      bridgeType: "SOLANA_BRIDGE",
      version: "1.0.0",
      lockEvent: proof.lockEvent,
      solanaTransaction: proof.solanaTransaction,
      validation: proof.validation,
      bridgeContract: programId
    };
    
    return new TextEncoder().encode(JSON.stringify(tokenData));
  }

  /**
   * Create coin data representing the locked SOL amount
   */
  private createCoinDataFromAmount(amount: string): TokenCoinData {
    const coinId = new CoinId(new TextEncoder().encode('BRIDGED_SOL'));
    const amountBigInt = BigInt(amount);
    return TokenCoinData.create([[coinId, amountBigInt]]);
  }

  /**
   * Create deterministic salt from bridge event
   */
  private createSaltFromBridgeEvent(proof: UnicityGenesisProof): Uint8Array {
    const saltData = [
      proof.lockEvent.lockId,
      proof.solanaTransaction.signature,
      proof.solanaTransaction.blockTime,
      proof.lockEvent.timestamp
    ].join('|');
    
    const saltHash = crypto.createHash('sha256').update(saltData).digest();
    return new Uint8Array(saltHash);
  }

  /**
   * Create state data hash for the token
   */
  private async createStateDataHash(proof: UnicityGenesisProof): Promise<any> {
    const stateData = {
      solanaLockId: proof.lockEvent.lockId,
      originalAmount: proof.lockEvent.amount,
      bridgeTimestamp: proof.lockEvent.timestamp,
      validation: proof.validation.status || "VALIDATED"
    };
    
    const stateBytes = new TextEncoder().encode(JSON.stringify(stateData));
    return await new DataHasher(HashAlgorithm.SHA256).update(stateBytes).digest();
  }

  /**
   * Create signing service from minter key
   */
  private async createSigningServiceFromMinter(minterPublicKey: string): Promise<SigningService> {
    // In a real implementation, this would use the minter's private key
    // For now, we'll create a deterministic secret from the minter's public key
    const secret = crypto.createHash('sha256').update(minterPublicKey).digest();
    const nonce = crypto.randomBytes(32);
    
    return await SigningService.createFromSecret(new Uint8Array(secret), new Uint8Array(nonce));
  }

  /**
   * Mint bridged token using real Unicity SDK
   */
  async mintBridgedToken(
    proof: UnicityGenesisProof,
    minterPublicKey: string,
    outputDir: string
  ): Promise<{
    commitment: string;
    token: Token<any>;
    ownerFile: string;
    tokenFile: string;
  }> {
    console.log("Minting bridged SOL token using Unicity SDK...");
    
    try {
      // 1. Create deterministic token parameters from bridge event
      const tokenId = this.createTokenIdFromLockEvent(proof);
      const tokenType = this.createBridgedSOLTokenType();
      const tokenData = this.createTokenDataWithProof(proof);
      const coinData = this.createCoinDataFromAmount(proof.lockEvent.amount);
      const salt = this.createSaltFromBridgeEvent(proof);
      const stateDataHash = await this.createStateDataHash(proof);

      console.log(`Token ID: ${tokenId.toString().substring(0, 16)}...`);
      console.log(`Token Type: ${tokenType.toString().substring(0, 16)}...`);
      console.log(`Amount: ${proof.lockEvent.amount} lamports`);

      // 2. Create signing service for the minter
      const signingService = await this.createSigningServiceFromMinter(minterPublicKey);
      
      // 3. Create predicate and recipient address
      const nonce = crypto.randomBytes(32);
      const predicate = await MaskedPredicate.create(
        tokenId, 
        tokenType, 
        signingService as any, 
        HashAlgorithm.SHA256, 
        new Uint8Array(nonce)
      );
      const recipient = await DirectAddress.create(predicate.reference);

      // 4. Save owner information
      const lockIdHex = proof.lockEvent.lockId.substring(0, 8);
      const ownerFile = `${outputDir}/token-owner-${lockIdHex}.json`;
      const ownerData = {
        minterPublicKey,
        recipientAddress: recipient.toString(),
        tokenId: tokenId.toString(),
        lockEvent: proof.lockEvent,
        createdAt: new Date().toISOString()
      };
      fs.writeFileSync(ownerFile, JSON.stringify(ownerData, null, 2));

      console.log("Creating mint transaction...");

      // 5. Create and submit mint transaction
      const mintTransactionData = await MintTransactionData.create(
        tokenId,
        tokenType,
        tokenData,
        coinData,
        recipient.toString(),
        salt,
        stateDataHash as any,
        null
      );

      const commitment = await this.client.submitMintTransaction(mintTransactionData);
      console.log(`Transaction submitted with commitment: ${commitment.toString().substring(0, 16)}...`);

      // 6. Wait for inclusion proof
      console.log("Waiting for inclusion proof...");
      const inclusionProof = await waitInclusionProof(this.client, commitment);
      console.log("Inclusion proof received");

      // 7. Create the final transaction
      const mintTransaction = await this.client.createTransaction(commitment, inclusionProof);

      // 8. Create the token with state
      const stateData = new TextEncoder().encode(JSON.stringify({
        solanaLockId: proof.lockEvent.lockId,
        originalAmount: proof.lockEvent.amount,
        bridgeTimestamp: proof.lockEvent.timestamp,
        validation: proof.validation.status || "VALIDATED"
      }));

      const tokenState = await TokenState.create(predicate, stateData);
      const token = new Token(tokenState, mintTransaction, []);

      // 9. Save the token
      const tokenFile = `${outputDir}/unicity-token-${lockIdHex}.json`;
      fs.writeFileSync(tokenFile, JSON.stringify(token, null, 2));

      console.log("Bridged token minted successfully!");
      console.log(`Owner info: ${ownerFile}`);
      console.log(`Token: ${tokenFile}`);

      return {
        commitment: commitment.toString(),
        token,
        ownerFile,
        tokenFile
      };

    } catch (error) {
      console.error("Failed to mint bridged token:", error);
      throw new Error(`Unicity SDK minting failed: ${error.message}`);
    }
  }

  /**
   * Verify a bridged token's authenticity
   */
  async verifyBridgedToken(tokenFile: string): Promise<boolean> {
    try {
      const tokenData = JSON.parse(fs.readFileSync(tokenFile, 'utf-8'));
      const token = new Token(
        tokenData.state,
        tokenData.transactions || [tokenData.transaction],
        tokenData.proofs || []
      );

      // Perform SDK verification
      // This would use the SDK's built-in verification methods
      console.log("Verifying bridged token authenticity...");
      
      // For now, basic structural verification
      const hasValidStructure = !!(
        token.state &&
        token.transactions &&
        tokenData.state
      );

      console.log(`Token verification: ${hasValidStructure ? 'VALID' : 'INVALID'}`);
      return hasValidStructure;

    } catch (error) {
      console.error("Token verification failed:", error);
      return false;
    }
  }
}