// Config steps of the 0.7.0 mainnet upgrade, driven by scripts/mainnet-0.7.0.sh (one step per run).
//   --step b    register_policy_root(DEFAULT_POLICY_ROOT)                     (skipped if registered)
//   --step a    set_config(allowlist_policies = true)                          (refused unless b is done)
//   --step c1   set_config(allowed_vkeys = on-chain list + CURRENT_VKEY)       (keeps the old vkey)
//   --step c2   set_config(allowed_vkeys = on-chain list − LEGACY_VKEYS)       (needs --new-sample <attestation.json>:
//               an attestation under CURRENT_VKEY whose nullifier is already consumed on mainnet)
//   --step d    set_authority(<ledger pubkey>)                                  (needs --ledger-pubkey; the Ledger co-signs)
//   --dry-run   build and print the transaction (program, accounts, data, unsigned message) — nothing is signed or sent
// Mainnet only (genesis hash checked). Signer: the config authority keypair at $BLINDSEAL_MAINNET_AUTHORITY
// (default ~/.blindseal/mainnet-authority.json). Prints the signature and the Config after each step.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import {
  MAINNET_GENESIS_HASH, DEFAULT_RPC_URL, PROGRAM_ID, MAX_VKEYS, configPda, policyRootPda, decodeConfig, hex, isConsumed,
  buildSetConfigIx, buildRegisterPolicyRootIx, buildSetAuthorityIx, CURRENT_VKEY, LEGACY_VKEYS, DEFAULT_POLICY_ROOT,
  type Attestation,
} from 'blindseal-sdk';

const argv = process.argv.slice(2);
const flag = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const STEP = flag('--step');
const DRY = argv.includes('--dry-run');
const RPC = process.env.BLINDSEAL_RPC_URL ?? DEFAULT_RPC_URL;
const AUTH = process.env.BLINDSEAL_MAINNET_AUTHORITY ?? path.join(os.homedir(), '.blindseal', 'mainnet-authority.json');
const LEDGER_PATH = "44'/501'/0'"; // = usb://ledger?key=0

function loadAuthority(): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(AUTH, 'utf8'))));
}

function describe(ix: TransactionInstruction) {
  console.log(`  program   ${ix.programId.toBase58()}`);
  ix.keys.forEach((k, i) => console.log(`  account ${i} ${k.pubkey.toBase58()}${k.isSigner ? ' signer' : ''}${k.isWritable ? ' writable' : ''}`));
  console.log(`  data      ${ix.data.toString('hex')}`);
}

async function main() {
  if (!STEP || !['a', 'b', 'c1', 'c2', 'd'].includes(STEP)) throw new Error('usage: --step a|b|c1|c2|d [--dry-run] [--new-sample <file>] [--ledger-pubkey <pk>]');
  const conn = new Connection(RPC, 'confirmed');
  const genesis = await conn.getGenesisHash();
  if (genesis !== MAINNET_GENESIS_HASH) throw new Error(`RPC ${RPC} is not mainnet-beta (genesis ${genesis})`);
  const authority = loadAuthority();
  const cfgInfo = await conn.getAccountInfo(configPda(), 'confirmed');
  if (!cfgInfo) throw new Error('Config does not exist on mainnet (deploy first: scripts/mainnet-deploy.sh)');
  const cfg = decodeConfig(cfgInfo.data);
  console.log(`Config before: ${JSON.stringify(cfg)}`);
  if (cfg.authority !== authority.publicKey.toBase58()) throw new Error(`config authority is ${cfg.authority}, not ${authority.publicKey.toBase58()} (${AUTH})`);

  const rootRegistered = (await conn.getAccountInfo(policyRootPda(hex(DEFAULT_POLICY_ROOT)), 'confirmed')) !== null;
  let ix: TransactionInstruction | undefined;
  const extraSigners: Array<(tx: Transaction) => Promise<void>> = [];
  switch (STEP) {
    case 'b':
      if (rootRegistered) console.log(`b: default policy root ${DEFAULT_POLICY_ROOT} already registered — nothing to send`);
      else ix = buildRegisterPolicyRootIx(authority.publicKey, hex(DEFAULT_POLICY_ROOT));
      break;
    case 'a':
      if (!rootRegistered) throw new Error('a: the default policy root is not registered — run step b first, or every attestation would be refused');
      if (cfg.allowlistPolicies) console.log('a: allowlist_policies is already true — nothing to send');
      else ix = buildSetConfigIx(authority.publicKey, { allowlistPolicies: true });
      break;
    case 'c1': {
      if (cfg.allowedVkeys.includes(CURRENT_VKEY)) { console.log(`c1: ${CURRENT_VKEY} already allowed — nothing to send`); break; }
      const next = [...cfg.allowedVkeys, CURRENT_VKEY];
      if (next.length > MAX_VKEYS) throw new Error(`c1: ${next.length} vkeys exceeds the on-chain maximum ${MAX_VKEYS}`);
      console.log(`c1: allowed_vkeys → ${JSON.stringify(next)}`);
      ix = buildSetConfigIx(authority.publicKey, { allowedVkeys: next.map(hex) });
      break;
    }
    case 'c2': {
      const samplePath = flag('--new-sample');
      if (!samplePath) throw new Error('c2: pass --new-sample <attestation.json> — an attestation under the current vkey already consumed on mainnet');
      const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as Attestation;
      if (sample.detectorVersion !== CURRENT_VKEY) throw new Error(`c2: the sample's detectorVersion ${sample.detectorVersion} is not CURRENT_VKEY ${CURRENT_VKEY}`);
      if (!(await isConsumed(sample, conn))) throw new Error('c2: the sample has not been consumed on mainnet yet — land it first');
      if (!cfg.allowedVkeys.includes(CURRENT_VKEY)) throw new Error('c2: CURRENT_VKEY is not allowed yet — run c1 first');
      const next = cfg.allowedVkeys.filter((k) => !LEGACY_VKEYS.includes(k));
      if (next.length === cfg.allowedVkeys.length) { console.log('c2: no legacy vkey on chain — nothing to send'); break; }
      console.log(`c2: allowed_vkeys → ${JSON.stringify(next)} (removing ${cfg.allowedVkeys.filter((k) => LEGACY_VKEYS.includes(k)).join(', ')})`);
      ix = buildSetConfigIx(authority.publicKey, { allowedVkeys: next.map(hex) });
      break;
    }
    case 'd': {
      const want = flag('--ledger-pubkey');
      if (!want) throw new Error('d: pass --ledger-pubkey <pubkey> (checked against the connected Ledger)');
      const newAuth = new PublicKey(want);
      ix = buildSetAuthorityIx(authority.publicKey, newAuth);
      if (!DRY) {
        // The Ledger must co-sign. Loaded on demand (not a repo dependency): the step stops with the
        // install command when the libraries are missing. Enable "blind signing" in the Solana app.
        let Transport: any, Solana: any;
        try {
          Transport = (await import('@ledgerhq/hw-transport-node-hid' as string)).default;
          Solana = (await import('@ledgerhq/hw-app-solana' as string)).default;
        } catch {
          throw new Error('d: the Ledger libraries are not installed. In a scratch directory: npm i @ledgerhq/hw-transport-node-hid@6 @ledgerhq/hw-app-solana@7, then re-run with NODE_PATH=<that dir>/node_modules');
        }
        const app = new Solana(await Transport.create());
        const { address } = await app.getAddress(LEDGER_PATH);
        const ledgerKey = new PublicKey(address);
        if (!ledgerKey.equals(newAuth)) throw new Error(`d: the connected Ledger (${LEDGER_PATH}) is ${ledgerKey.toBase58()}, not ${want}`);
        extraSigners.push(async (tx) => {
          const { signature } = await app.signTransaction(LEDGER_PATH, tx.serializeMessage());
          tx.addSignature(ledgerKey, Buffer.from(signature));
        });
      }
      break;
    }
  }
  if (!ix) return;

  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ix);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  console.log(`step ${STEP}: transaction (fee payer ${authority.publicKey.toBase58()}, program ${PROGRAM_ID.toBase58()})`);
  describe(ix);
  if (DRY) {
    console.log(`  unsigned message (base64) ${tx.serializeMessage().toString('base64')}`);
    console.log('DRY RUN: nothing signed or sent');
    return;
  }
  tx.partialSign(authority);
  for (const sign of extraSigners) await sign(tx);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(`SIGNATURE ${STEP} ${sig}`);
  const after = decodeConfig((await conn.getAccountInfo(configPda(), 'confirmed'))!.data);
  console.log(`Config after: ${JSON.stringify(after)}`);
}

main().catch((e) => { console.error(`mainnet-admin-0.7.0 failed: ${e instanceof Error ? e.message : e}`); process.exit(1); });
