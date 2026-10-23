import { describe, it, expect } from 'vitest';
import { parseSolanaAction } from '../src/chain/solana.js';

describe('solana chain adapter', () => {
  it('parses a native SOL transfer (system program)', () => {
    const a = parseSolanaAction('transfer_sol', { to: 'Rcpt1111', lamports: 500000, from: 'Auth1111' });
    expect(a).not.toBeNull();
    expect(a!.chain).toBe('solana');
    expect(a!.targetProgram).toBe('11111111111111111111111111111111');
    expect(a!.recipient).toBe('Rcpt1111');
    expect(a!.amount).toBe('500000');
    expect(a!.mint).toBe(''); // native
    expect(a!.sourceAuthority).toBe('Auth1111');
    expect(a!.instruction).toBe('transfer');
    expect(a!.chainId).toBe(1);
  });

  it('parses an SPL token transfer (token program + mint)', () => {
    const a = parseSolanaAction('spl_transfer', {
      recipient: 'Rcpt2222',
      amount: '1000000',
      mint: 'So11111111111111111111111111111111111111112',
      authority: 'Owner222',
    });
    expect(a!.targetProgram).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    expect(a!.mint).toBe('So11111111111111111111111111111111111111112');
    expect(a!.instruction).toBe('transferChecked');
  });

  it('honors devnet chainId', () => {
    const a = parseSolanaAction('send', { to: 'X', amount: 1 }, { chain: 'devnet' });
    expect(a!.chainId).toBe(2);
  });

  it('accepts an explicit program id on a non-transfer-named tool', () => {
    const a = parseSolanaAction('invoke_program', { programId: 'MyProg11', recipient: 'R' });
    expect(a).not.toBeNull();
    expect(a!.targetProgram).toBe('MyProg11');
  });

  it('returns null for a non-action tool call', () => {
    expect(parseSolanaAction('read_file', { path: '/etc/hosts' })).toBeNull();
    expect(parseSolanaAction('list_channels', {})).toBeNull();
    expect(parseSolanaAction('transfer', null)).toBeNull();
    // transfer-shaped name but no recipient/amount/program -> not an action
    expect(parseSolanaAction('transfer', { memo: 'hi' })).toBeNull();
  });
});
