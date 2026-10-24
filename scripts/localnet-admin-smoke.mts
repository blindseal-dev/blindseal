// Pre-proof smoke on a local validator: the SDK's hand-encoded admin instructions against the
// built programs — initialize → decodeConfig → set_config(paused) → register_policy_root.
// Exercises Anchor wire encoding, PDA seeds and the authority checks without a Groth16 proof.
import { Connection, Keypair, LAMPORTS_PER_SOL, Transaction, SystemProgram } from '@solana/web3.js';
import { buildInitializeIx, buildSetConfigIx, buildRegisterPolicyRootIx, decodeConfig, configPda, policyRootPda, PROGRAM_ID, TRANSFER_GATE_ID, hex } from 'blindseal-sdk';
const conn = new Connection('http://127.0.0.1:8899', 'confirmed');
const auth = Keypair.generate();
const vkey = hex('0x006a0d1e62646623f1d2b9af7f3792c4d15aa7d6107bdb089a0760fd5b29331e');
const root = hex('0x36a9e9457db6ecfd752a379fc9279ad6a0acfea07928f61e2f3638a685c38397');
const send = async (label: string, ix: any, signer = auth) => {
  const tx = new Transaction().add(ix); tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash; tx.sign(signer);
  const sig = await conn.sendRawTransaction(tx.serialize()); await conn.confirmTransaction(sig, 'confirmed');
  console.log(`${label}: ok`); return sig;
};
const expectFail = async (label: string, ix: any, signer: Keypair, code: string) => {
  try { await send(label, ix, signer); throw new Error(`${label}: unexpectedly succeeded`); }
  catch (e: any) { const logs: string[] = e.logs ?? []; const hit = logs.some((l) => l.includes(code)) || String(e.message).includes(code);
    console.log(`${label}: rejected (${hit ? code : 'other: ' + (logs.find((l) => l.includes('Error')) ?? e.message)})`); if (!hit) process.exitCode = 1; }
};
(async () => {
  for (const [n, id] of [['verify', PROGRAM_ID], ['gate', TRANSFER_GATE_ID]] as const) {
    const info = await conn.getAccountInfo(id); if (!info?.executable) throw new Error(`${n} program not loaded at ${id.toBase58()}`); console.log(`${n} program loaded`);
  }
  await conn.confirmTransaction(await conn.requestAirdrop(auth.publicKey, 2 * LAMPORTS_PER_SOL), 'confirmed');
  await send('initialize', buildInitializeIx(auth.publicKey, [vkey], false));
  let cfg = decodeConfig((await conn.getAccountInfo(configPda()))!.data);
  console.log('config:', JSON.stringify(cfg));
  if (cfg.authority !== auth.publicKey.toBase58() || cfg.paused || cfg.allowlistPolicies || cfg.allowedVkeys.length !== 1) throw new Error('config decode mismatch');
  await send('set_config(paused=true)', buildSetConfigIx(auth.publicKey, { paused: true }));
  cfg = decodeConfig((await conn.getAccountInfo(configPda()))!.data); if (!cfg.paused) throw new Error('paused not set');
  await send('set_config(paused=false, allowlist=true)', buildSetConfigIx(auth.publicKey, { paused: false, allowlistPolicies: true }));
  cfg = decodeConfig((await conn.getAccountInfo(configPda()))!.data); if (cfg.paused || !cfg.allowlistPolicies) throw new Error('set_config mismatch');
  const stranger = Keypair.generate(); await conn.confirmTransaction(await conn.requestAirdrop(stranger.publicKey, LAMPORTS_PER_SOL), 'confirmed');
  await expectFail('set_config by a non-authority', buildSetConfigIx(stranger.publicKey, { paused: true }), stranger, 'Unauthorized');
  await send('register_policy_root', buildRegisterPolicyRootIx(auth.publicKey, root));
  const pr = await conn.getAccountInfo(policyRootPda(root)); if (!pr || !pr.owner.equals(PROGRAM_ID)) throw new Error('PolicyRoot PDA missing');
  console.log('PolicyRoot PDA:', policyRootPda(root).toBase58(), pr.data.length, 'bytes');
  await expectFail('register_policy_root twice', buildRegisterPolicyRootIx(auth.publicKey, root), auth, 'already in use');
  console.log('ADMIN SMOKE OK');
})().catch((e) => { console.error('smoke failed:', e.message ?? e); process.exit(1); });
