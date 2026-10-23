/// `blindseal submit <attestation.json>` — submit an attestation to Solana MAINNET (the only
/// cluster). Verifies the Groth16 proof on chain and consumes the nullifier. The SDK refuses
/// any RPC whose genesis hash is not mainnet-beta's, so a misconfigured endpoint sends nothing.
///
/// Usage:
///   blindseal submit <attestation.json> [--wallet <keypair.json>] [--rpc <url>] [--no-policy]
///     [--check]   only report whether the nullifier is already consumed
/// Env: BLINDSEAL_RPC_URL (default: the public mainnet endpoint — rate-limited; logged),
///      BLINDSEAL_WALLET  (default ~/.config/solana/id.json)
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Connection, Keypair } from '@solana/web3.js';
import { DEFAULT_RPC_URL, isConsumed, submit, verifyOffchain, WrongClusterError, type Attestation } from '@blindseal/sdk';

const HELP = `blindseal submit — verify an attestation on Solana mainnet and consume its nullifier

Usage:
  blindseal submit <attestation.json> [flags]

Flags
  --wallet <keypair.json>   fee payer / signer (default $BLINDSEAL_WALLET or ~/.config/solana/id.json)
  --rpc <url>               RPC endpoint (default $BLINDSEAL_RPC_URL or the public mainnet endpoint)
  --no-policy               program is not in allowlist mode (omit the PolicyRoot account)
  --check                   only report whether the nullifier is already consumed; send nothing
  --skip-offchain           do not pre-verify with the wasm verifier
  --help, -h                this help

Mainnet is the only cluster: the genesis hash is checked before anything is sent.
`;

interface Opts { file?: string; wallet?: string; rpc?: string; noPolicy?: boolean; check?: boolean; skipOffchain?: boolean; help?: boolean; }

function parse(argv: string[]): Opts {
  const o: Opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--wallet') o.wallet = argv[++i];
    else if (a === '--rpc') o.rpc = argv[++i];
    else if (a === '--no-policy') o.noPolicy = true;
    else if (a === '--check') o.check = true;
    else if (a === '--skip-offchain') o.skipOffchain = true;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else o.file = a;
  }
  return o;
}

export async function runSubmitCli(argv: string[]): Promise<number> {
  let o: Opts;
  try { o = parse(argv); } catch (e) { process.stderr.write(`blindseal submit: ${(e as Error).message}\n${HELP}`); return 2; }
  if (o.help || !o.file) { process.stdout.write(HELP); return o.help ? 0 : 2; }

  const att = JSON.parse(readFileSync(o.file, 'utf8')) as Attestation;
  const rpc = o.rpc ?? process.env.BLINDSEAL_RPC_URL ?? DEFAULT_RPC_URL;
  if (rpc === DEFAULT_RPC_URL) process.stderr.write('blindseal submit: using the public mainnet RPC (rate-limited); set BLINDSEAL_RPC_URL for production\n');
  const conn = new Connection(rpc, 'confirmed');

  if (o.check) {
    const consumed = await isConsumed(att, conn);
    process.stdout.write(`${att.nullifier}: ${consumed ? 'CONSUMED' : 'not consumed'}\n`);
    return 0;
  }

  if (!o.skipOffchain) {
    const off = await verifyOffchain(att);
    if (!off.ok) { process.stderr.write(`blindseal submit: off-chain verify failed (${off.reason}); not sending\n`); return 1; }
    process.stdout.write('off-chain verify: ok\n');
  }

  const walletPath = o.wallet ?? process.env.BLINDSEAL_WALLET ?? path.join(os.homedir(), '.config/solana/id.json');
  const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(walletPath, 'utf8'))));
  try {
    const sig = await submit(att, { wallet, connection: conn, policyRoot: o.noPolicy ? null : undefined });
    process.stdout.write(`submitted: ${sig}\nnullifier ${att.nullifier} consumed on mainnet\n`);
    return 0;
  } catch (e) {
    if (e instanceof WrongClusterError) { process.stderr.write(`blindseal submit: ${e.message}\n`); return 3; }
    const msg = e instanceof Error ? e.message : String(e);
    const logs = (e as any)?.logs as string[] | undefined;
    process.stderr.write(`blindseal submit: ${msg}\n${logs ? logs.join('\n') + '\n' : ''}`);
    return 1;
  }
}
