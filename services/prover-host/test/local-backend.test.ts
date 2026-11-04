import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalBackend, ProverExitError, proverArgs } from '../src/backends/local.js';
import type { ProofJob } from '../src/backends/types.js';
import { FAKE_PROVER, FIXTURE_ATTESTATION, fixtureAttestation, rmTmp, tmpDir } from './helpers.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmTmp(d); delete process.env.FAKE_PROVER_ARGS_FILE; });

function job(dir: string): ProofJob {
  const payloadPath = path.join(dir, 'payload.json');
  writeFileSync(payloadPath, '{"tool":"transfer_sol","args":{}}');
  return {
    id: 'j_0000000000000001', payloadPath, out: path.join(dir, 'attestation.json'),
    action: { chainId: 1, targetProgram: '9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa', sourceAuthority: 'GdPZNkh4Ugt3PCauGtUdNVDXsxDHFigbGqy4gjYGNC3L', instruction: '0x981894646560fc2b', recipient: '6HwAr9cu97PENQ727LhLErACyGznWyenKpsfTVQ5rmXo', mint: '11111111111111111111111111111111', amount: '1000000' },
    expirySlot: '463600736', decisionId: 'd_bb0eb04894c749bc',
  };
}

describe('LocalBackend', () => {
  it('spawns the prover with the CLI arguments blindseal attest uses and returns attestation.json', async () => {
    const dir = tmpDir(); dirs.push(dir);
    const argsFile = path.join(dir, 'args.txt');
    process.env.FAKE_PROVER_FIXTURE = FIXTURE_ATTESTATION;
    process.env.FAKE_PROVER_ARGS_FILE = argsFile;
    const lines: string[] = [];
    const backend = new LocalBackend({ proverPath: FAKE_PROVER, log: (l) => lines.push(l) });
    const j = job(dir);
    const att = await backend.prove(j, new AbortController().signal);
    expect(att).toEqual(fixtureAttestation());
    const argv = readFileSync(argsFile, 'utf8').trimEnd().split('\n');
    expect(argv).toEqual(proverArgs(j));
    expect(argv).toEqual([
      '--payload', j.payloadPath, '--out', j.out, '--chain-id', '1',
      '--target-program', j.action.targetProgram, '--source-authority', j.action.sourceAuthority,
      '--recipient', j.action.recipient, '--mint', '', '--amount', '1000000',
      '--instruction', '0x981894646560fc2b', '--expiry', '463600736', '--decision-id', 'd_bb0eb04894c749bc',
    ]);
    expect(lines.some((l) => l.startsWith('prover: VKEY '))).toBe(true);
    expect(lines.some((l) => l.startsWith('prover: PROVE_MS '))).toBe(true);
  });

  it('reports a non-zero exit with the prover\'s last stderr lines', async () => {
    const dir = tmpDir(); dirs.push(dir);
    process.env.FAKE_PROVER_FIXTURE = FIXTURE_ATTESTATION;
    process.env.FAKE_PROVER_EXIT = '3';
    try {
      const backend = new LocalBackend({ proverPath: FAKE_PROVER });
      await expect(backend.prove(job(dir), new AbortController().signal)).rejects.toSatisfy((e: unknown) => e instanceof ProverExitError && e.code === 3 && /failing on purpose/.test(e.message));
    } finally { delete process.env.FAKE_PROVER_EXIT; }
  });

  it('refuses a prover path that does not exist', async () => {
    const dir = tmpDir(); dirs.push(dir);
    const backend = new LocalBackend({ proverPath: path.join(dir, 'missing') });
    await expect(backend.prove(job(dir), new AbortController().signal)).rejects.toThrow(/no such file/);
  });
});
