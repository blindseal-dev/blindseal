// Release 0.7.0 / audit finding #7 — payload → action binding on the host.
//  1. The TypeScript binding reproduces every shared vector (evals/vectors/action-binding.json); the
//     Rust binding the guest runs is held to the same file (crates/detector-core/tests).
//  2. `blindseal attest` refuses a payload whose action disagrees with the action it would prove —
//     before the prover is started (a stub prover records whether it ran).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionFromPayload, BindError, checkActionBinding, GATED_TRANSFER_DISC, TRANSFER_GATE_ID } from '../src/chain/action-binding.js';
import { runAttestCli } from '../src/cli/attest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = 'Zv5PpLYUkScw7BUCbPhREpDXbdkJ21qMpsu54vYr1E4';
const DST = '7yWHC82fn96N6XTJBXdwkSBQHtLZZJTjr4SxXtGLQM24';
const OTHER = '9H7xb7EXzwQ5RFmA2qWnNhML9geLjDFrZwhJYxCUVQzf';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

describe('payload → action binding (TS mirror of the guest)', () => {
  it('reproduces every shared vector', () => {
    const { vectors } = JSON.parse(readFileSync(path.join(ROOT, 'evals/vectors/action-binding.json'), 'utf8')) as {
      vectors: Array<{ name: string; payload: string; action?: unknown; error?: string }>;
    };
    expect(vectors.length).toBeGreaterThanOrEqual(50);
    for (const v of vectors) {
      let got: unknown;
      try { got = { action: actionFromPayload(v.payload) }; } catch (e) { got = { error: (e as BindError).code }; }
      expect(got, v.name).toEqual(v.action !== undefined ? { action: v.action } : { error: v.error });
    }
  });

  it('refuses each mismatched field, in the guest order', () => {
    const payload = JSON.stringify({ tool: 'transfer_sol', args: { to: DST, lamports: 1000000, from: SRC } });
    const ok = { chainId: 1, targetProgram: TRANSFER_GATE_ID, instruction: GATED_TRANSFER_DISC, sourceAuthority: SRC, recipient: DST, mint: '', amount: '1000000' };
    expect(() => checkActionBinding(payload, ok)).not.toThrow();
    const code = (patch: object) => { try { checkActionBinding(payload, { ...ok, ...patch }); return 'ok'; } catch (e) { return (e as BindError).code; } };
    expect(code({ recipient: OTHER })).toBe('recipient-mismatch');
    expect(code({ amount: '1000001' })).toBe('amount-mismatch');
    expect(code({ sourceAuthority: OTHER })).toBe('source-authority-mismatch');
    expect(code({ targetProgram: SYSTEM_PROGRAM })).toBe('target-program-mismatch');
    expect(code({ instruction: '0x0102030405060708' })).toBe('instruction-mismatch');
    expect(code({ mint: OTHER })).toBe('mint-mismatch');
    expect(code({ chainId: 2 })).toBe('chain-id-mismatch');
  });
});

describe('blindseal attest refuses a mismatched payload before proving', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bs-bind-'));
  const marker = path.join(dir, 'prover-ran');
  const prover = path.join(dir, 'stub-prover.sh');
  const home = process.env.HOME;
  beforeAll(() => {
    writeFileSync(prover, `#!/bin/sh\nprintf '%s\\n' "$@" > '${marker}'\n`);
    chmodSync(prover, 0o755);
    process.env.HOME = dir; // recordProofSeconds writes under ~/.blindseal
  });
  afterAll(() => { process.env.HOME = home; });

  const run = async (args: object, flags: string[], toolName = 'transfer_sol') => {
    const call = path.join(dir, `call-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(call, JSON.stringify({ toolName, args }));
    if (existsSync(marker)) writeFileSync(marker, ''); // reset
    const code = await runAttestCli([call, '--out', path.join(dir, 'att.json'), '--no-expiry', '--prover', prover, '--audit-dir', path.join(dir, 'audit'), ...flags]);
    const ran = existsSync(marker) && readFileSync(marker, 'utf8').length > 0;
    return { code, ran, argv: ran ? readFileSync(marker, 'utf8').trim().split('\n') : [] };
  };
  const transfer = { to: DST, lamports: 1000000, from: SRC, memo: 'invoice' };

  it('--target-program that is not the program the payload targets', async () => {
    // the pre-0.7.0 adapter default for a native transfer was the System Program
    const r = await run(transfer, ['--target-program', SYSTEM_PROGRAM]);
    expect(r.code).toBe(1);
    expect(r.ran, 'prover must not run').toBe(false);
  });

  it('a payload naming its own program, attested for another', async () => {
    const r = await run({ ...transfer, program: OTHER }, ['--target-program', TRANSFER_GATE_ID]);
    expect(r.code).toBe(1);
    expect(r.ran, 'prover must not run').toBe(false);
  });

  it('--instruction that is not the instruction the payload names', async () => {
    const r = await run(transfer, ['--target-program', TRANSFER_GATE_ID, '--instruction', '0x0102030405060708']);
    expect(r.code).toBe(1);
    expect(r.ran, 'prover must not run').toBe(false);
  });

  it('a payload whose amount is not an exact u64 (fractional lamports)', async () => {
    const r = await run({ ...transfer, lamports: 1.5 }, ['--target-program', TRANSFER_GATE_ID]);
    expect(r.code).toBe(1);
    expect(r.ran, 'prover must not run').toBe(false);
  });

  it('a matching call reaches the prover with exactly the payload-derived action', async () => {
    const r = await run(transfer, ['--target-program', TRANSFER_GATE_ID]);
    expect(r.code).toBe(0);
    expect(r.ran).toBe(true);
    const flag = (k: string) => r.argv[r.argv.indexOf(k) + 1];
    expect(flag('--target-program')).toBe(TRANSFER_GATE_ID);
    expect(flag('--instruction')).toBe(GATED_TRANSFER_DISC);
    expect(flag('--source-authority')).toBe(SRC);
    expect(flag('--recipient')).toBe(DST);
    expect(flag('--mint')).toBe('');
    expect(flag('--amount')).toBe('1000000');
  });
});
