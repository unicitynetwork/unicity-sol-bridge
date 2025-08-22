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
import { DataHash as SdkDataHash } from '@unicitylabs/state-transition-sdk/node_modules/@unicitylabs/commons/lib/hash/DataHash.js';
import { DataHasher } from '@unicitylabs/state-transition-sdk/node_modules/@unicitylabs/commons/lib/hash/DataHasher.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/node_modules/@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { SigningService } from '@unicitylabs/state-transition-sdk/node_modules/@unicitylabs/commons/lib/signing/SigningService.js';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UnicityGenesisProof } from './proof-validator';

/**
 * Load Unicity wallet from saved file
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
 * Derive public key hash from a private key to match unicityRecipient format
 */
async function derivePublicKeyHash(secret: Uint8Array, nonce: Uint8Array): Promise<string> {
  const signingService = await SigningService.createFromSecret(secret, nonce);
  // Hash the public key to get the recipient format (32 bytes)
  const publicKeyHash = crypto.createHash('sha256').update(signingService.publicKey).digest('hex');
  return publicKeyHash;
}

async function validateMinterAuthorization(
  unicityRecipient: string,
  wallet: { secret: Uint8Array; nonce: Uint8Array; publicKey: string }
): Promise<boolean> {
  return unicityRecipient === wallet.publicKey;
}

/**
 * Simple SDK integration using saved Unicity wallet
 */
export async function mintBridgedTokenWithSDK(
  proof: UnicityGenesisProof,
  minterPublicKey: string,
  outputDir: string,
  bridgeProgramId: string
): Promise<{
  commitment: string;
  tokenFile: string;
  ownerFile: string;
  genesisFile?: string;
}> {
  console.log("Minting bridged token using Unicity SDK with saved wallet...");

  try {
    // Load saved Unicity wallet
    const wallet = loadUnicityWallet();
    if (!wallet) {
      throw new Error('Unicity wallet not found - generate one first');
    }

    // Validate that the user has authorization to mint for this unicityRecipient
    const isAuthorized = await validateMinterAuthorization(minterPublicKey, wallet);
    if (!isAuthorized) {
      const recipientHash = minterPublicKey;
      throw new Error(
        `AUTHORIZATION FAILED: No wallet for recipient ${recipientHash}.\n` +
        `Local Unicity Wallet address: ${wallet.publicKey}\n`
      );
    }

    console.log(`Local Unicity wallet matches expected minter ${minterPublicKey}`);

    // Initialize SDK clients
    const aggregatorClient = new AggregatorClient('https://goggregator-test.unicity.network:443');
    const client = new StateTransitionClient(aggregatorClient);

    // Create deterministic but unique values from the complete lock event data
    const secret = wallet.secret; // Use saved secret key

    // Create deterministic commitment from unique lock event data
    const commitmentData = [
      proof.lockEvent.lockId,           // Unique lock ID from Solana
      proof.solanaTransaction.signature, // Unique transaction signature
      proof.solanaTransaction.blockHeight.toString(), // Block height
      proof.lockEvent.user,            // User who locked
      proof.lockEvent.amount,          // Amount locked
      proof.lockEvent.nonce,           // Bridge nonce (incremental)
      proof.lockEvent.timestamp        // Timestamp
    ].join('|');

    // Use commitment data to create deterministic but unique token ID
    const tokenIdHash = crypto.createHash('sha256').update(commitmentData + '_tokenId').digest();
    const tokenId = TokenId.create(new Uint8Array(tokenIdHash));

    // Create deterministic token type for bridged SOL including bridge program ID
    // Use provided bridge program ID or fallback to default for backward compatibility
    const programId = bridgeProgramId;
    const tokenTypeHash = crypto.createHash('sha256').update('BRIDGED_SOL_FROM_SOLANA' + programId).digest();
    const tokenType = TokenType.create(new Uint8Array(tokenTypeHash));

    // Create minimal token data with only essential data for cryptographic verification
    const tokenData = new TextEncoder().encode(JSON.stringify({
      bridgeType: "SOLANA_BRIDGE",
      lockEvent: proof.lockEvent,
      solanaTransaction: {
        signature: proof.solanaTransaction.signature,
        transaction: proof.solanaTransaction.transaction,
        blockHeight: proof.solanaTransaction.blockHeight,
        slot: proof.solanaTransaction.slot,
        blockTime: proof.solanaTransaction.blockTime,
        confirmationStatus: proof.solanaTransaction.confirmationStatus
      }
    }));

    const coinData = TokenCoinData.create([[new CoinId((new TextEncoder).encode('BRIDGED_SOL')), BigInt(proof.lockEvent.amount)]]);

    // Create deterministic salt from lock event data to ensure uniqueness
    const saltHash = crypto.createHash('sha256').update(commitmentData + '_salt').digest();
    const salt = new Uint8Array(saltHash);

    const stateData = tokenData;  // must be duplicated data to make deserializer happy

    console.log(`Token ID: ${tokenId.toString()}`);
    console.log(`Token Type: ${tokenType.toString()}`);

    const nonce = wallet.nonce; // Use saved nonce
    const walletSigningService = await SigningService.createFromSecret(secret, nonce);
    const predicate = await MaskedPredicate.create(tokenId, tokenType, walletSigningService as any, HashAlgorithm.SHA256, nonce);
    const recipient = await DirectAddress.create(predicate.reference);

    console.log(`Creating mint transaction...`);

    const tokenDataHash = await new DataHasher(HashAlgorithm.SHA256).update(tokenData).digest();

    // Create mint transaction data
    const mintTransactionData = await MintTransactionData.create(
      tokenId,
      tokenType,
      tokenData,
      coinData,
      recipient.toString(),
      salt,
      new SdkDataHash(tokenDataHash.algorithm, tokenDataHash.data),
      null,   // optional 'reason'
    );

    // RequestId is the unique thing veified by the aggregation service, where
    // RequestId = H(signingservice.publickey, H(tokenId.bytes, MINT_SUFFIX))
    // and public

    const commitment = await client.submitMintTransaction(mintTransactionData);

    console.log(`Mint transaction submitted, commitment: ${commitment.toString()}`);

    // Wait for inclusion proof
    const inclusionProof = await waitInclusionProof(client, commitment);
    console.log('Inclusion proof received, mint is unique');

    // Create transaction
    const mintTransaction = await client.createTransaction(commitment, inclusionProof);

    // Create token
    const token = new Token(await TokenState.create(predicate, stateData), mintTransaction, []);

    // Save files
    const lockIdHex = proof.lockEvent.lockId.substring(0, 8);

    const ownerFile = `${outputDir}/token-owner-${lockIdHex}.json`;
    const ownerData = {
      walletPublicKey: wallet.publicKey,
      address: recipient.toString(),
      minterPublicKey,
      tokenId: tokenId.toString(),
      commitment: commitment.toString(),
      createdAt: new Date().toISOString(),
      note: 'Minted using saved Unicity wallet keypair'
    };
    fs.writeFileSync(ownerFile, JSON.stringify(ownerData, null, 2));

    const tokenFile = `${outputDir}/unicity-token-${lockIdHex}.json`;
    fs.writeFileSync(tokenFile, JSON.stringify(token, null, 2));

    // Save human-readable genesis record with Solana proof data
    const genesisFile = `${outputDir}/genesis-record-${lockIdHex}.json`;
    console.log(`Creating genesis record file: ${genesisFile}`);
    // const genesisRecord = {
    //   description: "Bridged SOL Genesis Record",
    //   version: "1.0.0",
    //   bridgeInfo: {
    //     type: "SOLANA_TO_UNICITY",
    //     bridgeContract: programId,
    //     createdAt: new Date().toISOString()
    //   },
    //   solanaLockEvent: {
    //     lockId: proof.lockEvent.lockId,
    //     user: proof.lockEvent.user,
    //     amount: {
    //       lamports: proof.lockEvent.amount,
    //       sol: (parseInt(proof.lockEvent.amount) / 1000000000).toFixed(9)
    //     },
    //     unicityRecipient: proof.lockEvent.unicityRecipient,
    //     nonce: proof.lockEvent.nonce,
    //     timestamp: new Date(parseInt(proof.lockEvent.timestamp) * 1000).toISOString()
    //   },
    //   solanaAnchor: {
    //     blockHeight: solanaAnchor.blockHeight,
    //     slot: solanaAnchor.slot,
    //     transactionSignature: solanaAnchor.transactionSignature,
    //     explorerUrl: `https://explorer.solana.com/tx/${solanaAnchor.transactionSignature}?cluster=testnet`
    //   },
    //   unicityToken: {
    //     tokenId: tokenId.toString(),
    //     tokenType: tokenType.toString(),
    //     commitment: commitment.toString(),
    //     minter: wallet.publicKey,
    //     recipient: recipient.toString()
    //   }
    // };

    // just enough to make the otherwise opaque data human readable
    const genesisRecord = {
      proof: proof,
      ownerData: ownerData
    };

    fs.writeFileSync(genesisFile, JSON.stringify(genesisRecord, null, 2));

    console.log("Bridged token created successfully using SDK!");
    console.log(`Token saved to: ${tokenFile}`);
    console.log(`Owner info saved to: ${ownerFile}`);
    console.log(`Genesis record saved to: ${genesisFile}`);

    return {
      commitment: commitment.toString(),
      tokenFile,
      ownerFile,
      genesisFile
    };

  } catch (error) {
    console.error("SDK minting failed:", error);
    throw error;
  }
}