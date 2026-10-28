/// The eval harness follows the proxy's layer-3 rule (0.7.0): L3 only via an explicit
/// BLINDSEAL_LAYER3_PROVIDER. Before 0.7.0 the harness told users to "set ANTHROPIC_API_KEY",
/// which no longer enables L3, and labelled every run "Anthropic Haiku judge".
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runEval(env: Record<string, string>) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'bs-eval-'));
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^BLINDSEAL_LAYER3_|_API_KEY$|^OLLAMA_HOST$/.test(k)) clean[k] = v;
  }
  try {
    return spawnSync(process.execPath, ['--import', 'tsx', 'src/run.ts', '--set', 'benign', '--max', '1'], {
      cwd: ROOT,
      env: { ...clean, HOME: home, ...env },
      encoding: 'utf8',
      timeout: 60000,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('eval: layer 3 needs BLINDSEAL_LAYER3_PROVIDER', () => {
  it('ANTHROPIC_API_KEY alone does not enable L3: the run refuses and says what to set', () => {
    const r = runEval({ ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/layer-3 judge: off/);
    expect(r.stderr).toMatch(/BLINDSEAL_LAYER3_PROVIDER=anthropic/);
    expect(r.stderr).toMatch(/a provider key alone never enables layer 3/);
  }, 90000);

  it('the helper reports the explicit selection', async () => {
    const { evalLayer3, layer3RequiredMessage } = await import('../src/l3-env.js');
    expect(evalLayer3({ BLINDSEAL_LAYER3_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }).line).toBe('layer-3 judge: remote:anthropic');
    expect(layer3RequiredMessage({ BLINDSEAL_LAYER3_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' })).toBeNull();
    expect(evalLayer3({ OPENAI_API_KEY: 'k' }).selection.mode).toBe('off');
  });
});
