// M2 mainnet acceptance (after scripts/mainnet-deploy.sh and `blindseal attest`):
//   1) one real attestation → a gated 0.001 SOL transfer on mainnet (verify + consume + transfer in one tx)
//   2) the same attestation replayed → rejected (NullifierAlreadyConsumed)
// Prints both signatures for REPORT.md. Mainnet only (genesis-hash guard). Signer = the mainnet
// authority keypair, which is also the attestation's sourceAuthority.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { MAINNET_GENESIS_HASH, DEFAULT_RPC_URL, buildGatedTransferIx, isConsumed, actionArgsFrom, hex, type Attestation } from 'blindseal-sdk';

const RPC = process.env.BLINDSEAL_RPC_URL ?? DEFAULT_RPC_URL;
const AUTH = process.env.BLINDSEAL_MAINNET_AUTHORITY ?? path.join(os.homedir(), '.blindseal', 'mainnet-authority.json');
const ATT_PATH = process.argv[2] ?? 'mainnet-attestation.json';

async function main() {
  const conn = new Connection(RPC, 'confirmed');
  if ((await conn.getGenesisHash()) !== MAINNET_GENESIS_HASH) throw new Error('RPC is not mainnet-beta; refusing');
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(AUTH, 'utf8'))));
  const att = JSON.parse(readFileSync(ATT_PATH, 'utf8')) as Attestation;
  const a = actionArgsFrom(att);
  if (!a.sourceAuthority.equals(authority.publicKey)) throw new Error('attestation sourceAuthority is not the signing authority');
  const slot = await conn.getSlot('confirmed');
  if (att.expirySlot < slot) throw new Error(`attestation expired (expiry ${att.expirySlot} < slot ${slot})`);
  console.log(`authority ${authority.publicKey.toBase58()} → recipient ${a.recipient.toBase58()} amount ${a.amount} lamports; slot ${slot}`);
  console.log(`nullifier ${att.nullifier} consumed before: ${await isConsumed(att, conn)}`);

  const send = async (label: string) => {
    const ix = buildGatedTransferIx(att, { source: authority.publicKey, recipient: a.recipient });
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix);
    tx.feePayer = authority.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(authority);
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
  if (first.err) throw new Error('first gated transfer failed');
  console.log(`nullifier consumed now: ${await isConsumed(att, conn)}`);
  const replay = await send('2) replay (must fail NullifierAlreadyConsumed)');
  if (!replay.err) throw new Error('replay was accepted — this must not happen');
  console.log('\nREPORT.md:\n  gated transfer:', first.sig, '\n  replay rejected:', replay.sig ?? '(rejected at send)');
}
main().catch((e) => { console.error('acceptance failed:', e instanceof Error ? e.message : e); process.exit(1); });
