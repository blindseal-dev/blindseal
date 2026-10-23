// M2 verifier suite (BLINDSEAL.md §3.7 "Done when"), run by `anchor test` on localnet.
// One real Groth16 attestation (tests/fixtures/attestation-test.json, produced by
// crates/prover for the fixed keys in keys/localnet) covers every case: the verifier's checks
// are ordered BEFORE the Groth16 step, so each negative case is reached with the real proof
// and a crafted action / public-inputs blob, and fails with its own error.
import * as anchor from '@coral-xyz/anchor';
import { Program, AnchorError, BN } from '@coral-xyz/anchor';
import { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { expect } from 'chai';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const kp = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(ROOT, 'keys/localnet', f), 'utf8'))));
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

const source = kp('test-source-authority.json');
const recipient = kp('test-recipient.json');

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

  // Direct submission (what SDK submit / CLI submit do).
  const directIx = async (action = baseAction(), blob = BLOB, proof = PROOF, withPolicy = true) =>
    verify.methods
      .verifyAndConsume(proof, blob, action)
      .accounts({
        config: configPda,
        policyRoot: withPolicy ? policyPda(blob.subarray(32, 64)) : null,
        nullifier: nullifierPda(blob.subarray(128, 160)),
        payer: source.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

  const send = async (ixs: TransactionInstruction[], signers: Keypair[]) => {
    const tx = new Transaction().add(cu, ...ixs);
    return provider.sendAndConfirm(tx, signers, { commitment: 'confirmed' });
  };

  const expectError = async (p: Promise<unknown>, code: string) => {
    try {
      await p;
    } catch (e: any) {
      const logs: string[] = e.logs ?? e.error?.logs ?? [];
      let parsed: AnchorError | null = null;
      try { parsed = AnchorError.parse(logs); } catch { /* not anchor-formatted */ }
      const got = parsed?.error?.errorCode?.code ?? e.error?.errorCode?.code;
      if (got === code) return;
      const joined = logs.join('\n') + '\n' + String(e.message ?? e);
      expect(joined, `expected ${code}`).to.match(new RegExp(code));
      return;
    }
    expect.fail(`expected failure ${code}, but the transaction succeeded`);
  };

  const gatedIx = async (opts: { recipient?: PublicKey; amount?: BN; verifyProgram?: PublicKey; proof?: Buffer; blob?: Buffer } = {}) =>
    gate.methods
      .gatedTransfer(opts.proof ?? PROOF, opts.blob ?? BLOB, Array.from(NONCE), opts.amount ?? AMOUNT)
      .accounts({
        source: source.publicKey,
        recipient: opts.recipient ?? recipient.publicKey,
        config: configPda,
        policyRoot: policyPda(POLICY_ROOT),
        nullifier: nullifierPda(NULLIFIER),
        verifyProgram: opts.verifyProgram ?? verify.programId,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

  before(async () => {
    expect(BLOB.length).to.equal(168);
    const sig = await conn.requestAirdrop(source.publicKey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
    await verify.methods
      .initialize([Array.from(VKEY)], false)
      .accounts({ config: configPda, authority: authority.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    const cfg: any = await verify.account.config.fetch(configPda);
    expect(cfg.paused).to.equal(false);
    expect(cfg.allowlistPolicies).to.equal(false);
  });

  it('paused: verify_and_consume is refused while paused', async () => {
    await verify.methods.setConfig(null, null, true).accounts({ config: configPda, authority: authority.publicKey }).rpc();
    await expectError(send([await directIx(baseAction(), BLOB, PROOF, false)], [source]), 'Paused');
    await verify.methods.setConfig(null, null, false).accounts({ config: configPda, authority: authority.publicKey }).rpc();
  });

  it('disallowed vkey: detectorVersion not in allowed_vkeys', async () => {
    const blob = Buffer.from(BLOB);
    blob[64] ^= 0x01; // detectorVersion byte
    await expectError(send([await directIx(baseAction(), blob, PROOF, false)], [source]), 'DisallowedVkey');
  });

  it('unregistered policy root (allowlist mode on) — then registering it is accepted later', async () => {
    await verify.methods.setConfig(null, true, null).accounts({ config: configPda, authority: authority.publicKey }).rpc();
    await expectError(send([await directIx()], [source]), 'UnregisteredPolicyRoot');
    await verify.methods
      .registerPolicyRoot(Array.from(POLICY_ROOT))
      .accounts({ config: configPda, policyRoot: policyPda(POLICY_ROOT), authority: authority.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
    const reg: any = await verify.account.policyRoot.fetch(policyPda(POLICY_ROOT));
    expect(Buffer.from(reg.root)).to.deep.equal(POLICY_ROOT);
    // allowlist stays ON for the remaining cases: the happy path proves a registered root passes.
  });

  it('expired: expirySlot < current slot', async () => {
    const blob = Buffer.from(BLOB);
    blob.writeBigUInt64LE(0n, 160);
    await expectError(send([await directIx(baseAction(), blob)], [source]), 'Expired');
  });

  for (const [name, mutate] of [
    ['wrong recipient', (a: any) => (a.recipient = Keypair.generate().publicKey)],
    ['wrong amount', (a: any) => (a.amount = AMOUNT.addn(1))],
    ['wrong mint', (a: any) => (a.mint = Keypair.generate().publicKey)],
    ['wrong target program', (a: any) => (a.targetProgram = SystemProgram.programId)],
    ['wrong source authority', (a: any) => (a.sourceAuthority = Keypair.generate().publicKey)],
  ] as const) {
    it(`${name}: actionHash mismatch`, async () => {
      const a = baseAction();
      mutate(a);
      await expectError(send([await directIx(a)], [source]), 'ActionHashMismatch');
    });
  }

  it('wrong recipient / amount through the gate are also refused', async () => {
    await expectError(send([await gatedIx({ recipient: Keypair.generate().publicKey })], [source]), 'ActionHashMismatch');
    await expectError(send([await gatedIx({ amount: AMOUNT.subn(1) })], [source]), 'ActionHashMismatch');
  });

  it('malformed proof: Groth16 verify fails', async () => {
    const proof = Buffer.from(PROOF);
    proof[proof.length - 1] ^= 0x01;
    await expectError(send([await directIx(baseAction(), BLOB, proof)], [source]), 'InvalidProof');
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
    const top = await conn.requestAirdrop(source.publicKey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(top, 'confirmed');
  });

  it('happy path: screened transfer executes, nullifier PDA created, event emitted; CU + tx size recorded', async () => {
    const before = await conn.getBalance(recipient.publicKey, 'confirmed');
    const tx = new Transaction().add(cu, await gatedIx());
    tx.feePayer = source.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(source);
    const sim = await conn.simulateTransaction(tx);
    expect(sim.value.err, JSON.stringify(sim.value.logs)).to.equal(null);
    const txSize = tx.serialize().length;
    const units = sim.value.unitsConsumed ?? 0;

    const sig = await provider.sendAndConfirm(tx, [source], { commitment: 'confirmed' });
    const after = await conn.getBalance(recipient.publicKey, 'confirmed');
    expect(after - before).to.equal(AMOUNT.toNumber());

    // Nullifier is written manually by the program (not via an Accounts struct), so it is not in
    // the IDL's account list; decode its fixed layout: 8 disc ‖ u64 slot ‖ 32 consumer ‖ 32 actionHash ‖ u8 bump.
    const info = await conn.getAccountInfo(nullifierPda(NULLIFIER), 'confirmed');
    expect(info, 'nullifier PDA exists').to.not.equal(null);
    expect(info!.owner.equals(verify.programId)).to.equal(true);
    const d = info!.data;
    expect(d.length).to.equal(81);
    expect(d.subarray(48, 80)).to.deep.equal(hex(att.actionHash));
    expect(new PublicKey(d.subarray(16, 48)).toBase58()).to.equal(gate.programId.toBase58());
    expect(Number(d.readBigUInt64LE(8))).to.be.greaterThan(0);

    const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    const parser = new anchor.EventParser(verify.programId, new anchor.BorshCoder(verify.idl));
    const events = [...parser.parseLogs(t!.meta!.logMessages!)];
    const consumed = events.find((e) => e.name === 'consumed');
    expect(consumed, 'Consumed event').to.not.equal(undefined);
    expect(Buffer.from(consumed!.data.nullifier as number[])).to.deep.equal(NULLIFIER);

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
    await expectError(send([await directIx()], [source]), 'NullifierAlreadyConsumed');
  });
});
