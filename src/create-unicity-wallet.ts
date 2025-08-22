#!/usr/bin/env ts-node

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SigningService } from '@unicitylabs/commons/lib/signing/SigningService.js';
import { HashAlgorithm } from '@unicitylabs/commons/lib/hash/HashAlgorithm.js';
import { MaskedPredicate, TokenId, TokenType } from '@unicitylabs/state-transition-sdk';

/**
 * Create a new Unicity wallet keypair and save it locally
 */
class UnicityWalletGenerator {
  private walletDir: string;

  constructor() {
    this.walletDir = path.join(os.homedir(), '.config', 'unicity');
    this.ensureWalletDir();
  }

  private ensureWalletDir(): void {
    if (!fs.existsSync(this.walletDir)) {
      fs.mkdirSync(this.walletDir, { recursive: true });
      console.log(`Created Unicity wallet directory: ${this.walletDir}`);
    }
  }

  /**
   * Generate a new Unicity wallet keypair
   */
  async generateWallet(): Promise<{
    secretKey: Uint8Array;
    publicKey: string;
    address: string;
    filePath: string;
  }> {
    // Generate cryptographically secure random secret key
    const secret = crypto.getRandomValues(new Uint8Array(128));
    const nonce = crypto.getRandomValues(new Uint8Array(32));

    console.log('Generating Unicity wallet keys...');

    // Create signing service from secret
    const signingService = await SigningService.createFromSecret(secret, nonce);

    // Create a temporary token ID and type for address derivation
    const tempTokenId = TokenId.create(crypto.getRandomValues(new Uint8Array(32)));
    const tempTokenType = TokenType.create(crypto.getRandomValues(new Uint8Array(32)));

    // Create predicate for address generation
    const predicate = await MaskedPredicate.create(
      tempTokenId,
      tempTokenType,
      signingService as any,
      HashAlgorithm.SHA256,
      nonce
    );

    // Get the public key and address
    const publicKey = predicate.reference.toString();
    const address = publicKey; // In Unicity, the public key IS the address

    console.log('Wallet generated successfully!');
    console.log(`Public Key: ${publicKey}`);
    console.log(`Address: ${address}`);

    // Save wallet to file
    const walletData = {
      version: '1.0.0',
      secretKey: Array.from(secret),
      nonce: Array.from(nonce),
      publicKey: publicKey,
      address: address,
      createdAt: new Date().toISOString(),
      description: 'Unicity wallet for Solana bridge minting'
    };

    const walletFile = path.join(this.walletDir, 'bridge-minter.json');
    fs.writeFileSync(walletFile, JSON.stringify(walletData, null, 2));

    console.log(`Wallet saved to: ${walletFile}`);

    return {
      secretKey: secret,
      publicKey: publicKey,
      address: address,
      filePath: walletFile
    };
  }

  /**
   * Load existing wallet from file
   */
  loadWallet(): {
    secretKey: Uint8Array;
    nonce: Uint8Array;
    publicKey: string;
    address: string;
    filePath: string;
  } | null {
    const walletFile = path.join(this.walletDir, 'bridge-minter.json');

    if (!fs.existsSync(walletFile)) {
      return null;
    }

    try {
      const walletData = JSON.parse(fs.readFileSync(walletFile, 'utf8'));

      return {
        secretKey: new Uint8Array(walletData.secretKey),
        nonce: new Uint8Array(walletData.nonce),
        publicKey: walletData.publicKey,
        address: walletData.address,
        filePath: walletFile
      };
    } catch (error) {
      console.error(`Failed to load wallet: ${error.message}`);
      return null;
    }
  }

  /**
   * Display wallet information
   */
  displayWallet(): void {
    const wallet = this.loadWallet();

    if (!wallet) {
      console.log('No Unicity wallet found. Run with --generate to create one.');
      return;
    }

    console.log('UNICITY WALLET INFO');
    console.log('='.repeat(40));
    console.log(`Public Key: ${wallet.publicKey}`);
    console.log(`Address: ${wallet.address}`);
    console.log(`Wallet File: ${wallet.filePath}`);
  }
}

// Main execution
async function main() {
  const generator = new UnicityWalletGenerator();

  const args = process.argv.slice(2);
  const generateFlag = args.includes('--generate') || args.includes('-g');
  const showFlag = args.includes('--show') || args.includes('-s');

  if (generateFlag) {
    // Generate new wallet
    try {
      const wallet = await generator.generateWallet();
      console.log('Keep the wallet file secure - it contains your private key');

    } catch (error) {
      console.error('Failed to generate wallet:', error.message);
      process.exit(1);
    }

  } else if (showFlag) {
    // Show existing wallet
    generator.displayWallet();

  } else {
    // Check if wallet exists and show it, or prompt to generate
    const existingWallet = generator.loadWallet();

    if (existingWallet) {
      console.log('EXISTING UNICITY WALLET');
      console.log('='.repeat(40));
      console.log(`Public Key: ${existingWallet.publicKey}`);
      console.log(`Address: ${existingWallet.address}`);
      console.log('');
      console.log('Options:');
      console.log('  --generate (-g)  Generate new wallet (overwrites existing)');
      console.log('  --show (-s)      Show wallet details');

    } else {
      console.log('No Unicity wallet found.');
      console.log('');
      console.log('To create a new wallet:');
      console.log('  npm run create-wallet --generate');
      console.log('');
      console.log('Or use ts-node directly:');
      console.log('  npx ts-node src/create-unicity-wallet.ts --generate');
    }
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}

export { UnicityWalletGenerator };