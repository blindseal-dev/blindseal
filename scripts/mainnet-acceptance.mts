// Mainnet gated consumption (after scripts/mainnet-deploy.sh and `blindseal attest`):
//   1) one real attestation → a gated transfer on mainnet (verify + consume + transfer in one tx,
//      through transfer-gate — the verifier accepts only a CPI from the attestation's target)
//   2) prints the signature, the Nullifier PDA and its decoded consumer_program (must be transfer-gate)
//   3) the same attestation replayed → rejected (NullifierAlreadyConsumed)
// Mainnet only (genesis-hash guard runs before any keypair is read). The signer is the
// attestation's source authority: the transfer debits it and it pays the Nullifier rent + fees.
//
// Usage: pnpm exec tsx scripts/mainnet-acceptance.mts [attestation.json] [source-authority-keypair.json]
//   defaults: tests/fixtures/attestation-mainnet-demo.json, ~/.blindseal/demo-wallet.json
//   env: BLINDSEAL_RPC_URL (default: the public mainnet endpoint)
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComputeBudgetProgram, Connection, Keypair, Transaction } from '@solana/web3.js';
import {
  MAINNET_GENESIS_HASH, DEFAULT_RPC_URL, TRANSFER_GATE_ID, VERIFY_CU_LIMIT, buildGatedTransferIx, isConsumed,
  actionArgsFrom, decodeNullifier, decodePublicInputs, hex, nullifierPda, type Attestation,
} from 'blindseal-sdk';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const expandHome = (p: string) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const RPC = process.env.BLINDSEAL_RPC_URL ?? DEFAULT_RPC_URL;
const ATT_PATH = expandHome(process.argv[2] ?? path.join(ROOT, 'tests/fixtures/attestation-mainnet-demo.json'));
const WALLET_PATH = expandHome(process.argv[3] ?? path.join(os.homedir(), '.blindseal', 'demo-wallet.json'));

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  if ((await conn.getGenesisHash()) !== MAINNET_GENESIS_HASH) throw new Error('RPC is not mainnet-beta; refusing');
  const att = JSON.parse(readFileSync(ATT_PATH, 'utf8')) as Attestation;
  const a = actionArgsFrom(att);
  if (!a.targetProgram.equals(TRANSFER_GATE_ID)) throw new Error(`attestation targets ${a.targetProgram.toBase58()}, not transfer-gate`);
  const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(WALLET_PATH, 'utf8'))));
  if (!a.sourceAuthority.equals(signer.publicKey)) throw new Error(`attestation sourceAuthority ${a.sourceAuthority.toBase58()} is not the signing wallet ${signer.publicKey.toBase58()}`);
  const slot = await conn.getSlot('confirmed');
  if (att.expirySlot < slot) throw new Error(`attestation expired (expiry ${att.expirySlot} < slot ${slot})`);
  const pda = nullifierPda(decodePublicInputs(hex(att.publicInputs[0])).nullifier);
  console.log(`attestation ${ATT_PATH}`);
  console.log(`source ${signer.publicKey.toBase58()} → recipient ${a.recipient.toBase58()} amount ${a.amount} lamports; slot ${slot}`);
  console.log(`nullifier ${att.nullifier} (PDA ${pda.toBase58()}) consumed before: ${await isConsumed(att, conn)}`);

  const send = async (label: string) => {
    const ix = buildGatedTransferIx(att, { source: signer.publicKey, recipient: a.recipient });
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: VERIFY_CU_LIMIT }), ix);
    tx.feePayer = signer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(signer);
    try {
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      const res = await conn.confirmTransaction(sig, 'confirmed');
      const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      const logs = t?.meta?.logMessages ?? [];
      const err = res.value.err ?? t?.meta?.err ?? null;
      console.log(`${label}: ${sig}  ${err ? 'FAILED ' + JSON.stringify(err) : 'OK'}`);
      const anchorErr = logs.find((l) => l.includes('AnchorError'));
      if (anchorErr) console.log('  ', anchorErr);
      console.log('   CU:', t?.meta?.computeUnitsConsumed, 'tx bytes:', tx.serialize().length);
      return { sig, err };
    } catch (e: any) {
      // a rejected replay still lands as a failed tx when the RPC accepted it; surface its signature
      const sig: string | null = e?.signature ?? (typeof e?.message === 'string' && /signature (\w{80,})/.exec(e.message)?.[1]) ?? null;
      const logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
      console.log(`${label}: failed${sig ? ' ' + sig : ''} — ${logs.find((l) => l.includes('AnchorError')) ?? (e?.message ?? JSON.stringify(e))}`);
      return { sig, err: e };
    }
  };
  const first = await send('1) gated transfer');
  if (first.err) throw new Error('gated transfer failed');
  const info = await conn.getAccountInfo(pda, 'confirmed');
  if (!info) throw new Error(`Nullifier PDA ${pda.toBase58()} not found after the gated transfer`);
  const rec = decodeNullifier(info.data);
  console.log(`nullifier PDA ${pda.toBase58()}: consumed at slot ${rec.consumedAtSlot}, consumer_program ${rec.consumerProgram.toBase58()}`
    + (rec.consumerProgram.equals(TRANSFER_GATE_ID) ? ' (transfer-gate)' : ' — NOT transfer-gate'));
  const replay = await send('2) replay (must fail NullifierAlreadyConsumed)');
  if (!replay.err) throw new Error('replay was accepted — this must not happen');
  console.log('\nREPORT.md:\n  gated transfer:', first.sig, '\n  nullifier PDA:', pda.toBase58(),
    '\n  consumer_program:', rec.consumerProgram.toBase58(), '\n  replay rejected:', replay.sig ?? '(rejected at send)');
}
main().catch((e) => { console.error('acceptance failed:', e instanceof Error ? e.message : e); process.exit(1); });
