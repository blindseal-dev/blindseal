// One-time mainnet initialisation of blindseal-verify, run by scripts/mainnet-deploy.sh after the
// programs are deployed. Idempotent: skips any step whose account already exists.
//   initialize(allowed_vkeys = [current guest vkey], allowlist_policies = false)
//   register_policy_root(default policy root)
// The authority is the deploy/upgrade-authority keypair (~/.blindseal/mainnet-authority.json),
// never ~/.config/solana/id.json. Mainnet only: the genesis hash is checked first.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComputeBudgetProgram, Connection, Keypair, Transaction } from '@solana/web3.js';
import {
  MAINNET_GENESIS_HASH, DEFAULT_RPC_URL, PROGRAM_ID, configPda, policyRootPda, decodeConfig,
  buildInitializeIx, buildRegisterPolicyRootIx, hex,
} from 'blindseal-sdk';

const RPC = process.env.BLINDSEAL_RPC_URL ?? DEFAULT_RPC_URL;
const AUTH = process.env.BLINDSEAL_MAINNET_AUTHORITY ?? path.join(os.homedir(), '.blindseal', 'mainnet-authority.json');
const ATT = process.env.BLINDSEAL_VKEY_SOURCE ?? path.join(process.cwd(), 'fixtures', 'attestation-sample.json');

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  const genesis = await conn.getGenesisHash();
  if (genesis !== MAINNET_GENESIS_HASH) throw new Error(`RPC ${RPC} is not mainnet-beta (genesis ${genesis})`);
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(AUTH, 'utf8'))));
  const att = JSON.parse(readFileSync(ATT, 'utf8')) as { detectorVersion: string; policyRoot: string };
  const vkey = hex(att.detectorVersion);
  const root = hex(att.policyRoot);
  console.log(`authority ${authority.publicKey.toBase58()}  program ${PROGRAM_ID.toBase58()}`);
  console.log(`vkey ${att.detectorVersion}\npolicyRoot ${att.policyRoot}`);

  const send = async (label: string, ix: ReturnType<typeof buildInitializeIx>) => {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ix);
    tx.feePayer = authority.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(authority);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, 'confirmed');
    console.log(`${label}: ${sig}`);
    return sig;
  };

  const cfgInfo = await conn.getAccountInfo(configPda(), 'confirmed');
  if (!cfgInfo) await send('initialize', buildInitializeIx(authority.publicKey, [vkey], false));
  else console.log('initialize: Config already exists — skipped');

  const prInfo = await conn.getAccountInfo(policyRootPda(root), 'confirmed');
  if (!prInfo) await send('register_policy_root', buildRegisterPolicyRootIx(authority.publicKey, root));
  else console.log('register_policy_root: already registered — skipped');

  const cfg = decodeConfig((await conn.getAccountInfo(configPda(), 'confirmed'))!.data);
  console.log('Config:', JSON.stringify(cfg));
  if (cfg.authority !== authority.publicKey.toBase58()) throw new Error('Config authority is not the mainnet authority keypair');
  if (cfg.paused) throw new Error('Config is paused');
  if (!cfg.allowedVkeys.includes(att.detectorVersion)) throw new Error('current vkey is not allowed');
}

main().catch((e) => { console.error('mainnet-init failed:', e instanceof Error ? e.message : e); process.exit(1); });
