// The plugin with a fake wallet and a fake chain. The wallet's key is the 0.7.0 fixture's source
// authority (we hold no secret for it; the fake wallet "signs" by recording the call), so the real proof
// covers a real transfer: 1_000_000 lamports to the fixture's recipient.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, type Connection } from '@solana/web3.js';
import { PROGRAM_ID, nullifierPda, hex, type Attestation } from 'blindseal-sdk';
import {
  ASSOCIATED_TOKEN_ID, COMPUTE_BUDGET_ID, SPL_TOKEN_ID, AttestationRefusedError, AttestationStore, TransferRefusedError,
  associatedTokenAddress, blindsealPlugin, buildTransfer, guardTransaction, guardWallet, instructionsOf, transfersOf,
  type AgentLike, type BaseWallet, type ChainReader, type Plugin,
} from '../src/index.js';

const FIXTURE = JSON.parse(readFileSync(join(__dirname, '../../../tests/fixtures/attestation-mainnet-demo-0.7.0.json'), 'utf8')) as Attestation;
const SOURCE = new PublicKey(FIXTURE.action.sourceAuthority);
const RECIPIENT = new PublicKey(FIXTURE.action.recipient);
const AMOUNT = BigInt(FIXTURE.action.amount);
const NF_PDA = nullifierPda(hex(FIXTURE.nullifier), PROGRAM_ID);
const LIVE = Number(FIXTURE.expirySlot) - 10;
const BLOCKHASH = 'EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k';

/** A chain at `slot`; `accounts` are returned by address (token accounts, nullifier records). */
const chainAt = (slot: number, accounts: Array<[PublicKey, { owner: PublicKey; data: Uint8Array }]> = []): ChainReader => ({
  async getAccountInfo(a) { return accounts.find(([k]) => k.equals(a))?.[1] ?? null; },
  async getSlot() { return slot; },
});
const tokenAccount = (mint: PublicKey, owner: PublicKey) => {
  const d = new Uint8Array(165); d.set(mint.toBytes(), 0); d.set(owner.toBytes(), 32); d[108] = 1;
  return { owner: SPL_TOKEN_ID, data: d };
};

/** The fake wallet: records every signing call, signs nothing. */
const fakeWallet = (publicKey = SOURCE) => {
  const calls: string[] = [];
  const wallet: BaseWallet = {
    publicKey,
    async signTransaction(tx) { calls.push('sign'); return tx; },
    async signAllTransactions(txs) { calls.push(`signAll:${txs.length}`); return txs; },
    signAndSendTransaction: async () => { calls.push('signAndSend'); return { signature: 'sig' }; },
    async signMessage(m) { calls.push('message'); return m; },
    sendTransaction: async () => { calls.push('send'); return 'sig'; },
  };
  return { wallet, calls };
};
const solTransfer = (lamports: bigint | number = AMOUNT, to = RECIPIENT, from = SOURCE) => {
  const tx = new Transaction({ recentBlockhash: BLOCKHASH, feePayer: from }).add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }));
  return tx;
};
const v0 = (ixs: TransactionInstruction[], payer = SOURCE) =>
  new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message());

describe('guardWallet', () => {
  it('signs a SOL transfer covered by a valid, live, unconsumed attestation and then forgets the attestation', async () => {
    const { wallet, calls } = fakeWallet();
    const store = new AttestationStore();
    store.add(Buffer.from(JSON.stringify(FIXTURE)).toString('base64'));
    const guarded = guardWallet(wallet, { chain: chainAt(LIVE), store });
    expect(guarded.publicKey.equals(SOURCE)).toBe(true);
    await guarded.signTransaction(solTransfer());
    expect(calls).toEqual(['sign']);
    expect(store.size).toBe(0);
    // the same transfer again: the attestation is gone
    await expect(guarded.signTransaction(solTransfer())).rejects.toMatchObject({ code: 'no_attestation' });
    expect(calls).toEqual(['sign']);
  });

  it('refuses with no attestation, and with one whose first mismatched field it names', async () => {
    const { wallet, calls } = fakeWallet();
    const store = new AttestationStore();
    const guarded = guardWallet(wallet, { chain: chainAt(LIVE), store });
    await expect(guarded.signTransaction(solTransfer())).rejects.toThrow(/no_attestation: no attestation for SOL 1000000 to/);
    store.add(FIXTURE);
    await expect(guarded.signAndSendTransaction(solTransfer(AMOUNT + 1n))).rejects.toThrow(/action_mismatch \(amount\)/);
    const other = Keypair.generate().publicKey;
    await expect(guarded.signAllTransactions([solTransfer(AMOUNT, other)])).rejects.toMatchObject({ code: 'action_mismatch', field: 'recipient' });
    expect(calls).toEqual([]);
    expect(store.size, 'a refused attestation stays in the store').toBe(1);
  });

  it('refuses a consumed nullifier (replay) and an expired attestation', async () => {
    const store = new AttestationStore(); store.add(FIXTURE);
    const consumed = guardWallet(fakeWallet().wallet, { chain: chainAt(LIVE, [[NF_PDA, { owner: PROGRAM_ID, data: new Uint8Array(81) }]]), store });
    await expect(consumed.signTransaction(solTransfer())).rejects.toMatchObject({ code: 'consumed' });
    const late = guardWallet(fakeWallet().wallet, { chain: chainAt(Number(FIXTURE.expirySlot) + 1), store });
    await expect(late.signTransaction(solTransfer())).rejects.toMatchObject({ code: 'expired' });
  });

  it('refuses a tampered attestation (invalid proof) even though its labels match the transfer', async () => {
    const store = new AttestationStore();
    store.add({ ...FIXTURE, proof: { ...FIXTURE.proof, bytes: FIXTURE.proof.bytes.replace(/.$/, (c) => (c === '0' ? '1' : '0')) } });
    const guarded = guardWallet(fakeWallet().wallet, { chain: chainAt(LIVE), store });
    await expect(guarded.signTransaction(solTransfer())).rejects.toMatchObject({ code: 'invalid_proof' });
  });

  it('an SPL transfer: the recipient is the destination token account owner, read on chain or from a create-ATA in the same tx', async () => {
    const mint = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const dest = associatedTokenAddress(owner, mint);
    const ix = new TransactionInstruction({
      programId: SPL_TOKEN_ID,
      keys: [{ pubkey: associatedTokenAddress(SOURCE, mint), isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }, { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: SOURCE, isSigner: true, isWritable: false }],
      data: Buffer.concat([Buffer.from([12]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(AMOUNT); return b; })(), Buffer.from([6])]),
    });
    // on chain
    const onChain = await transfersOf(instructionsOf(v0([ix])), chainAt(LIVE, [[dest, tokenAccount(mint, owner)]]));
    expect(onChain.transfers).toHaveLength(1);
    expect(onChain.transfers[0]).toMatchObject({ kind: 'spl', amount: AMOUNT });
    expect(onChain.transfers[0]!.recipient.equals(owner)).toBe(true);
    expect(onChain.transfers[0]!.mint!.equals(mint)).toBe(true);
    // created in the same transaction (no chain read)
    const create = new TransactionInstruction({ programId: ASSOCIATED_TOKEN_ID, keys: [SOURCE, dest, owner, mint, SystemProgram.programId, SPL_TOKEN_ID].map((k, i) => ({ pubkey: k, isSigner: i === 0, isWritable: i < 2 })), data: Buffer.alloc(0) });
    const same = await transfersOf(instructionsOf(v0([create, ix])), chainAt(LIVE));
    expect(same.transfers[0]!.recipient.equals(owner)).toBe(true);
    expect(same.others).toHaveLength(0);
    // unknown destination: refused, never waved through
    await expect(transfersOf(instructionsOf(v0([ix])), chainAt(LIVE))).rejects.toThrow(/does not exist/);

    // through the guard: the only stored attestation is for native SOL → the first mismatched field is `mint`
    const store = new AttestationStore(); store.add(FIXTURE);
    const guarded = guardWallet(fakeWallet().wallet, { chain: chainAt(LIVE, [[dest, tokenAccount(mint, RECIPIENT)]]), store });
    await expect(guarded.signTransaction(v0([ix]))).rejects.toMatchObject({ code: 'action_mismatch', field: 'mint' });
  });

  it('transfers authorised by another key are not this wallet\'s to gate; other instructions pass by default and are refused on request', async () => {
    const stranger = Keypair.generate().publicKey;
    const { wallet, calls } = fakeWallet();
    const guarded = guardWallet(wallet, { chain: chainAt(LIVE) });
    await guarded.signTransaction(solTransfer(5n, RECIPIENT, stranger));
    expect(calls).toEqual(['sign']);
    const budget = new TransactionInstruction({ programId: COMPUTE_BUDGET_ID, keys: [], data: Buffer.from([2, 0x40, 0x0d, 3, 0]) });
    const swapLike = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1]) });
    await guarded.signTransaction(v0([budget, swapLike]));
    expect(calls).toEqual(['sign', 'sign']);
    const strict = guardWallet(wallet, { chain: chainAt(LIVE), otherInstructions: 'refuse' });
    await strict.signTransaction(v0([budget]));
    await expect(strict.signTransaction(v0([budget, swapLike]))).rejects.toMatchObject({ code: 'other_instruction' });
  });

  it('one attestation covers one transfer: two identical transfers in a transaction need two attestations', async () => {
    const store = new AttestationStore(); store.add(FIXTURE);
    const tx = solTransfer().add(SystemProgram.transfer({ fromPubkey: SOURCE, toPubkey: RECIPIENT, lamports: AMOUNT }));
    await expect(guardTransaction(tx, SOURCE, { chain: chainAt(LIVE), store })).rejects.toThrow(/already covers another transfer/);
  });

  it('refuses a transaction it cannot read (address lookup tables)', async () => {
    const msg = new TransactionMessage({ payerKey: SOURCE, recentBlockhash: BLOCKHASH, instructions: [SystemProgram.transfer({ fromPubkey: SOURCE, toPubkey: RECIPIENT, lamports: 1 })] }).compileToV0Message();
    msg.addressTableLookups.push({ accountKey: Keypair.generate().publicKey, writableIndexes: [0], readonlyIndexes: [] });
    await expect(guardTransaction(new VersionedTransaction(msg), SOURCE, { chain: chainAt(LIVE) })).rejects.toMatchObject({ code: 'unreadable' });
    expect(new TransferRefusedError(null, 'unreadable', undefined, 'x').message).toMatch(/refusing to sign: unreadable: x/);
  });
});

describe('blindsealPlugin', () => {
  const agentWith = (wallet: BaseWallet, chain: ChainReader, signOnly = false) => {
    const connection = { getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }) } as unknown as Connection;
    const agent: AgentLike & { methods: Record<string, (...a: never[]) => unknown>; actions: Plugin['actions']; use(p: Plugin): void } = {
      wallet, connection, config: { signOnly }, methods: {}, actions: [],
      use(p) { p.initialize(this); for (const [k, m] of Object.entries(p.methods)) this.methods[k] = m.bind(p); this.actions.push(...p.actions); },
    };
    return agent;
  };

  it('has the v2 plugin shape and guards the agent wallet on initialize', async () => {
    const plugin = blindsealPlugin({ chain: chainAt(LIVE) });
    expect(plugin.name).toBe('blindseal');
    expect(Object.keys(plugin.methods).sort()).toEqual(['blindsealHeldAttestations', 'blindsealProvideAttestation', 'blindsealTransfer']);
    expect(plugin.actions.map((a) => a.name)).toEqual(['BLINDSEAL_GUARDED_TRANSFER']);
    expect(plugin.actions[0]!.schema.safeParse({ to: RECIPIENT.toBase58(), amount: '1', attestation: 'x' }).success).toBe(true);
    expect(plugin.actions[0]!.schema.safeParse({ to: RECIPIENT.toBase58() }).success).toBe(false);

    const { wallet, calls } = fakeWallet();
    const agent = agentWith(wallet, chainAt(LIVE));
    agent.use(plugin);
    expect(agent.wallet).not.toBe(wallet);
    await expect(agent.wallet.signTransaction(solTransfer())).rejects.toBeInstanceOf(TransferRefusedError);
    expect(calls).toEqual([]);
    (agent.methods.blindsealProvideAttestation as (a: unknown) => string)(FIXTURE);
    expect((agent.methods.blindsealHeldAttestations as () => string[])()).toEqual([FIXTURE.nullifier]);
    await agent.wallet.signTransaction(solTransfer());
    expect(calls).toEqual(['sign']);
  });

  it('the action sends an attested transfer through the guarded wallet, or signs only', async () => {
    const { wallet, calls } = fakeWallet();
    const agent = agentWith(wallet, chainAt(LIVE));
    const plugin = blindsealPlugin({ chain: chainAt(LIVE) });
    agent.use(plugin);
    const out = await plugin.actions[0]!.handler(agent, { to: RECIPIENT.toBase58(), amount: FIXTURE.action.amount, attestation: Buffer.from(JSON.stringify(FIXTURE)).toString('base64') });
    expect(out).toEqual({ status: 'sent', signature: 'sig', nullifier: FIXTURE.nullifier });
    expect(calls).toEqual(['signAndSend']);

    const signOnly = agentWith(fakeWallet().wallet, chainAt(LIVE), true);
    signOnly.use(blindsealPlugin({ chain: chainAt(LIVE) }));
    const signed = await (signOnly.methods.blindsealTransfer as (a: AgentLike, i: unknown) => Promise<Record<string, unknown>>)(signOnly, { to: RECIPIENT.toBase58(), amount: Number(FIXTURE.action.amount), attestation: FIXTURE });
    expect(signed.status).toBe('signed');
    expect(typeof signed.transaction).toBe('string');
  });

  it('the action refuses early, naming the first mismatched field, and leaves nothing in the store', async () => {
    const { wallet, calls } = fakeWallet();
    const agent = agentWith(wallet, chainAt(LIVE));
    const plugin = blindsealPlugin({ chain: chainAt(LIVE) });
    agent.use(plugin);
    await expect(plugin.actions[0]!.handler(agent, { to: RECIPIENT.toBase58(), amount: '999999', attestation: FIXTURE })).rejects.toThrow(/action_mismatch \(amount\)/);
    await expect(plugin.actions[0]!.handler(agent, { to: RECIPIENT.toBase58(), amount: FIXTURE.action.amount, mint: Keypair.generate().publicKey.toBase58(), attestation: FIXTURE })).rejects.toBeInstanceOf(AttestationRefusedError);
    await expect(plugin.actions[0]!.handler(agent, { to: RECIPIENT.toBase58(), amount: 'lots', attestation: FIXTURE })).rejects.toThrow();
    expect(plugin.store.size).toBe(0);
    expect(calls).toEqual([]);
    // a consumed attestation gets through the label check and is refused by the guarded wallet
    const consumedAgent = agentWith(fakeWallet().wallet, chainAt(LIVE));
    consumedAgent.use(blindsealPlugin({ chain: chainAt(LIVE, [[NF_PDA, { owner: PROGRAM_ID, data: new Uint8Array(81) }]]) }));
    await expect((consumedAgent.methods.blindsealTransfer as (a: AgentLike, i: unknown) => Promise<unknown>)(consumedAgent, { to: RECIPIENT.toBase58(), amount: FIXTURE.action.amount, attestation: FIXTURE })).rejects.toMatchObject({ code: 'consumed' });
  });

  it('buildTransfer: SOL, SPL Transfer between ATAs, SPL TransferChecked with decimals', () => {
    const mint = Keypair.generate().publicKey;
    const sol = buildTransfer(SOURCE, { to: RECIPIENT.toBase58(), amount: '5', attestation: 'x' });
    expect(sol.instructions[0]!.programId.equals(SystemProgram.programId)).toBe(true);
    const spl = buildTransfer(SOURCE, { to: RECIPIENT.toBase58(), amount: 5, mint: mint.toBase58(), attestation: 'x' });
    expect(spl.instructions[0]!.data[0]).toBe(3);
    expect(spl.instructions[0]!.keys[1]!.pubkey.equals(associatedTokenAddress(RECIPIENT, mint))).toBe(true);
    const checked = buildTransfer(SOURCE, { to: RECIPIENT.toBase58(), amount: 5, mint: mint.toBase58(), decimals: 6, attestation: 'x' });
    expect(checked.instructions[0]!.data[0]).toBe(12);
    expect(checked.instructions[0]!.data[9]).toBe(6);
    expect(checked.instructions[0]!.keys[1]!.pubkey.equals(mint)).toBe(true);
  });
});
