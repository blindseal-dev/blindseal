/// Audit finding #4 (startup): in block mode the proxy refuses to start when the layer-2
/// embedding model cannot load (download failure, missing offline cache, corrupt model file),
/// with a clear stderr message and exit code 4 — unless --allow-degraded is passed, in which
/// case it starts and every decision made without layer 2 is recorded as degraded.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawnProxy, PKG_ROOT, type Harness } from './helpers/proxy-harness.js';
import { warmupLayer2 } from '../src/detection/layer2-embeddings.js';

const FIXTURE = path.join(PKG_ROOT, 'test/fixture-mcp-server.mjs');
const MODEL = path.join('Xenova', 'bge-small-en-v1.5');
// Nothing listens on port 9 (discard) locally: every model download attempt fails to connect.
const DEAD_HOST = 'http://127.0.0.1:9/';
const EXIT_WAIT_MS = 15000;

let h: Harness | undefined;
const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
afterEach(() => {
  h?.close();
  h = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let realCache = '';
beforeAll(async () => {
  // Make sure the real model is cached (downloads on a fresh machine) so the corrupt-model case
  // can copy its genuine tokenizer/config next to a garbage weights file.
  await warmupLayer2();
  const req = createRequire(import.meta.url);
  const pkgDir = path.dirname(req.resolve('@xenova/transformers/package.json'));
  realCache = path.join(pkgDir, '.cache');
}, 120000);

const call = (id: number, file: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'read_file', arguments: { path: file } } });

function expectRefused(code: number | null, stderr: string) {
  expect(code, `proxy did not exit; stderr:\n${stderr}`).toBe(4);
  expect(stderr).toMatch(/refusing to start/);
  expect(stderr).toMatch(/layer 2/);
  expect(stderr).toMatch(/--allow-degraded/);
}

describe('layer-2 startup preflight', () => {
  it('block mode: model download failure (empty cache, unreachable host) ⇒ refuses to start', async () => {
    h = spawnProxy({ fixture: FIXTURE, env: { BLINDSEAL_MODE: 'block', BLINDSEAL_MODEL_DIR: tmp('bs-model-empty-'), BLINDSEAL_MODEL_HOST: DEAD_HOST } });
    h.send(call(1, 'clean.txt'));
    const code = await h.exited(EXIT_WAIT_MS);
    expectRefused(code, h.stderr());
  }, 30000);

  it('block mode: missing model dir with downloads disabled ⇒ refuses to start', async () => {
    h = spawnProxy({ fixture: FIXTURE, env: { BLINDSEAL_MODEL_DIR: path.join(tmp('bs-model-'), 'does-not-exist'), BLINDSEAL_MODEL_OFFLINE: '1' } });
    const code = await h.exited(EXIT_WAIT_MS);
    expectRefused(code, h.stderr());
  }, 30000);

  it('block mode: corrupt model file ⇒ refuses to start', async () => {
    const dir = tmp('bs-model-corrupt-');
    const dst = path.join(dir, MODEL);
    mkdirSync(path.join(dst, 'onnx'), { recursive: true });
    for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) {
      const src = path.join(realCache, MODEL, f);
      expect(existsSync(src), `missing ${src}`).toBe(true);
      copyFileSync(src, path.join(dst, f));
    }
    writeFileSync(path.join(dst, 'onnx', 'model_quantized.onnx'), Buffer.from('this is not an onnx model'.repeat(64)));
    h = spawnProxy({ fixture: FIXTURE, env: { BLINDSEAL_MODEL_DIR: dir, BLINDSEAL_MODEL_OFFLINE: '1' } });
    const code = await h.exited(EXIT_WAIT_MS);
    expectRefused(code, h.stderr());
  }, 30000);

  it('http transport is gated the same way', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(PKG_ROOT, 'src/index.ts'), '--transport', 'http', '--upstream', 'http://127.0.0.1:9/mcp', '--port', '0'], {
      cwd: PKG_ROOT, env: { ...process.env, BLINDSEAL_MODEL_DIR: tmp('bs-model-http-'), BLINDSEAL_MODEL_OFFLINE: '1' },
    });
    let err = '';
    child.stderr.on('data', (b) => { err += b.toString(); });
    const code = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, EXIT_WAIT_MS);
      child.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    expectRefused(code, err);
  }, 30000);

  it('--allow-degraded starts, screens with layers 0/1, and records decisions as degraded', async () => {
    const audit = path.join(tmp('bs-audit-'), 'audit.jsonl');
    h = spawnProxy({
      fixture: FIXTURE,
      proxyArgs: ['--allow-degraded'],
      env: {
        BLINDSEAL_MODEL_DIR: tmp('bs-model-empty-'),
        BLINDSEAL_MODEL_HOST: DEAD_HOST,
        BLINDSEAL_AUDIT_LOG: audit,
        ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, OLLAMA_HOST: undefined, BLINDSEAL_LAYER3_PROVIDER: undefined,
      },
    });
    h.send(call(2, 'clean.txt'));
    const clean = await h.next();
    expect(clean.result.isError).toBe(false);
    expect(clean.result.content[0].text).toMatch(/Hello world/);
    // Layer 1 still blocks an explicit injection.
    h.send(call(3, 'malicious.txt'));
    const bad = await h.next();
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toMatch(/\[BLINDSEAL_BLOCKED\]/);
    expect(h.stderr()).toMatch(/DEGRADED — layer 2 \(embedding model\) failed to load/);
    expect(h.stderr()).toMatch(/layer-2 unavailable/);
    const entries = readFileSync(audit, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const cleanEntry = entries.find((e) => e.type === 'detection' && e.toolName === 'read_file' && e.verdict === 'clean');
    expect(cleanEntry?.degraded).toBe(true);
  }, 30000);

  it('warn mode starts without the flag (notice on stderr)', async () => {
    h = spawnProxy({ fixture: FIXTURE, env: { BLINDSEAL_MODE: 'warn', BLINDSEAL_MODEL_DIR: tmp('bs-model-empty-'), BLINDSEAL_MODEL_OFFLINE: '1' } });
    h.send(call(4, 'clean.txt'));
    const r = await h.next();
    expect(r.result.content[0].text).toMatch(/Hello world/);
    expect(h.stderr()).toMatch(/DEGRADED — layer 2 \(embedding model\) failed to load/);
  }, 30000);

  it('a healthy model starts normally in block mode', async () => {
    h = spawnProxy({ fixture: FIXTURE });
    h.send(call(5, 'clean.txt'));
    const r = await h.next();
    expect(r.result.isError).toBe(false);
    expect(h.stderr()).not.toMatch(/refusing to start|DEGRADED —/);
  }, 30000);
});
