// 0.8.0 Config migration rehearsal, run by scripts/test-fee-migration.sh: the validator holds the verifier AS
// DEPLOYED (upgradeable, authority = the provider wallet) and transfer-gate from the new build. In order:
//   1. initialize under the old program → a 303-byte Config (what mainnet holds);
//   2. upgrade the verifier in place to the new binary (`solana program deploy`, auto-extends ProgramData);
//   3. the new program reads the legacy account: set_config round-trips, decodeConfig says fee 0 / no treasury,
//      and the legacy fixture consumes at fee 0 with the fee payer in the treasury slot;
//   4. set_fee(0, treasury) grows the account to 343 bytes, the authority paying exactly the rent difference;
//   5. set_fee(FEE, treasury); the current-vkey fixture consumes and moves exactly FEE lamports.
// Namespace imports only (see tests/m2.spec.ts).
import * as anchorNs from '@coral-xyz/anchor';
import * as web3Ns from '@solana/web3.js';
import * as chaiNs from 'chai';
const cjs = <T,>(ns: T): T => ((ns as any).default ?? ns) as T;
const anchor = cjs(anchorNs) as typeof anchorNs;
const web3 = cjs(web3Ns) as typeof web3Ns;
const { ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } = web3;
type Keypair = web3Ns.Keypair;
type PublicKey = web3Ns.PublicKey;
type TransactionInstruction = web3Ns.TransactionInstruction;
const { expect } = cjs(chaiNs) as typeof chaiNs;
import {
  buildInitializeIx, buildRegisterPolicyRootIx, buildSetConfigIx, buildSetFeeIx, buildGatedTransferIx, decodeConfig, decodeNullifier,
  treasuryAccount, configPda, nullifierPda, PROGRAM_ID, CONFIG_SIZE, CONFIG_SIZE_LEGACY,
} from '../packages/sdk/src/ix';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const seeded = (label: string) => Keypair.fromSeed(createHash('sha256').update(`blindseal-localnet:${label}`).digest());
const hex = (s: string) => Buffer.from(s.replace(/^0x/, ''), 'hex');
const att = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/attestation-test.json'), 'utf8'));
const currentPath = join(ROOT, 'tests/fixtures/attestation-test-current.json');
const ATT_CURRENT = existsSync(currentPath) ? JSON.parse(readFileSync(currentPath, 'utf8')) : undefined;
const source = seeded('source-authority');
const recipient = seeded('recipient');
const treasury = seeded('treasury');
const FEE = 12_345;
const NEW_SO = process.env.BLINDSEAL_NEW_VERIFY_SO;
if (!NEW_SO) throw new Error('BLINDSEAL_NEW_VERIFY_SO is not set — run via scripts/test-fee-migration.sh');

describe('0.8.0 Config migration: deployed verifier → new build', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const conn = provider.connection;
  const wallet = (provider.wallet as anchorNs.Wallet).payer; // fee payer of every admin tx, and the upgrade authority
  // The Config authority is a fresh key with a few SOL: the provider wallet holds the validator's mint (~5e17
  // lamports), beyond the range the RPC's JSON numbers represent exactly, so its balances cannot be asserted.
  const authority = Keypair.generate();
  const CONFIG = configPda();
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
  const balance = (k: PublicKey) => conn.getBalance(k, 'confirmed');
  const cfgInfo = async () => (await conn.getAccountInfo(CONFIG, 'confirmed'))!;
  const send = async (ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> => {
    for (let i = 0; ; i++) {
      try { return await provider.sendAndConfirm(new Transaction().add(cu, ...ixs), signers, { commitment: 'confirmed' }); } catch (e: any) {
        if (i < 4 && /Blockhash not found/.test(String(e.message))) { await new Promise((r) => setTimeout(r, 800)); continue; }
        throw e;
      }
    }
  };
  const consume = async (a: any, treasurySlot: PublicKey) => {
    const tx = new Transaction().add(cu, buildGatedTransferIx(a, { source: source.publicKey, recipient: recipient.publicKey, treasury: treasurySlot }));
    tx.feePayer = source.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.sign(source);
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction(sig, 'confirmed');
    return (await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))!.meta!.fee;
  };
  const nullifierRent = () => conn.getMinimumBalanceForRentExemption(8 + 8 + 32 + 32 + 1);

  before(async () => {
    while ((await conn.getSlot('confirmed')) < 20) await new Promise((r) => setTimeout(r, 400));
    for (const [k, l] of [[source.publicKey, 2 * LAMPORTS_PER_SOL], [recipient.publicKey, LAMPORTS_PER_SOL / 100], [treasury.publicKey, LAMPORTS_PER_SOL / 100], [authority.publicKey, 5 * LAMPORTS_PER_SOL]] as const) {
      await conn.confirmTransaction(await conn.requestAirdrop(k, l), 'confirmed');
    }
  });

  it('1. the deployed program writes a 303-byte Config; decodeConfig reads it as fee 0 / no treasury', async () => {
    await send([buildInitializeIx(authority.publicKey), buildRegisterPolicyRootIx(authority.publicKey, hex(att.policyRoot))], [authority]);
    const info = await cfgInfo();
    expect(info.data.length).to.equal(CONFIG_SIZE_LEGACY);
    const c = decodeConfig(info.data);
    expect(c.hasFeeFields).to.equal(false);
    expect(c.feeLamports).to.equal(0n);
    expect(c.treasury).to.equal(PublicKey.default.toBase58());
    expect(c.allowlistPolicies).to.equal(true);
    // the deployed program does not know set_fee
    let err: any = null;
    try { await send([buildSetFeeIx(authority.publicKey, 0, treasury.publicKey)], [authority]); } catch (e) { err = e; }
    expect(err, 'set_fee is refused by the old program').to.not.equal(null);
  });

  it('2. upgrade the verifier in place (solana program deploy, ProgramData extended)', async function () {
    this.timeout(600_000);
    const before = (await conn.getAccountInfo(PROGRAM_ID, 'confirmed'))!;
    const out = execFileSync('solana', [
      'program', 'deploy', NEW_SO!, '--program-id', PROGRAM_ID.toBase58(), '--upgrade-authority', process.env.ANCHOR_WALLET!,
      '-k', process.env.ANCHOR_WALLET!, '-u', process.env.ANCHOR_PROVIDER_URL!, '--commitment', 'confirmed',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    console.log('      ' + out.trim().split('\n').join('\n      '));
    expect(out).to.match(/Program Id: 6z4Heh/);
    // the program account itself is unchanged; ProgramData now holds the new binary (size ≥ new .so)
    const programData = new PublicKey((await conn.getAccountInfo(PROGRAM_ID, 'confirmed'))!.data.subarray(4, 36));
    const pd = (await conn.getAccountInfo(programData, 'confirmed'))!;
    const newSize = readFileSync(NEW_SO!).length;
    console.log(`      ProgramData ${programData.toBase58()}: ${pd.data.length - 45} bytes of program space for a ${newSize}-byte binary`);
    expect(pd.data.length - 45).to.be.at.least(newSize);
    expect(before.executable).to.equal(true);
    // an upgraded program is not invokable in the slot it was deployed in
    const slot = await conn.getSlot('confirmed');
    while ((await conn.getSlot('confirmed')) < slot + 2) await new Promise((r) => setTimeout(r, 400));
  });

  it('3. the new program reads the legacy account: set_config round-trips, the legacy fixture consumes at fee 0', async () => {
    await send([buildSetConfigIx(authority.publicKey, { paused: true })], [authority]);
    expect(decodeConfig((await cfgInfo()).data).paused).to.equal(true);
    await send([buildSetConfigIx(authority.publicKey, { paused: false })], [authority]);
    const info = await cfgInfo();
    expect(info.data.length, 'set_config does not resize').to.equal(CONFIG_SIZE_LEGACY);
    const c = decodeConfig(info.data);
    expect(c.paused).to.equal(false);
    expect(c.feeLamports).to.equal(0n);
    const slot = treasuryAccount(c.treasury, source.publicKey);
    expect(slot.equals(source.publicKey), 'no treasury configured: the fee payer fills the slot').to.equal(true);
    const [s0, t0] = [await balance(source.publicKey), await balance(treasury.publicKey)];
    const fee = await consume(att, slot);
    expect(s0 - (await balance(source.publicKey))).to.equal(fee + (await nullifierRent()) + Number(att.action.amount));
    expect(await balance(treasury.publicKey)).to.equal(t0);
    const rec = decodeNullifier((await conn.getAccountInfo(nullifierPda(hex(att.nullifier)), 'confirmed'))!.data);
    expect(rec.actionHash).to.equal(att.actionHash);
  });

  it('4. set_fee(0, treasury) grows the account 303 → 343 bytes; the authority pays exactly the rent difference', async () => {
    const [rentOld, rentNew] = [await conn.getMinimumBalanceForRentExemption(CONFIG_SIZE_LEGACY), await conn.getMinimumBalanceForRentExemption(CONFIG_SIZE)];
    const infoBefore = await cfgInfo();
    expect(infoBefore.lamports).to.equal(rentOld);
    const a0 = await balance(authority.publicKey);
    const sig = await send([buildSetFeeIx(authority.publicKey, 0, treasury.publicKey)], [authority]);
    const info = await cfgInfo();
    expect(info.data.length).to.equal(CONFIG_SIZE);
    expect(info.lamports).to.equal(rentNew);
    // per-transaction accounting from the transaction itself: the authority (fee payer, index 0) pays the
    // rent difference plus the fee, and the Config account receives exactly the difference
    const t = (await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))!;
    const keys = t.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
    const delta = (k: PublicKey) => { const i = keys.indexOf(k.toBase58()); return t.meta!.postBalances[i]! - t.meta!.preBalances[i]!; };
    console.log(`      rent ${rentOld} → ${rentNew} (+${rentNew - rentOld} lamports at local rent; mainnet: 40 × 5,080 = 203,200); tx fee ${t.meta!.fee} (paid by the wallet)`);
    expect(-delta(authority.publicKey), 'the authority pays exactly the rent difference').to.equal(rentNew - rentOld);
    expect(delta(CONFIG)).to.equal(rentNew - rentOld);
    expect(await balance(authority.publicKey)).to.equal(a0 - (rentNew - rentOld));
    const c = decodeConfig(info.data);
    expect(c.hasFeeFields).to.equal(true);
    expect(c.feeLamports).to.equal(0n);
    expect(c.treasury).to.equal(treasury.publicKey.toBase58());
    expect(c.allowlistPolicies).to.equal(true);
    expect(c.paused).to.equal(false);
    expect(c.allowedVkeys).to.deep.equal(decodeConfig(infoBefore.data).allowedVkeys);
    expect(c.bump).to.equal(decodeConfig(infoBefore.data).bump);
  });

  it('5. set_fee(FEE, treasury); a consume moves exactly FEE lamports to the treasury', async function () {
    if (!ATT_CURRENT) { console.log('      PENDING: tests/fixtures/attestation-test-current.json not present'); return this.skip(); }
    await send([buildSetFeeIx(authority.publicKey, FEE, treasury.publicKey)], [authority]);
    const c = decodeConfig((await cfgInfo()).data);
    expect(c.feeLamports).to.equal(BigInt(FEE));
    const slot = treasuryAccount(c.treasury, source.publicKey);
    expect(slot.equals(treasury.publicKey)).to.equal(true);
    const [s0, t0, r0] = [await balance(source.publicKey), await balance(treasury.publicKey), await balance(recipient.publicKey)];
    const fee = await consume(ATT_CURRENT, slot);
    expect((await balance(treasury.publicKey)) - t0).to.equal(FEE);
    expect((await balance(recipient.publicKey)) - r0).to.equal(Number(ATT_CURRENT.action.amount));
    expect(s0 - (await balance(source.publicKey))).to.equal(fee + (await nullifierRent()) + Number(ATT_CURRENT.action.amount) + FEE);
    // a second set_fee on the grown account is a plain field write (no resize, no rent)
    const l0 = (await cfgInfo()).lamports;
    await send([buildSetFeeIx(authority.publicKey, 0, treasury.publicKey)], [authority]);
    const info = await cfgInfo();
    expect(info.data.length).to.equal(CONFIG_SIZE);
    expect(info.lamports).to.equal(l0);
    expect(decodeConfig(info.data).feeLamports).to.equal(0n);
  });
});
