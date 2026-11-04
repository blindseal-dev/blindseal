// Config steps of the 0.7.0 mainnet upgrade, driven by scripts/mainnet-0.7.0.sh (one step per run).
//   --step b    register_policy_root(DEFAULT_POLICY_ROOT)                     (skipped if registered)
//   --step b2   register_policy_root(DEMO_POLICY_ROOT)  (0.8.0: the mainnet sample's root; skipped if registered)
//   --step a    set_config(allowlist_policies = true)                          (refused unless b is done)
//   --step c1   set_config(allowed_vkeys = on-chain list + CURRENT_VKEY)       (keeps the old vkey; refused unless a is done)
//   --step c2   set_config(allowed_vkeys = on-chain list − LEGACY_VKEYS)       (needs --new-sample <attestation.json>:
//               an attestation under CURRENT_VKEY whose nullifier is already consumed on mainnet)
//   --step f    set_fee(0, <treasury>)  (0.8.0: needs --treasury <pubkey>; only after the 0.8.0 program upgrade —
//               reallocs Config 303 → 343 bytes and records the treasury; charges nothing)
//   --step d    set_authority(<ledger pubkey>)                                  (needs --ledger-pubkey; the Ledger co-signs)
//   --dry-run   build and print the transaction (program, accounts, data, unsigned message) — nothing is signed or sent
//   --simulate  build the transaction UNSIGNED and run simulateTransaction (sigVerify off, blockhash replaced) — prints
//               logs, compute units, the error if any, and the Config the transaction would leave. Nothing is signed or
//               sent. When an earlier step has not landed yet, its instruction is prepended (marked "projected") so the
//               simulation shows the state the step will actually run against.
//
// Cluster: mainnet-beta (genesis hash checked) — or, for a rehearsal, a LOCAL validator: an RPC on 127.0.0.1 /
// localhost whose genesis is neither mainnet, devnet nor testnet (e.g. solana-test-validator cloning mainnet). Only
// on such a local cluster: c2's sample precondition is reported but not enforced, and d takes
// --new-authority-keypair <file> (a throwaway key standing in for the Ledger). Neither relaxation exists on mainnet.
// Signer: the config authority keypair at $BLINDSEAL_MAINNET_AUTHORITY (default ~/.blindseal/mainnet-authority.json).
// Prints the signature and the Config after each step.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionMessage, VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  MAINNET_GENESIS_HASH, DEFAULT_RPC_URL, PROGRAM_ID, MAX_VKEYS, configPda, policyRootPda, decodeConfig, hex, isConsumed,
  buildSetConfigIx, buildRegisterPolicyRootIx, buildSetAuthorityIx, CURRENT_VKEY, LEGACY_VKEYS, DEFAULT_POLICY_ROOT, DEMO_POLICY_ROOT, buildSetFeeIx,
  type Attestation,
} from 'blindseal-sdk';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const TESTNET_GENESIS = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY';
const CU_LIMIT = 50_000;
const FEE_PER_SIGNATURE = 5_000; // lamports; no priority fee is set

const argv = process.argv.slice(2);
const flag = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const STEP = flag('--step');
const DRY = argv.includes('--dry-run');
const SIM = argv.includes('--simulate');
const RPC = process.env.BLINDSEAL_RPC_URL ?? DEFAULT_RPC_URL;
const AUTH = process.env.BLINDSEAL_MAINNET_AUTHORITY ?? path.join(os.homedir(), '.blindseal', 'mainnet-authority.json');
const LEDGER_PATH = "44'/501'/0'"; // = usb://ledger?key=0
const ORDER = ['b', 'a', 'c1', 'c2'] as const; // b2 and d are independent

/// Step 0 (the program upgrades) must have landed before any config step is SENT: the executable
/// hashes of the deployed programs must be the 0.7.0 verifiable builds (solana-verify's
/// get-program-hash: ProgramData after its 45-byte header, trailing zero padding removed).
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const GATE_ID = new PublicKey('9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa');
/// Verifiable-build executable hashes per release. Config steps are sent only while the deployed programs are one
/// of these builds (0.8.0's from the verifiable-build workflow at the release commit; docs/release-0.8.0-plan.md).
const RELEASE_HASHES: Record<'0.7.0' | '0.8.0', Array<[string, PublicKey, string]>> = {
  '0.7.0': [
    ['transfer_gate', GATE_ID, 'a0d51e460d88919e137bd02d77a97d63def0e78c6bef1112df777c658107fb86'],
    ['blindseal_verify', PROGRAM_ID, '5a1f0e90dd3e910ea04db2de02cff5cc7cac2de29db6925b9a6e1250ce078bed'],
  ],
  '0.8.0': [
    ['transfer_gate', GATE_ID, '5d02435797e80ae99ab3600f5cae9f5b819b49de42c751ae69b0fc30c97dbc0b'],
    ['blindseal_verify', PROGRAM_ID, '95a7cd065535b73777a3ffd5b93f6e70c2d38f04021f3f1b0068f424fadc2167'],
  ],
};

async function deployedProgramHash(conn: Connection, programId: PublicKey): Promise<string | null> {
  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], UPGRADEABLE_LOADER);
  const acc = await conn.getAccountInfo(programData, 'confirmed');
  if (!acc) return null;
  let end = acc.data.length;
  while (end > 45 && acc.data[end - 1] === 0) end--;
  return createHash('sha256').update(acc.data.subarray(45, end)).digest('hex');
}

/// Which release's verifiable builds are deployed: '0.7.0', '0.8.0', or throws (a mix, or unknown bytes).
async function deployedRelease(conn: Connection): Promise<'0.7.0' | '0.8.0'> {
  const got = await Promise.all(RELEASE_HASHES['0.7.0'].map(([, id]) => deployedProgramHash(conn, id)));
  for (const rel of ['0.8.0', '0.7.0'] as const) {
    if (RELEASE_HASHES[rel].every(([, , want], i) => got[i] === want)) return rel;
  }
  throw new Error(`the deployed programs are not one release's verifiable builds (transfer_gate ${got[0] ?? 'missing'}, blindseal_verify ${got[1] ?? 'missing'}); finish step 0 first`);
}

async function requireStep0(conn: Connection, step: string): Promise<void> {
  const rel = await deployedRelease(conn);
  if (step === 'f' && rel !== '0.8.0') throw new Error('f: set_fee exists only in the 0.8.0 programs — upgrade transfer-gate and blindseal-verify first');
  console.log(`deployed programs: the ${rel} verifiable builds`);
}

/// The typed confirmation lives here, not only in the shell wrapper, so running this helper
/// directly cannot sign without it. It needs a terminal; a local rehearsal without one passes the
/// exact phrase in BLINDSEAL_REHEARSAL_CONFIRM (refused on mainnet).
async function confirmSend(step: string, where: 'mainnet' | 'local'): Promise<void> {
  const phrase = `send ${step} to ${where}`;
  if (!process.stdin.isTTY) {
    if (where === 'local' && process.env.BLINDSEAL_REHEARSAL_CONFIRM === phrase) return;
    throw new Error(`refusing to sign: no terminal to confirm on (the confirmation is the typed phrase '${phrase}')`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const got = (await rl.question(`   type '${phrase}' to sign and send: `)).trim();
  rl.close();
  if (got !== phrase) throw new Error('aborted: the confirmation did not match');
}
type Cfg = ReturnType<typeof decodeConfig>;

function loadKeypair(file: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8'))));
}

function describe(ix: TransactionInstruction) {
  console.log(`  program   ${ix.programId.toBase58()}`);
  ix.keys.forEach((k, i) => console.log(`  account ${i} ${k.pubkey.toBase58()}${k.isSigner ? ' signer' : ''}${k.isWritable ? ' writable' : ''}`));
  console.log(`  data      ${ix.data.toString('hex')}`);
}

/** Which cluster is this? 'mainnet', or 'local' (localhost RPC, not a public cluster); anything else throws. */
async function cluster(conn: Connection): Promise<'mainnet' | 'local'> {
  const genesis = await conn.getGenesisHash();
  if (genesis === MAINNET_GENESIS_HASH) return 'mainnet';
  const host = new URL(RPC).hostname;
  if ((host === '127.0.0.1' || host === 'localhost') && genesis !== DEVNET_GENESIS && genesis !== TESTNET_GENESIS) return 'local';
  throw new Error(`the RPC is neither mainnet-beta nor a local validator (genesis ${genesis}); refusing`);
}

interface Ctx { authority: PublicKey; rootRegistered: boolean; demoRegistered: boolean; local: boolean; lenient: boolean; conn: Connection }
interface Planned { ix?: TransactionInstruction; next: Cfg; rootRegistered: boolean; signers: PublicKey[] }

/** The instruction step `step` sends against Config `cfg` (none = already done), and the Config it leaves.
 *  A failed precondition throws — unless `ctx.lenient` (simulation / local rehearsal), where it is reported. */
async function plan(step: string, cfg: Cfg, ctx: Ctx): Promise<Planned> {
  const refuse = (msg: string) => {
    if (!ctx.lenient) throw new Error(msg);
    console.log(`  PRECONDITION NOT MET (a real mainnet send would refuse here): ${msg}`);
  };
  const base = { next: cfg, rootRegistered: ctx.rootRegistered, signers: [ctx.authority] };
  switch (step) {
    case 'b':
      if (ctx.rootRegistered) { console.log(`b: default policy root ${DEFAULT_POLICY_ROOT} already registered (${policyRootPda(hex(DEFAULT_POLICY_ROOT)).toBase58()}) — nothing to send`); return base; }
      return { ...base, ix: buildRegisterPolicyRootIx(ctx.authority, hex(DEFAULT_POLICY_ROOT)), rootRegistered: true };
    case 'b2':
      if (ctx.demoRegistered) { console.log(`b2: demo policy root ${DEMO_POLICY_ROOT} already registered (${policyRootPda(hex(DEMO_POLICY_ROOT)).toBase58()}) — nothing to send`); return base; }
      return { ...base, ix: buildRegisterPolicyRootIx(ctx.authority, hex(DEMO_POLICY_ROOT)) };
    case 'a':
      if (!ctx.rootRegistered) throw new Error('a: the default policy root is not registered — run step b first, or every attestation would be refused');
      if (cfg.allowlistPolicies) { console.log('a: allowlist_policies is already true — nothing to send'); return base; }
      return { ...base, ix: buildSetConfigIx(ctx.authority, { allowlistPolicies: true }), next: { ...cfg, allowlistPolicies: true } };
    case 'f': {
      const t = flag('--treasury');
      if (!t) throw new Error('f: pass --treasury <pubkey> — an existing rent-exempt account (the authority itself is a fine first treasury)');
      const treasury = new PublicKey(t);
      if (cfg.hasFeeFields && cfg.treasury === treasury.toBase58() && cfg.feeLamports === 0n) { console.log(`f: fee 0 and treasury ${t} already set — nothing to send`); return base; }
      console.log(`f: set_fee(0, ${t}) — Config ${cfg.hasFeeFields ? 'already 343 bytes' : 'grows 303 → 343 bytes (authority pays the rent difference)'}; nothing is charged`);
      return { ...base, ix: buildSetFeeIx(ctx.authority, 0, treasury) };
    }
    case 'c1': {
      if (!cfg.allowlistPolicies) throw new Error('c1: allowlist_policies is still false — run step a first (order 0 → b → a → c1)');
      if (cfg.allowedVkeys.includes(CURRENT_VKEY)) { console.log(`c1: ${CURRENT_VKEY} already allowed — nothing to send`); return base; }
      const next = [...cfg.allowedVkeys, CURRENT_VKEY];
      if (next.length > MAX_VKEYS) throw new Error(`c1: ${next.length} vkeys exceeds the on-chain maximum ${MAX_VKEYS}`);
      console.log(`c1: allowed_vkeys → ${JSON.stringify(next)}`);
      return { ...base, ix: buildSetConfigIx(ctx.authority, { allowedVkeys: next.map(hex) }), next: { ...cfg, allowedVkeys: next } };
    }
    case 'c2': {
      const samplePath = flag('--new-sample');
      if (!samplePath) refuse('c2: pass --new-sample <attestation.json> — an attestation under the current vkey already consumed on mainnet');
      else {
        const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as Attestation;
        if (sample.detectorVersion !== CURRENT_VKEY) refuse(`c2: the sample's detectorVersion ${sample.detectorVersion} is not CURRENT_VKEY ${CURRENT_VKEY}`);
        else if (!(await isConsumed(sample, ctx.conn))) refuse('c2: the sample has not been consumed on chain yet — land it first');
      }
      if (!cfg.allowedVkeys.includes(CURRENT_VKEY)) throw new Error('c2: CURRENT_VKEY is not allowed yet — run c1 first');
      const next = cfg.allowedVkeys.filter((k) => !LEGACY_VKEYS.includes(k));
      if (next.length === cfg.allowedVkeys.length) { console.log('c2: no legacy vkey on chain — nothing to send'); return base; }
      console.log(`c2: allowed_vkeys → ${JSON.stringify(next)} (removing ${cfg.allowedVkeys.filter((k) => LEGACY_VKEYS.includes(k)).join(', ')})`);
      return { ...base, ix: buildSetConfigIx(ctx.authority, { allowedVkeys: next.map(hex) }), next: { ...cfg, allowedVkeys: next } };
    }
    case 'd': {
      // After d the config authority is the Ledger, and this script signs set_config only with a keypair file:
      // c2 must land first.
      if (cfg.allowedVkeys.some((k) => LEGACY_VKEYS.includes(k))) refuse('d: the old vkey is still allowed — run c2 first (after d, set_config needs the Ledger, which this script cannot sign with)');
      const want = flag('--ledger-pubkey');
      const kpFile = flag('--new-authority-keypair');
      let newAuth: PublicKey;
      if (kpFile) {
        if (!ctx.local) throw new Error('d: --new-authority-keypair is for a local rehearsal only; on mainnet the new authority is the Ledger (--ledger-pubkey)');
        newAuth = loadKeypair(kpFile).publicKey;
      } else if (want) newAuth = new PublicKey(want);
      else if (SIM) { newAuth = Keypair.generate().publicKey; console.log(`d: no --ledger-pubkey given — simulating with a PLACEHOLDER new authority ${newAuth.toBase58()}`); }
      else throw new Error('d: pass --ledger-pubkey <pubkey> (checked against the connected Ledger)');
      if (newAuth.equals(ctx.authority)) throw new Error('d: the new authority equals the current one');
      return { ...base, ix: buildSetAuthorityIx(ctx.authority, newAuth), next: { ...cfg, authority: newAuth.toBase58() }, signers: [ctx.authority, newAuth] };
    }
  }
  throw new Error(`unknown step ${step}`);
}

async function simulate(conn: Connection, payer: PublicKey, ixs: TransactionInstruction[]) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT * ixs.length }), ...ixs] }).compileToV0Message();
  const vtx = new VersionedTransaction(msg); // UNSIGNED: never hand a signed transaction to an RPC for simulation
  const res = await conn.simulateTransaction(vtx, {
    sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
    accounts: { addresses: [configPda().toBase58()], encoding: 'base64' },
  });
  const v = res.value;
  console.log(`  simulation: ${v.err ? 'ERROR ' + JSON.stringify(v.err) : 'OK'}   compute units ${v.unitsConsumed}   tx size ${vtx.serialize().length} bytes`);
  for (const l of v.logs ?? []) console.log(`    | ${l}`);
  if (JSON.stringify(v.err ?? null).includes('{"Custom":101}')) console.log('  (101 = InstructionFallbackNotFound: the deployed verifier has no such instruction — set_authority arrives with step 0)');
  const acc = v.accounts?.[0];
  if (acc && !v.err) console.log(`  Config after (simulated): ${JSON.stringify(decodeConfig(Buffer.from(acc.data[0], 'base64')))}`);
  return v;
}

async function main() {
  if (!STEP || !['a', 'b', 'b2', 'f', 'c1', 'c2', 'd'].includes(STEP)) throw new Error('usage: --step a|b|b2|f|c1|c2|d [--dry-run|--simulate] [--new-sample <file>] [--treasury <pk>] [--ledger-pubkey <pk>]');
  const conn = new Connection(RPC, 'confirmed');
  const where = await cluster(conn);
  if (where === 'local') console.log('LOCAL REHEARSAL cluster (localhost, not a public cluster)');
  const authority = loadKeypair(AUTH);
  const cfgInfo = await conn.getAccountInfo(configPda(), 'confirmed');
  if (!cfgInfo) throw new Error('Config does not exist on this cluster (deploy first: scripts/mainnet-deploy.sh)');
  const cfg = decodeConfig(cfgInfo.data);
  console.log(`Config before: ${JSON.stringify(cfg)}`);
  if (cfg.authority !== authority.publicKey.toBase58()) throw new Error(`config authority is ${cfg.authority}, not ${authority.publicKey.toBase58()}`);
  const rootRegistered = (await conn.getAccountInfo(policyRootPda(hex(DEFAULT_POLICY_ROOT)), 'confirmed')) !== null;
  const demoRegistered = (await conn.getAccountInfo(policyRootPda(hex(DEMO_POLICY_ROOT)), 'confirmed')) !== null;
  const ctx: Ctx = { authority: authority.publicKey, rootRegistered, demoRegistered, local: where === 'local', lenient: SIM || where === 'local', conn };

  if (SIM) {
    // Prepend earlier steps that have not landed yet, so the simulation runs against the state the step will meet.
    const ixs: TransactionInstruction[] = [];
    let cur = cfg; let signers = [authority.publicKey];
    const chain = STEP === 'd' || STEP === 'b2' || STEP === 'f' ? [STEP] : ORDER.slice(0, ORDER.indexOf(STEP as (typeof ORDER)[number]) + 1);
    for (const s of chain) {
      const p = await plan(s, cur, { ...ctx, rootRegistered: ctx.rootRegistered });
      ctx.rootRegistered = p.rootRegistered; cur = p.next; signers = p.signers;
      if (!p.ix) continue;
      console.log(`step ${s}${s === STEP ? '' : ' (projected prerequisite, not yet on chain)'}: instruction`);
      describe(p.ix);
      ixs.push(p.ix);
    }
    if (!ixs.length) { console.log(`SIMULATE ${STEP}: nothing to send`); return; }
    console.log(`fee payer ${authority.publicKey.toBase58()}; signers ${signers.map((k) => k.toBase58()).join(', ')}; fee ${FEE_PER_SIGNATURE * signers.length} lamports`);
    const v = await simulate(conn, authority.publicKey, ixs);
    console.log(`SIMULATE ${STEP}: ${v.err ? 'FAILED' : 'ok'} — nothing signed or sent`);
    if (v.err) process.exit(1);
    return;
  }

  const p = await plan(STEP, cfg, ctx);
  if (!p.ix) return;
  const ix = p.ix;
  if (!DRY) await requireStep0(conn, STEP);
  const extraSigners: Array<(tx: Transaction) => Promise<void>> = [];
  if (STEP === 'd' && !DRY) {
    const kpFile = flag('--new-authority-keypair');
    if (kpFile) { // local rehearsal only (plan() refuses it on mainnet)
      const kp = loadKeypair(kpFile);
      extraSigners.push(async (tx) => tx.partialSign(kp));
    } else {
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
      const newAuth = p.signers[1];
      if (!ledgerKey.equals(newAuth)) throw new Error(`d: the connected Ledger (${LEDGER_PATH}) is ${ledgerKey.toBase58()}, not ${newAuth.toBase58()}`);
      extraSigners.push(async (tx) => {
        const { signature } = await app.signTransaction(LEDGER_PATH, tx.serializeMessage());
        tx.addSignature(ledgerKey, Buffer.from(signature));
      });
    }
  }

  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }), ix);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  console.log(`step ${STEP}: transaction (fee payer ${authority.publicKey.toBase58()}, program ${PROGRAM_ID.toBase58()}, fee ${FEE_PER_SIGNATURE * p.signers.length} lamports)`);
  describe(ix);
  if (DRY) {
    console.log(`  unsigned message (base64) ${tx.serializeMessage().toString('base64')}`);
    console.log('DRY RUN: nothing signed or sent');
    return;
  }
  await confirmSend(STEP, where);
  tx.partialSign(authority);
  for (const sign of extraSigners) await sign(tx);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(`SIGNATURE ${STEP} ${sig}`);
  const after = decodeConfig((await conn.getAccountInfo(configPda(), 'confirmed'))!.data);
  console.log(`Config after: ${JSON.stringify(after)}`);
}

main().catch((e) => { console.error(`mainnet-admin-0.7.0 failed: ${e instanceof Error ? e.message : e}`); process.exit(1); });
