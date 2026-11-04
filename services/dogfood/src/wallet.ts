/// The dogfood wallet. Only its public key leaves this module; the secret is read by the processes that
/// sign (the MCP server for the x402 payment, `blindseal submit` for the gated transfer) and never printed.
import { existsSync, readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';

export class WalletMissingError extends Error {
  constructor(public readonly file: string) {
    super(`wallet keypair not found at ${file}. Live mode needs the funded dogfood wallet there; it is never created by this service. Run with --dry-run until it exists.`);
    this.name = 'WalletMissingError';
  }
}

/// Parse a Solana CLI keypair file (JSON array of 64 bytes).
export function keypairFromFile(file: string): Keypair {
  if (!existsSync(file)) throw new WalletMissingError(file);
  let bytes: unknown;
  try { bytes = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`wallet file ${file} is not JSON`); }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) {
    throw new Error(`wallet file ${file} is not a 64-byte keypair array`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}

export function walletPublicKey(file: string): string {
  return keypairFromFile(file).publicKey.toBase58();
}
