// M2 verifier suite (every check in the blindseal-verify header, in order), run by scripts/test-m2.sh on localnet.
// One real Groth16 attestation (tests/fixtures/attestation-test.json, produced by
// crates/prover for the seed-derived test wallets) covers every case: the verifier's checks
// are ordered BEFORE the Groth16 step, so each negative case is reached with the real proof
// and a crafted action / public-inputs blob, and fails with its own error.
// verify_and_consume accepts only a CPI from the attestation's target program (transfer-gate),
// so the cases go through the gate. The two fields the gate fixes by construction (mint, target
// program) are reached through the test-only forwarder (programs/rogue-caller, loaded at the id
// in ROGUE_CALLER_ID) with the action's target set to the forwarder itself.
// Namespace imports only: the suite may load as ESM, where named imports from these CJS
// packages are not guaranteed.
import * as anchorNs from '@coral-xyz/anchor';
import * as web3Ns from '@solana/web3.js';
import * as chaiNs from 'chai';
// Under the ESM loader a CJS package's namespace carries only `default`; under CJS it is the module.
const cjs = <T,>(ns: T): T => ((ns as any).default ?? ns) as T;
const anchor = cjs(anchorNs) as typeof anchorNs;
const web3 = cjs(web3Ns) as typeof web3Ns;
const { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY } = web3;
type TransactionInstruction = web3Ns.TransactionInstruction;
type Keypair = web3Ns.Keypair;
type PublicKey = web3Ns.PublicKey;
type Program = anchorNs.Program;
type AnchorError = anchorNs.AnchorError;
const { AnchorError, BN } = anchor;
const { expect } = cjs(chaiNs) as typeof chaiNs;
// Admin instructions come from the SDK's hand-encoded builders: the Anchor TS coder crashes on
// `Option<Vec<[u8;32]>>` (set_config with allowed_vkeys = None), and the builders are what the
// mainnet init script uses — so the suite exercises the real client path.
import { buildInitializeIx, buildSetConfigIx, buildRegisterPolicyRootIx, buildGatedTransferIx, decodeConfig, decodeNullifier } from '../packages/sdk/src/ix';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.cwd(); // anchor test runs from the repo root (where Anchor.toml lives)
// Test wallets are derived at test time from fixed seeds — nothing is stored in the repo. Their pubkeys are
// stable, which the localnet proof (tests/fixtures/attestation-test.json) binds as source authority / recipient.
const seeded = (label: string) => Keypair.fromSeed(createHash('sha256').update(`blindseal-localnet:${label}`).digest());
const hex = (s: string) => Buffer.from(s.replace(/^0x/, ''), 'hex');

const att = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/attestation-test.json'), 'utf8'));
const PROOF = hex(att.proof.bytes);
const BLOB = hex(att.publicInputs[0]); // 168 bytes
const NONCE = hex(att.nonce);
const AMOUNT = new BN(att.action.amount);
const VKEY = hex(att.detectorVersion);
const POLICY_ROOT = hex(att.policyRoot);
const NULLIFIER = hex(att.nullifier);
const DISC = hex(att.action.instruction); // sha256("global:gated_transfer")[..8]

const source = seeded('source-authority');
const recipient = seeded('recipient');
if (!process.env.ROGUE_CALLER_ID) throw new Error('ROGUE_CALLER_ID is not set — run the suite via scripts/test-m2.sh');
const ROGUE = new PublicKey(process.env.ROGUE_CALLER_ID);

describe('M2 — blindseal-verify + transfer-gate', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const verify = anchor.workspace.BlindsealVerify as Program;
  const gate = anchor.workspace.TransferGate as Program;
  const authority = (provider.wallet as anchor.Wallet).payer;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], verify.programId);
  const policyPda = (root: Buffer) => PublicKey.findProgramAddressSync([Buffer.from('policy'), root], verify.programId)[0];
  const nullifierPda = (nf: Buffer) => PublicKey.findProgramAddressSync([Buffer.from('nullifier'), nf], verify.programId)[0];
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });

  // The attestation's action, as the gate will reconstruct it. Tests mutate copies.
  const baseAction = () => ({
    chainId: 1,
    targetProgram: gate.programId,
    sourceAuthority: source.publicKey,
    instruction: Array.from(DISC),
    recipient: recipient.publicKey,
    mint: PublicKey.default,
    amount: AMOUNT,
    nonce: Array.from(NONCE),
  });

  // verify_and_consume as a top-level instruction. The verifier refuses this (DirectCallNotAllowed);
  // the suite also wraps it in the forwarder to reach the checks from a CPI.
  const verifyIx = async (action = baseAction(), blob = BLOB, proof = PROOF, withPolicy = true) =>
    verify.methods
      .verifyAndConsume(proof, blob, action)
      .accounts({
        config: configPda,
        policyRoot: withPolicy ? policyPda(blob.subarray(32, 64)) : null,
        nullifier: nullifierPda(blob.subarray(128, 160)),
        payer: source.publicKey,
        systemProgram: SystemProgram.programId,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

  // The test-only forwarder: CPIs `inner.programId` with inner's accounts and data unchanged.
  const viaRogue = (inner: TransactionInstruction): TransactionInstruction => new TransactionInstruction({
    programId: ROGUE,
    keys: [{ pubkey: inner.programId, isSigner: false, isWritable: false }, ...inner.keys],
    data: inner.data,
  });

  const send = async (ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> => {
    const attempt = () => provider.sendAndConfirm(new Transaction().add(cu, ...ixs), signers, { commitment: 'confirmed' });
    try { return await attempt(); } catch (e: any) {
      if (/Blockhash not found/.test(String(e.message))) { await new Promise((r) => setTimeout(r, 800)); return attempt(); }
      throw e;
    }
  };

  // Map a failed send to the Anchor error NAME. Logs live on e.logs (older web3) or
  // e.transactionLogs (web3 1.9x); when neither carries the "AnchorError" line, map the custom
  // error number from the message through the IDL (6000 + index), plus Anchor's framework codes.
  const FRAMEWORK: Record<number, string> = { 3008: 'InvalidProgramId', 2001: 'ConstraintHasOne', 2003: 'ConstraintRaw' };
  const errorName = (e: any): string | undefined => {
    const logs: string[] = e.logs ?? e.transactionLogs ?? e.error?.logs ?? [];
    try { const p = AnchorError.parse(logs); if (p?.error?.errorCode?.code) return p.error.errorCode.code; } catch { /* no anchor line */ }
    if (e.error?.errorCode?.code) return e.error.errorCode.code;
    const text = logs.join('\n') + '\n' + String(e.message ?? e);
    const m = /custom program error: 0x([0-9a-f]+)/i.exec(text);
    if (m) {
      const n = parseInt(m[1], 16);
      if (n >= 6000) return (verify.idl as any).errors?.[n - 6000]?.name;
      if (FRAMEWORK[n]) return FRAMEWORK[n];
    }
    if (/InvalidProgramId|3008/.test(text)) return 'InvalidProgramId';
    return undefined;
  };
  const expectError = async (p: Promise<unknown>, code: string) => {
    let err: any = null;
    try { await p; } catch (e) { err = e; }
    if (!err) expect.fail(`expected failure ${code}, but the transaction succeeded`);
    const got = errorName(err);
    expect(got, `expected ${code}; message: ${String(err.message ?? err).slice(0, 200)}`).to.equal(code);
  };

  const gatedIx = async (opts: { source?: PublicKey; recipient?: PublicKey; amount?: BN; verifyProgram?: PublicKey; proof?: Buffer; blob?: Buffer } = {}) =>
    gate.methods
      .gatedTransfer(opts.proof ?? PROOF, opts.blob ?? BLOB, Array.from(NONCE), opts.amount ?? AMOUNT)
      .accounts({
        source: opts.source ?? source.publicKey,
        recipient: opts.recipient ?? recipient.publicKey,
        config: configPda,
        policyRoot: policyPda(POLICY_ROOT),
        nullifier: nullifierPda(NULLIFIER),
        verifyProgram: opts.verifyProgram ?? verify.programId,
        systemProgram: SystemProgram.programId,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

  before(async () => {
    expect(BLOB.length).to.equal(168);
    // anchor test deploys and immediately runs: an upgradeable program is not invokable in the
    // slot it was deployed in ("Program is not deployed"). Wait for executable + a slot or two.
    for (const id of [verify.programId, gate.programId]) {
      for (let i = 0; i < 60; i++) {
        const info = await conn.getAccountInfo(id, 'confirmed');
        if (info?.executable) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    // a fresh validator answers "Blockhash not found" for its first few slots; let it settle
    while ((await conn.getSlot('confirmed')) < 20) await new Promise((r) => setTimeout(r, 400));
    const sig = await conn.requestAirdrop(source.publicKey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
    // the recipient must end the transfer rent-exempt; a fresh 0-lamport account receiving
    // exactly `amount` can fail the runtime's rent check — give it a floor first
    await conn.confirmTransaction(await conn.requestAirdrop(recipient.publicKey, LAMPORTS_PER_SOL / 100), 'confirmed');
    await send([buildInitializeIx(authority.publicKey, [VKEY], false, verify.programId)], [authority]);
    const cfg = decodeConfig((await conn.getAccountInfo(configPda, 'confirmed'))!.data);
    expect(cfg.paused).to.equal(false);
    expect(cfg.allowlistPolicies).to.equal(false);
    expect(cfg.allowedVkeys).to.deep.equal([att.detectorVersion]);
  });

  it('paused: verify_and_consume is refused while paused', async () => {
    await send([buildSetConfigIx(authority.publicKey, { paused: true }, verify.programId)], [authority]);
    expect(decodeConfig((await conn.getAccountInfo(configPda, 'confirmed'))!.data).paused).to.equal(true);
    await expectError(send([await gatedIx()], [source]), 'Paused');
    await send([buildSetConfigIx(authority.publicKey, { paused: false }, verify.programId)], [authority]);
    expect(decodeConfig((await conn.getAccountInfo(configPda, 'confirmed'))!.data).paused).to.equal(false);
  });

  it('disallowed vkey: detectorVersion not in allowed_vkeys', async () => {
    const blob = Buffer.from(BLOB);
    blob[64] ^= 0x01; // detectorVersion byte
    await expectError(send([await gatedIx({ blob })], [source]), 'DisallowedVkey');
  });

  it('unregistered policy root (allowlist mode on) — then registering it is accepted later', async () => {
    await send([buildSetConfigIx(authority.publicKey, { allowlistPolicies: true }, verify.programId)], [authority]);
    expect(decodeConfig((await conn.getAccountInfo(configPda, 'confirmed'))!.data).allowlistPolicies).to.equal(true);
    await expectError(send([await gatedIx()], [source]), 'UnregisteredPolicyRoot');
    await send([buildRegisterPolicyRootIx(authority.publicKey, POLICY_ROOT, verify.programId)], [authority]);
    // PolicyRoot layout: 8 disc ‖ 32 root ‖ u64 registered_at ‖ u8 bump
    const reg = await conn.getAccountInfo(policyPda(POLICY_ROOT), 'confirmed');
    expect(reg, 'PolicyRoot PDA exists').to.not.equal(null);
    expect(reg!.data.subarray(8, 40)).to.deep.equal(POLICY_ROOT);
    // allowlist stays ON for the remaining cases: the happy path proves a registered root passes.
  });

  it('expired: expirySlot < current slot', async () => {
    const blob = Buffer.from(BLOB);
    blob.writeBigUInt64LE(0n, 160);
    await expectError(send([await gatedIx({ blob })], [source]), 'Expired');
  });

  // Through the gate: the gate builds the action from the transfer it executes, so a different
  // recipient / amount / signing source is a different action.
  const other = Keypair.generate();
  for (const [name, ix, signers] of [
    ['wrong recipient', () => gatedIx({ recipient: Keypair.generate().publicKey }), [source]],
    ['wrong amount', () => gatedIx({ amount: AMOUNT.addn(1) }), [source]],
    ['wrong source authority', () => gatedIx({ source: other.publicKey }), [other]],
  ] as const) {
    it(`${name} (through the gate): actionHash mismatch`, async () => {
      await expectError(send([await ix()], [...signers]), 'ActionHashMismatch');
    });
  }
  // Mint and target program are fixed by the gate (native SOL, its own id), so they are reached
  // through the forwarder. The forwarder is the calling program, so the action's target must be
  // the forwarder to pass check 2 — the attestation binds transfer-gate, so the target alone is
  // already a wrong field, and the mint case changes the mint on top of it.
  for (const [name, mutate] of [
    ['wrong target program', (a: any) => (a.targetProgram = ROGUE)],
    ['wrong mint', (a: any) => { a.targetProgram = ROGUE; a.mint = Keypair.generate().publicKey; }],
  ] as const) {
    it(`${name} (through the forwarder): actionHash mismatch`, async () => {
      const a = baseAction();
      mutate(a);
      await expectError(send([viaRogue(await verifyIx(a))], [source]), 'ActionHashMismatch');
    });
  }

  it('wrong recipient / amount through the gate are also refused', async () => {
    await expectError(send([await gatedIx({ recipient: Keypair.generate().publicKey })], [source]), 'ActionHashMismatch');
    await expectError(send([await gatedIx({ amount: AMOUNT.subn(1) })], [source]), 'ActionHashMismatch');
  });

  it('malformed proof: Groth16 verify fails', async () => {
    const proof = Buffer.from(PROOF);
    proof[proof.length - 1] ^= 0x01;
    await expectError(send([await gatedIx({ proof })], [source]), 'InvalidProof');
  });

  it('direct top-level call to verify_and_consume is refused (DirectCallNotAllowed)', async () => {
    // the griefing path this closes: a copied proof + the same action fields, sent top-level
    await expectError(send([await verifyIx()], [source]), 'DirectCallNotAllowed');
    expect(await conn.getAccountInfo(nullifierPda(NULLIFIER))).to.equal(null);
  });

  it('CPI from a program other than action.targetProgram is refused (CallerNotTargetProgram)', async () => {
    // the attestation's own action (target = transfer-gate), forwarded by another program
    await expectError(send([viaRogue(await verifyIx())], [source]), 'CallerNotTargetProgram');
    expect(await conn.getAccountInfo(nullifierPda(NULLIFIER))).to.equal(null);
  });

  it('deeper nesting is refused (NestedCallNotAllowed): another program wrapping the gate, or two CPI levels', async () => {
    await expectError(send([viaRogue(await gatedIx())], [source]), 'NestedCallNotAllowed');
    await expectError(send([viaRogue(viaRogue(await verifyIx()))], [source]), 'NestedCallNotAllowed');
    expect(await conn.getAccountInfo(nullifierPda(NULLIFIER))).to.equal(null);
  });

  it('direct call to transfer-gate without the CPI (another program passed as verifier) fails', async () => {
    await expectError(send([await gatedIx({ verifyProgram: SystemProgram.programId })], [source]), 'InvalidProgramId');
  });

  it('atomicity: a failed gated transfer leaves the nullifier unconsumed', async () => {
    // Drain the source so it can pay the nullifier rent + fee but is 1 lamport short of `amount`.
    const rent = await conn.getMinimumBalanceForRentExemption(8 + 8 + 32 + 32 + 1);
    const bal = await conn.getBalance(source.publicKey, 'confirmed');
    const keep = rent + 10_000 + AMOUNT.toNumber() - 1;
    const drain = SystemProgram.transfer({ fromPubkey: source.publicKey, toPubkey: authority.publicKey, lamports: bal - keep });
    await send([drain], [source]);
    const tx = new Transaction().add(cu, await gatedIx());
    let failed = false;
    try { await provider.sendAndConfirm(tx, [source], { commitment: 'confirmed' }); } catch { failed = true; }
    expect(failed, 'transfer should fail for insufficient lamports').to.equal(true);
    expect(await conn.getAccountInfo(nullifierPda(NULLIFIER))).to.equal(null); // not consumed
    // refund from the provider wallet (mid-suite airdrops did not reliably land on this validator)
    await send([SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: source.publicKey, lamports: 2 * LAMPORTS_PER_SOL })], [authority]);
  });

  it('happy path: screened transfer executes, nullifier PDA created, event emitted; CU + tx size recorded', async () => {
    // independent of the atomicity test's drain: make sure the payer holds ≥ 1 SOL
    if ((await conn.getBalance(source.publicKey, 'confirmed')) < LAMPORTS_PER_SOL) {
      await send([SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: source.publicKey, lamports: 2 * LAMPORTS_PER_SOL })], [authority]);
    }
    console.log(`      balances: source ${await conn.getBalance(source.publicKey, 'confirmed')} recipient ${await conn.getBalance(recipient.publicKey, 'confirmed')} rent0 ${await conn.getMinimumBalanceForRentExemption(0)}`);
    const before = await conn.getBalance(recipient.publicKey, 'confirmed');
    // the SDK's builder (what submit() sends), so its account list is exercised on chain
    const tx = new Transaction().add(cu, buildGatedTransferIx(att, { source: source.publicKey, recipient: recipient.publicKey }));
    tx.feePayer = source.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(source);
    const sim = await conn.simulateTransaction(tx);
    expect(sim.value.err, `err=${JSON.stringify(sim.value.err)} logs=${JSON.stringify(sim.value.logs)}`).to.equal(null);
    const txSize = tx.serialize().length;
    const units = sim.value.unitsConsumed ?? 0;

    // already signed by `source` (the fee payer); send raw so the provider wallet is not added as a signer
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, 'confirmed');
    const after = await conn.getBalance(recipient.publicKey, 'confirmed');
    expect(after - before).to.equal(AMOUNT.toNumber());

    // Nullifier is written manually by the program (not via an Accounts struct), so it is not in
    // the IDL's account list; decode its fixed layout: 8 disc ‖ u64 slot ‖ 32 consumer ‖ 32 actionHash ‖ u8 bump.
    // consumer_program is the calling program the verifier read from the instructions sysvar.
    const info = await conn.getAccountInfo(nullifierPda(NULLIFIER), 'confirmed');
    expect(info, 'nullifier PDA exists').to.not.equal(null);
    expect(info!.owner.equals(verify.programId)).to.equal(true);
    const d = info!.data;
    expect(d.length).to.equal(81);
    expect(d.subarray(48, 80)).to.deep.equal(hex(att.actionHash));
    expect(new PublicKey(d.subarray(16, 48)).toBase58()).to.equal(gate.programId.toBase58());
    expect(Number(d.readBigUInt64LE(8))).to.be.greaterThan(0);
    const rec = decodeNullifier(d);
    expect(rec.consumerProgram.toBase58()).to.equal(gate.programId.toBase58());
    expect(rec.actionHash).to.equal(att.actionHash);

    const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    const parser = new anchor.EventParser(verify.programId, new anchor.BorshCoder(verify.idl));
    const events = [...parser.parseLogs(t!.meta!.logMessages!)];
    const consumed = events.find((e) => e.name === 'consumed');
    expect(consumed, 'Consumed event').to.not.equal(undefined);
    expect(Buffer.from(consumed!.data.nullifier as number[])).to.deep.equal(NULLIFIER);
    expect((consumed!.data.consumer as PublicKey).toBase58()).to.equal(gate.programId.toBase58());

    writeFileSync(join(ROOT, 'tests/m2-metrics.json'), JSON.stringify({
      measuredAt: new Date().toISOString(),
      cluster: 'localnet',
      gatedTransferCU: units,
      txBytes: txSize,
      proofBytes: PROOF.length,
      publicInputBytes: BLOB.length,
      anchor: '0.31.1', sp1Solana: '0.1.0', sp1: '5.0.0',
      tx: sig,
    }, null, 2) + '\n');
    console.log(`      gated transfer: ${units} CU, tx ${txSize} bytes`);
  });

  it('replayed nullifier: the same attestation is refused', async () => {
    await expectError(send([await gatedIx()], [source]), 'NullifierAlreadyConsumed');
  });
});
