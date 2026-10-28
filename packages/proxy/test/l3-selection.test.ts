// Audit finding #2 (0.7.0): remote L3 only with an explicit BLINDSEAL_LAYER3_PROVIDER; ambient
// provider keys (any *_API_KEY) never enable it; the active L3 is printed at startup.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClientFromEnv } from '../src/detection/clients/factory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const PROXY_ENTRY = path.join(PKG_ROOT, 'src/index.ts');
const FIXTURE = path.join(PKG_ROOT, 'test/fixture-mcp-server.mjs');

/// The environment of a developer machine: provider keys exported for other tools.
const AMBIENT: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-ambient-0000000000000000',
  OPENAI_API_KEY: 'sk-ambient-0000000000000000',
  MISTRAL_API_KEY: 'ambient',
  GROQ_API_KEY: 'ambient',
  OLLAMA_HOST: 'http://localhost:11434',
};

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  const keys = new Set([...Object.keys(env), 'BLINDSEAL_LAYER3_PROVIDER', 'BLINDSEAL_LAYER3_API_KEY', 'BLINDSEAL_LAYER3_BASE_URL', 'BLINDSEAL_LAYER3_MODEL', ...Object.keys(AMBIENT)]);
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/// Start the real CLI as a stdio proxy and capture stderr until the startup line shows up.
function startupStderr(env: Record<string, string | undefined>): Promise<string> {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  for (const k of ['BLINDSEAL_LAYER3_PROVIDER', 'BLINDSEAL_LAYER3_API_KEY', 'BLINDSEAL_LAYER3_BASE_URL', 'BLINDSEAL_LAYER3_MODEL', ...Object.keys(AMBIENT)]) delete childEnv[k];
  Object.assign(childEnv, env);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', PROXY_ENTRY, '--', process.execPath, FIXTURE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv as NodeJS.ProcessEnv,
    });
    let err = '';
    const done = () => { clearTimeout(t); child.kill('SIGKILL'); resolve(err); };
    const t = setTimeout(done, 15000);
    child.stderr.on('data', (d) => { err += String(d); if (/layer-3 judge: /.test(err)) setTimeout(done, 200); });
  });
}

describe('L3 provider selection (audit #2)', () => {
  it('ambient provider keys never enable L3', () => {
    withEnv(AMBIENT, () => expect(createClientFromEnv()).toBeNull());
    withEnv({ ANTHROPIC_API_KEY: 'sk-ant-x' }, () => expect(createClientFromEnv()).toBeNull());
    withEnv({ OPENAI_API_KEY: 'sk-x' }, () => expect(createClientFromEnv()).toBeNull());
    withEnv({ OLLAMA_HOST: 'http://localhost:11434' }, () => expect(createClientFromEnv()).toBeNull());
  });

  it('remote L3 requires an explicit BLINDSEAL_LAYER3_PROVIDER', () => {
    const c = withEnv({ ...AMBIENT, BLINDSEAL_LAYER3_PROVIDER: 'anthropic' }, () => createClientFromEnv());
    expect(c?.providerName).toBe('anthropic');
  });

  it('startup prints "off" when only ambient keys are present', async () => {
    const err = await startupStderr(AMBIENT);
    expect(err).toMatch(/layer-3 judge: off\b/);
    expect(err).not.toMatch(/layer-3 judge: remote/);
  }, 20000);

  it('startup prints "remote:<provider>" for an explicit remote provider', async () => {
    const err = await startupStderr({ BLINDSEAL_LAYER3_PROVIDER: 'openai', BLINDSEAL_LAYER3_API_KEY: 'sk-test' });
    expect(err).toMatch(/layer-3 judge: remote:openai\b/);
  }, 20000);

  it('startup prints "local" for ollama on loopback, "remote:ollama" elsewhere', async () => {
    expect(await startupStderr({ BLINDSEAL_LAYER3_PROVIDER: 'ollama' })).toMatch(/layer-3 judge: local\b/);
    expect(await startupStderr({ BLINDSEAL_LAYER3_PROVIDER: 'ollama', OLLAMA_HOST: 'http://gpu-box.example:11434' })).toMatch(/layer-3 judge: remote:ollama\b/);
  }, 40000);
});
