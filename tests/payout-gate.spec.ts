// payout-gate suite (programs/payout-gate), run by scripts/test-m2.sh after m2.spec.ts on the same validator.
// A batch of SPL payouts where EVERY payout carries its own attestation, staged in a PDA beforehand
// (two inline Groth16 proofs do not fit one transaction; see the program header), and verified by one
// verify_and_consume CPI per payout with the action recomputed from the payout being executed.
//
// Fixtures. The committed localnet attestations (attestation-test.json, attestation-test-current.json) are
// screened for TRANSFER-GATE: through payout-gate they reach the verifier (the caller check passes — the gate
// names itself as target) and fail its actionHash recompute, which is exactly the "attestation for another
// action" refusal, and lets the staging, account and batch-shape checks run for real. The happy path, the
// amount-mismatch-inside-a-valid-batch and the replay cases need attestations screened for payout-gate
// (tests/fixtures/attestation-payout-{1,2}.json, scripts/prove-localnet-fixture.sh payout — a real ~2 h prove
// each); until they exist those cases are reported as PENDING, never as passed.
// Namespace imports only (see m2.spec.ts).
import * as anchorNs from '@coral-xyz/anchor';
import * as web3Ns from '@solana/web3.js';
import * as chaiNs from 'chai';
const cjs = <T,>(ns: T): T => ((ns as any).default ?? ns) as T;
const anchor = cjs(anchorNs) as typeof anchorNs;
const web3 = cjs(web3Ns) as typeof web3Ns;
const { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, SYSVAR_INSTRUCTIONS_PUBKEY } = web3;
type TransactionInstruction = web3Ns.TransactionInstruction;
type Keypair = web3Ns.Keypair;
type PublicKey = web3Ns.PublicKey;
type Program = anchorNs.Program;
const { AnchorError, BN } = anchor;
const { expect } = cjs(chaiNs) as typeof chaiNs;
import { buildInitializeIx, buildRegisterPolicyRootIx, decodeConfig, decodeNullifier, DEFAULT_POLICY_ROOT } from '../packages/sdk/src/ix';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const seeded = (label: string) => Keypair.fromSeed(createHash('sha256').update(`blindseal-localnet:${label}`).digest());
const hex = (s: string) => Buffer.from(s.replace(/^0x/, ''), 'hex');
const fixture = (name: string) => JSON.parse(readFileSync(join(ROOT, 'tests/fixtures', name), 'utf8'));
const optionalFixture = (name: string) => (existsSync(join(ROOT, 'tests/fixtures', name)) ? fixture(name) : undefined);

// Two distinct committed attestations (different nullifiers), both screened for transfer-gate.
const LEGACY = [fixture('attestation-test.json'), fixture('attestation-test-current.json')];
// The payout-gate attestations, when proven (scripts/prove-localnet-fixture.sh payout).
const PAYOUT = [optionalFixture('attestation-payout-1.json'), optionalFixture('attestation-payout-2.json')];
const HAVE_PAYOUT = PAYOUT.every((p) => p !== undefined);
const PENDING = (what: string) => console.log(`      PENDING: ${what} — needs tests/fixtures/attestation-payout-{1,2}.json (scripts/prove-localnet-fixture.sh payout)`);

// Seeded wallets (pubkeys stable across machines, so the payout proofs can bind them): the payer, two
// recipients and the mint. scripts/prove-localnet-fixture.sh lists the same keys.
const payer = seeded('payout-payer');
const recipients = [seeded('payout-recipient-1'), seeded('payout-recipient-2')];
const mintKp = seeded('payout-mint');
const PAYOUT_AMOUNTS = [new BN(250_000), new BN(750_000)];

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const ata = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
const u64 = (n: anchorNs.BN | number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n.toString())); return b; };
// spl-token instructions, hand-encoded (no @solana/spl-token in the workspace).
const initializeMint2 = (mint: PublicKey, authority: PublicKey, decimals: number) => new TransactionInstruction({
  programId: TOKEN_PROGRAM_ID,
  keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
  data: Buffer.concat([Buffer.from([20, decimals]), authority.toBuffer(), Buffer.from([0])]), // no freeze authority
});
const createAtaIdempotent = (funder: PublicKey, owner: PublicKey, mint: PublicKey) => new TransactionInstruction({
  programId: ASSOCIATED_TOKEN_PROGRAM_ID,
  keys: [
    { pubkey: funder, isSigner: true, isWritable: true }, { pubkey: ata(owner, mint), isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ],
  data: Buffer.from([1]),
});
const mintTo = (mint: PublicKey, dest: PublicKey, authority: PublicKey, amount: number) => new TransactionInstruction({
  programId: TOKEN_PROGRAM_ID,
  keys: [{ pubkey: mint, isSigner: false, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: authority, isSigner: true, isWritable: false }],
  data: Buffer.concat([Buffer.from([7]), u64(amount)]),
});

describe('payout-gate — batch of SPL payouts, one attestation each', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const verify = anchor.workspace.BlindsealVerify as Program;
  const gate = anchor.workspace.PayoutGate as Program;
  const authority = (provider.wallet as anchor.Wallet).payer;
  const mint = mintKp.publicKey;
  const otherMint = Keypair.generate(); // for the wrong-mint case

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from('config')], verify.programId);
  const policyPda = (root: Buffer) => PublicKey.findProgramAddressSync([Buffer.from('policy'), root], verify.programId)[0];
  const nullifierPda = (nf: Buffer) => PublicKey.findProgramAddressSync([Buffer.from('nullifier'), nf], verify.programId)[0];
  const stagedPda = (who: PublicKey, nf: Buffer) => PublicKey.findProgramAddressSync([Buffer.from('staged'), who.toBuffer(), nf], gate.programId)[0];
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

  const send = async (ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> => {
    const attempt = () => provider.sendAndConfirm(new Transaction().add(cu, ...ixs), signers, { commitment: 'confirmed' });
    for (let i = 0; ; i++) {
      try { return await attempt(); } catch (e: any) {
        if (i < 4 && /Blockhash not found/.test(String(e.message))) { await new Promise((r) => setTimeout(r, 800)); continue; }
        throw e;
      }
    }
  };
  const FRAMEWORK: Record<number, string> = { 3008: 'InvalidProgramId', 3010: 'AccountNotSigner', 2001: 'ConstraintHasOne', 2003: 'ConstraintRaw', 2012: 'ConstraintAddress' };
  const errorName = (e: any): string | undefined => {
    const logs: string[] = e.logs ?? e.transactionLogs ?? e.error?.logs ?? [];
    try { const p = AnchorError.parse(logs); if (p?.error?.errorCode?.code) return p.error.errorCode.code; } catch { /* no anchor line */ }
    if (e.error?.errorCode?.code) return e.error.errorCode.code;
    const text = logs.join('\n') + '\n' + String(e.message ?? e);
    const m = /custom program error: 0x([0-9a-f]+)/i.exec(text);
    if (m) {
      const n = parseInt(m[1], 16);
      if (n >= 7000) return (gate.idl as any).errors?.find((x: any) => x.code === n)?.name; // payout-gate (offset 7000)
      if (n >= 6000) return (verify.idl as any).errors?.[n - 6000]?.name;
      if (FRAMEWORK[n]) return FRAMEWORK[n];
    }
    return undefined;
  };
  const expectError = async (p: Promise<unknown>, code: string) => {
    let err: any = null;
    try { await p; } catch (e) { err = e; }
    if (!err) expect.fail(`expected failure ${code}, but the transaction succeeded`);
    const got = errorName(err);
    expect(got, `expected ${code}; message: ${String(err.message ?? err).slice(0, 300)}`).to.equal(code);
  };

  const tokenBalance = async (acc: PublicKey) => {
    const info = await conn.getAccountInfo(acc, 'confirmed');
    return info ? Number(info.data.readBigUInt64LE(64)) : 0;
  };

  const stageIx = (att: any, who: PublicKey = payer.publicKey) =>
    gate.methods
      .stageAttestation(hex(att.proof.bytes), hex(att.publicInputs[0]), Array.from(hex(att.nullifier)))
      .accounts({ payer: who, staged: stagedPda(who, hex(att.nullifier)), systemProgram: SystemProgram.programId })
      .instruction();
  const cancelIx = (att: any, who: PublicKey = payer.publicKey, staged = stagedPda(payer.publicKey, hex(att.nullifier))) =>
    gate.methods.cancelStage().accounts({ payer: who, staged }).instruction();

  interface Payout { att: any; amount: anchorNs.BN; recipientToken: PublicKey; staged?: PublicKey; nullifier?: PublicKey }
  const batchIx = (payouts: Payout[], o: { payer?: PublicKey; sourceToken?: PublicKey; mint?: PublicKey; remaining?: web3Ns.AccountMeta[] } = {}) =>
    gate.methods
      .batchPayout(payouts.map((p) => ({ nonce: Array.from(hex(p.att.nonce)), amount: p.amount })))
      .accounts({
        payer: o.payer ?? payer.publicKey,
        sourceToken: o.sourceToken ?? ata(payer.publicKey, mint),
        mint: o.mint ?? mint,
        config: configPda,
        policyRoot: policyPda(hex(DEFAULT_POLICY_ROOT)),
        verifyProgram: verify.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts(o.remaining ?? payouts.flatMap((p) => [
        { pubkey: p.staged ?? stagedPda(o.payer ?? payer.publicKey, hex(p.att.nullifier)), isSigner: false, isWritable: true },
        { pubkey: p.recipientToken, isSigner: false, isWritable: true },
        { pubkey: p.nullifier ?? nullifierPda(hex(p.att.nullifier)), isSigner: false, isWritable: true },
      ]))
      .instruction();

  before(async () => {
    for (const id of [verify.programId, gate.programId]) {
      for (let i = 0; i < 60; i++) {
        const info = await conn.getAccountInfo(id, 'confirmed');
        if (info?.executable) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    while ((await conn.getSlot('confirmed')) < 20) await new Promise((r) => setTimeout(r, 400));
    // the payer pays nullifier + staged rent and fees
    await send([SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: payer.publicKey, lamports: 2 * LAMPORTS_PER_SOL })], [authority]);

    // verifier Config + the default policy root: set up by m2.spec.ts when it ran first, else here (SDK defaults)
    if (!(await conn.getAccountInfo(configPda, 'confirmed'))) {
      await send([buildInitializeIx(authority.publicKey, undefined, undefined, verify.programId)], [authority]);
      await send([buildRegisterPolicyRootIx(authority.publicKey, hex(DEFAULT_POLICY_ROOT), verify.programId)], [authority]);
    }
    const cfg = decodeConfig((await conn.getAccountInfo(configPda, 'confirmed'))!.data);
    expect(cfg.paused).to.equal(false);
    expect(await conn.getAccountInfo(policyPda(hex(DEFAULT_POLICY_ROOT)), 'confirmed'), 'default policy root registered').to.not.equal(null);
    for (const f of LEGACY) { expect(cfg.allowedVkeys).to.include(f.detectorVersion); expect(f.policyRoot).to.equal(DEFAULT_POLICY_ROOT); }

    // the mint (seeded key, 6 decimals, authority = provider wallet), ATAs for payer + recipients, 10 tokens to the payer
    const rent = await conn.getMinimumBalanceForRentExemption(82);
    if (!(await conn.getAccountInfo(mint, 'confirmed'))) {
      await send([
        SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: mint, space: 82, lamports: rent, programId: TOKEN_PROGRAM_ID }),
        initializeMint2(mint, authority.publicKey, 6),
      ], [authority, mintKp]);
    }
    await send([
      SystemProgram.createAccount({ fromPubkey: authority.publicKey, newAccountPubkey: otherMint.publicKey, space: 82, lamports: rent, programId: TOKEN_PROGRAM_ID }),
      initializeMint2(otherMint.publicKey, authority.publicKey, 6),
    ], [authority, otherMint]);
    await send([
      createAtaIdempotent(authority.publicKey, payer.publicKey, mint),
      ...recipients.map((r) => createAtaIdempotent(authority.publicKey, r.publicKey, mint)),
      createAtaIdempotent(authority.publicKey, recipients[0].publicKey, otherMint.publicKey),
      mintTo(mint, ata(payer.publicKey, mint), authority.publicKey, 10_000_000),
    ], [authority]);
    expect(await tokenBalance(ata(payer.publicKey, mint))).to.be.at.least(10_000_000);
    if (HAVE_PAYOUT) {
      // the proven payout attestations must bind exactly what the suite executes
      PAYOUT.forEach((p, i) => {
        expect(p.action.targetProgram).to.equal(gate.programId.toBase58());
        expect(p.action.sourceAuthority).to.equal(payer.publicKey.toBase58());
        expect(p.action.recipient).to.equal(recipients[i].publicKey.toBase58());
        expect(p.action.mint).to.equal(mint.toBase58());
        expect(p.action.amount).to.equal(PAYOUT_AMOUNTS[i].toString());
      });
    }
  });

  it('stage_attestation: the PDA holds payer, proof and public inputs; a nullifier that is not the committed one is refused', async () => {
    // one stage per transaction: two proofs plus two blobs do not fit one (the reason staging exists)
    for (const att of LEGACY) await send([await stageIx(att)], [payer]);
    for (const att of LEGACY) {
      const info = await conn.getAccountInfo(stagedPda(payer.publicKey, hex(att.nullifier)), 'confirmed');
      expect(info, 'staged PDA exists').to.not.equal(null);
      expect(info!.owner.equals(gate.programId)).to.equal(true);
      // the Anchor TS client camel-cases IDL account names on construction ('staged'); look it up rather than assume
      const stagedName = (gate.idl as any).accounts.find((a: any) => a.name.toLowerCase() === 'staged').name as string;
      const s = gate.coder.accounts.decode(stagedName, info!.data) as any;
      expect((s.payer as PublicKey).toBase58()).to.equal(payer.publicKey.toBase58());
      expect(Buffer.from(s.proof)).to.deep.equal(hex(att.proof.bytes));
      expect(Buffer.from(s.publicInputs)).to.deep.equal(hex(att.publicInputs[0]));
    }
    // seed ≠ committed nullifier
    const wrong = Buffer.alloc(32, 9);
    const ix = await gate.methods
      .stageAttestation(hex(LEGACY[0].proof.bytes), hex(LEGACY[0].publicInputs[0]), Array.from(wrong))
      .accounts({ payer: payer.publicKey, staged: stagedPda(payer.publicKey, wrong), systemProgram: SystemProgram.programId })
      .instruction();
    await expectError(send([ix], [payer]), 'NullifierSeedMismatch');
    // a blob that is not 168 bytes
    const short = await gate.methods
      .stageAttestation(hex(LEGACY[0].proof.bytes), hex(LEGACY[0].publicInputs[0]).subarray(0, 100), Array.from(wrong))
      .accounts({ payer: payer.publicKey, staged: stagedPda(payer.publicKey, wrong), systemProgram: SystemProgram.programId })
      .instruction();
    await expectError(send([short], [payer]), 'BadPublicInputs');
  });

  it('a batch whose attestations were screened for another program (transfer-gate) is refused by the verifier: ActionHashMismatch, nothing moves', async () => {
    const before = await Promise.all(recipients.map((r) => tokenBalance(ata(r.publicKey, mint))));
    // the verifier's actionHash check (step 7) comes before the nullifier check (step 8), so this is the error
    // whether or not m2.spec.ts, run first on this validator, has already consumed these attestations through
    // transfer-gate; the nullifier accounts must simply be unchanged by the attempt.
    const nullifiersBefore = await Promise.all(LEGACY.map((att) => conn.getAccountInfo(nullifierPda(hex(att.nullifier)), 'confirmed')));
    const payouts: Payout[] = LEGACY.map((att, i) => ({ att, amount: new BN(att.action.amount), recipientToken: ata(recipients[i].publicKey, mint) }));
    await expectError(send([await batchIx(payouts)], [payer]), 'ActionHashMismatch');
    expect(await Promise.all(recipients.map((r) => tokenBalance(ata(r.publicKey, mint))))).to.deep.equal(before);
    for (const [i, att] of LEGACY.entries()) {
      const after = await conn.getAccountInfo(nullifierPda(hex(att.nullifier)), 'confirmed');
      expect(after?.data.toString('hex') ?? null, 'nullifier account unchanged').to.equal(nullifiersBefore[i]?.data.toString('hex') ?? null);
      if (after) expect(decodeNullifier(after.data).consumerProgram.toBase58(), 'consumed earlier by transfer-gate, never by payout-gate').to.not.equal(gate.programId.toBase58());
      expect(await conn.getAccountInfo(stagedPda(payer.publicKey, hex(att.nullifier)), 'confirmed'), 'staged account kept').to.not.equal(null);
    }
  });

  it('gate checks before any CPI: wrong-mint destination, source not the payer\'s, wrong account count, empty batch, policy root', async () => {
    const good: Payout = { att: LEGACY[0], amount: new BN(1), recipientToken: ata(recipients[0].publicKey, mint) };
    await expectError(send([await batchIx([{ ...good, recipientToken: ata(recipients[0].publicKey, otherMint.publicKey) }])], [payer]), 'WrongMint');
    await expectError(send([await batchIx([{ ...good, recipientToken: mint }])], [payer]), 'NotTokenAccount'); // the mint is not a token account
    await expectError(send([await batchIx([good], { sourceToken: ata(recipients[0].publicKey, mint) })], [payer]), 'SourceNotPayers');
    await expectError(send([await batchIx([good], { remaining: [{ pubkey: stagedPda(payer.publicKey, hex(LEGACY[0].nullifier)), isSigner: false, isWritable: true }] })], [payer]), 'WrongAccountCount');
    await expectError(send([await batchIx([], { remaining: [] })], [payer]), 'EmptyBatch');
    // a staged account that is not the payer's: staged by a stranger, spent by the payer
    const stranger = Keypair.generate();
    await send([SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: stranger.publicKey, lamports: LAMPORTS_PER_SOL / 10 })], [authority]);
    await send([await stageIx(LEGACY[0], stranger.publicKey)], [stranger]);
    await expectError(send([await batchIx([{ ...good, staged: stagedPda(stranger.publicKey, hex(LEGACY[0].nullifier)) }])], [payer]), 'StagedNotPayers');
    // an unexpected policy root: a blob with a flipped root byte (the gate refuses before the verifier). Its
    // nullifier is LEGACY[0]'s, so that staged slot is freed first and restored after.
    const blob = Buffer.from(hex(LEGACY[0].publicInputs[0])); blob[32] ^= 1;
    const nf = blob.subarray(128, 160);
    const slot = stagedPda(payer.publicKey, nf);
    await send([await cancelIx(LEGACY[0])], [payer]);
    await send([await gate.methods.stageAttestation(hex(LEGACY[0].proof.bytes), blob, Array.from(nf)).accounts({ payer: payer.publicKey, staged: slot, systemProgram: SystemProgram.programId }).instruction()], [payer]);
    await expectError(send([await batchIx([good])], [payer]), 'UnexpectedPolicyRoot');
    await send([await cancelIx(LEGACY[0])], [payer]);
    await send([await stageIx(LEGACY[0])], [payer]);
  });

  it('cancel_stage: only the staging payer can cancel, and gets the rent back', async () => {
    const staged = stagedPda(payer.publicKey, hex(LEGACY[1].nullifier));
    const stranger = Keypair.generate();
    await send([SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: stranger.publicKey, lamports: LAMPORTS_PER_SOL / 10 })], [authority]);
    await expectError(send([await cancelIx(LEGACY[1], stranger.publicKey, staged)], [stranger]), 'StagedNotPayers');
    const rent = (await conn.getAccountInfo(staged, 'confirmed'))!.lamports;
    const before = await conn.getBalance(payer.publicKey, 'confirmed');
    await send([await cancelIx(LEGACY[1])], [payer]);
    expect(await conn.getAccountInfo(staged, 'confirmed')).to.equal(null);
    expect((await conn.getBalance(payer.publicKey, 'confirmed')) - before).to.equal(rent); // the provider wallet pays the fee
  });

  it('one payout with the wrong amount fails the whole batch (ActionHashMismatch); the other payout\'s nullifier stays unconsumed', async function () {
    if (!HAVE_PAYOUT) {
      PENDING('amount mismatch inside an otherwise valid batch');
      // the same refusal is reachable with the legacy fixture: a payout whose amount differs from its attestation
      const wrong: Payout = { att: LEGACY[0], amount: new BN(LEGACY[0].action.amount).addn(1), recipientToken: ata(recipients[0].publicKey, mint) };
      await expectError(send([await batchIx([wrong])], [payer]), 'ActionHashMismatch');
      return this.skip();
    }
    for (const att of PAYOUT) await send([await stageIx(att)], [payer]);
    const payouts: Payout[] = PAYOUT.map((att, i) => ({ att, amount: PAYOUT_AMOUNTS[i], recipientToken: ata(recipients[i].publicKey, mint) }));
    payouts[1].amount = PAYOUT_AMOUNTS[1].addn(1);
    const before = await Promise.all(recipients.map((r) => tokenBalance(ata(r.publicKey, mint))));
    await expectError(send([await batchIx(payouts)], [payer]), 'ActionHashMismatch');
    expect(await Promise.all(recipients.map((r) => tokenBalance(ata(r.publicKey, mint))))).to.deep.equal(before);
    expect(await conn.getAccountInfo(nullifierPda(hex(PAYOUT[0].nullifier)), 'confirmed'), 'the valid payout is rolled back too').to.equal(null);
  });

  it('happy path: two payouts in one transaction, both nullifiers consumed by payout-gate, staged accounts closed, tokens moved', async function () {
    if (!HAVE_PAYOUT) { PENDING('batch of two valid payouts'); return this.skip(); }
    const payouts: Payout[] = PAYOUT.map((att, i) => ({ att, amount: PAYOUT_AMOUNTS[i], recipientToken: ata(recipients[i].publicKey, mint) }));
    const before = await Promise.all(recipients.map((r) => tokenBalance(ata(r.publicKey, mint))));
    const payerBefore = await tokenBalance(ata(payer.publicKey, mint));
    const tx = new Transaction().add(cu, await batchIx(payouts));
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(payer);
    const sim = await conn.simulateTransaction(tx);
    expect(sim.value.err, `err=${JSON.stringify(sim.value.err)} logs=${JSON.stringify(sim.value.logs)}`).to.equal(null);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, 'confirmed');
    console.log(`      batch of 2: ${sim.value.unitsConsumed} CU, tx ${tx.serialize().length} bytes`);
    const after = await Promise.all(recipients.map((r) => tokenBalance(ata(r.publicKey, mint))));
    expect(after.map((a, i) => a - before[i])).to.deep.equal(PAYOUT_AMOUNTS.map((a) => a.toNumber()));
    expect(payerBefore - (await tokenBalance(ata(payer.publicKey, mint)))).to.equal(PAYOUT_AMOUNTS[0].toNumber() + PAYOUT_AMOUNTS[1].toNumber());
    for (const att of PAYOUT) {
      const rec = decodeNullifier((await conn.getAccountInfo(nullifierPda(hex(att.nullifier)), 'confirmed'))!.data);
      expect(rec.consumerProgram.toBase58()).to.equal(gate.programId.toBase58());
      expect(rec.actionHash).to.equal(att.actionHash);
      expect(await conn.getAccountInfo(stagedPda(payer.publicKey, hex(att.nullifier)), 'confirmed'), 'staged account closed').to.equal(null);
    }
  });

  it('replay: a consumed attestation, staged again, is refused (NullifierAlreadyConsumed)', async function () {
    if (!HAVE_PAYOUT) { PENDING('replay of a consumed payout attestation'); return this.skip(); }
    await send([await stageIx(PAYOUT[0])], [payer]);
    const payouts: Payout[] = [{ att: PAYOUT[0], amount: PAYOUT_AMOUNTS[0], recipientToken: ata(recipients[0].publicKey, mint) }];
    await expectError(send([await batchIx(payouts)], [payer]), 'NullifierAlreadyConsumed');
    await send([await cancelIx(PAYOUT[0])], [payer]);
  });
});
