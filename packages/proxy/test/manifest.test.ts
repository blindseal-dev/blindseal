import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  ManifestChecker,
  ManifestStore,
  computeFingerprint,
  diffFingerprints,
  serverKey,
  stableStringify,
} from '../src/manifest/index.js';

describe('stableStringify', () => {
  it('produces identical output regardless of key order', () => {
    const a = stableStringify({ b: 1, a: 2, c: { y: 'y', x: 'x' } });
    const b = stableStringify({ c: { x: 'x', y: 'y' }, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('preserves array order', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('computeFingerprint', () => {
  const init = { protocolVersion: '2024-11-05', serverInfo: { name: 'demo', version: '1.0.0' } };
  const tools = {
    tools: [
      {
        name: 'read_file',
        description: 'reads a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
      {
        name: 'http_get',
        description: 'fetches a URL',
        inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      },
    ],
  };

  it('is deterministic', () => {
    const a = computeFingerprint(init, tools);
    const b = computeFingerprint(init, tools);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('is insensitive to tool order', () => {
    const reordered = { tools: [tools.tools[1], tools.tools[0]] };
    const a = computeFingerprint(init, tools);
    const b = computeFingerprint(init, reordered);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('changes when a tool is added', () => {
    const more = {
      tools: [
        ...tools.tools,
        { name: 'new_tool', description: 'new', inputSchema: { type: 'object' } },
      ],
    };
    expect(computeFingerprint(init, tools).fingerprint).not.toBe(
      computeFingerprint(init, more).fingerprint,
    );
  });

  it('changes when a tool input schema changes', () => {
    const mutated = {
      tools: [
        {
          name: 'read_file',
          description: 'reads a file',
          // schema changed: added `encoding` property
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' }, encoding: { type: 'string' } },
          },
        },
        tools.tools[1],
      ],
    };
    expect(computeFingerprint(init, tools).fingerprint).not.toBe(
      computeFingerprint(init, mutated).fingerprint,
    );
  });

  it('changes when description changes', () => {
    const mutated = {
      tools: [
        { ...tools.tools[0], description: 'now reads files AND directories' },
        tools.tools[1],
      ],
    };
    expect(computeFingerprint(init, tools).fingerprint).not.toBe(
      computeFingerprint(init, mutated).fingerprint,
    );
  });

  it('changes when server version changes', () => {
    const next = { ...init, serverInfo: { name: 'demo', version: '2.0.0' } };
    expect(computeFingerprint(init, tools).fingerprint).not.toBe(
      computeFingerprint(next, tools).fingerprint,
    );
  });
});

describe('diffFingerprints', () => {
  it('reports added, removed, and modified tools', () => {
    const a = computeFingerprint(
      { serverInfo: { name: 'd', version: '1' } },
      {
        tools: [
          { name: 'kept', inputSchema: { x: 1 } },
          { name: 'removed', inputSchema: { y: 1 } },
          { name: 'mutated', inputSchema: { z: 1 } },
        ],
      },
    );
    const b = computeFingerprint(
      { serverInfo: { name: 'd', version: '1' } },
      {
        tools: [
          { name: 'kept', inputSchema: { x: 1 } },
          { name: 'added', inputSchema: { q: 1 } },
          { name: 'mutated', inputSchema: { z: 2 } },
        ],
      },
    );
    const changes = diffFingerprints(a, b);
    expect(changes).toContain('tool added: added');
    expect(changes).toContain('tool removed: removed');
    expect(changes.some((c) => c.includes("'mutated'") && c.includes('input schema'))).toBe(true);
  });

  it('reports server version drift', () => {
    const a = computeFingerprint({ serverInfo: { name: 'd', version: '1' } }, { tools: [] });
    const b = computeFingerprint({ serverInfo: { name: 'd', version: '2' } }, { tools: [] });
    const changes = diffFingerprints(a, b);
    expect(changes.some((c) => c.includes('server version'))).toBe(true);
  });
});

describe('serverKey', () => {
  it('is stable across runs', () => {
    expect(serverKey('node', ['fixture.mjs'])).toBe(serverKey('node', ['fixture.mjs']));
  });

  it('differs when args differ', () => {
    expect(serverKey('node', ['fixture.mjs'])).not.toBe(serverKey('node', ['other.mjs']));
  });
});

describe('ManifestStore', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'blindseal-manifest-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null for an unknown server key', () => {
    const store = new ManifestStore(tmpDir);
    expect(store.load('does-not-exist')).toBeNull();
  });

  it('round-trips a record', () => {
    const store = new ManifestStore(tmpDir);
    const fp = computeFingerprint(
      { serverInfo: { name: 'd', version: '1' } },
      { tools: [{ name: 't', inputSchema: { x: 1 } }] },
    );
    store.save({
      serverKey: 'k1',
      commandHash: 'h',
      firstSeen: '2026-01-01T00:00:00.000Z',
      lastSeen: '2026-01-01T00:00:00.000Z',
      fingerprint: fp,
    });
    const loaded = store.load('k1');
    expect(loaded?.fingerprint.fingerprint).toBe(fp.fingerprint);
  });
});

describe('ManifestChecker', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'blindseal-manifest-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns first-seen on the initial encounter', () => {
    const c = new ManifestChecker('node', ['fixture.mjs'], { mode: 'on', cacheDir: tmpDir });
    c.observeInitialize({ serverInfo: { name: 'fx', version: '1.0' } });
    c.observeToolsList({
      tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }],
    });
    const v = c.finalizeIfReady();
    expect(v?.status).toBe('first-seen');
    expect(v?.changes).toEqual([]);
  });

  it('returns unchanged on identical second run', () => {
    const init = { serverInfo: { name: 'fx', version: '1.0' } };
    const tools = { tools: [{ name: 't', inputSchema: { type: 'object' } }] };

    const first = new ManifestChecker('node', ['fixture.mjs'], { mode: 'on', cacheDir: tmpDir });
    first.observeInitialize(init);
    first.observeToolsList(tools);
    first.finalizeIfReady();

    const second = new ManifestChecker('node', ['fixture.mjs'], { mode: 'on', cacheDir: tmpDir });
    second.observeInitialize(init);
    second.observeToolsList(tools);
    const v = second.finalizeIfReady();
    expect(v?.status).toBe('unchanged');
    expect(v?.changes).toEqual([]);
  });

  it('returns drift with detailed changes when manifest mutates', () => {
    const init = { serverInfo: { name: 'fx', version: '1.0' } };

    const first = new ManifestChecker('node', ['fixture.mjs'], { mode: 'on', cacheDir: tmpDir });
    first.observeInitialize(init);
    first.observeToolsList({ tools: [{ name: 'read_file', inputSchema: { type: 'object' } }] });
    first.finalizeIfReady();

    const second = new ManifestChecker('node', ['fixture.mjs'], { mode: 'on', cacheDir: tmpDir });
    second.observeInitialize({ serverInfo: { name: 'fx', version: '2.0' } });
    second.observeToolsList({
      tools: [
        { name: 'read_file', inputSchema: { type: 'object' } },
        { name: 'delete_file', inputSchema: { type: 'object' } }, // new dangerous tool!
      ],
    });
    const v = second.finalizeIfReady();
    expect(v?.status).toBe('drift');
    expect(v?.changes.some((c) => c.includes('tool added: delete_file'))).toBe(true);
    expect(v?.changes.some((c) => c.includes('server version'))).toBe(true);
  });

  it('returns null while waiting for tools/list', () => {
    const c = new ManifestChecker('node', ['fixture.mjs'], { mode: 'on', cacheDir: tmpDir });
    expect(c.finalizeIfReady()).toBeNull();
    c.observeInitialize({ serverInfo: { name: 'fx', version: '1.0' } });
    expect(c.finalizeIfReady()).toBeNull();
  });

  it('finalizes only once', () => {
    const c = new ManifestChecker('node', ['fixture.mjs'], { mode: 'on', cacheDir: tmpDir });
    c.observeInitialize({ serverInfo: { name: 'fx', version: '1.0' } });
    c.observeToolsList({ tools: [{ name: 't', inputSchema: {} }] });
    expect(c.finalizeIfReady()).not.toBeNull();
    expect(c.finalizeIfReady()).toBeNull();
  });

  it('keys are stable across instances with the same command line', () => {
    const c1 = new ManifestChecker('node', ['fixture.mjs', '--flag'], { mode: 'on', cacheDir: tmpDir });
    c1.observeInitialize({ serverInfo: { name: 'fx', version: '1.0' } });
    c1.observeToolsList({ tools: [{ name: 't', inputSchema: {} }] });
    const v1 = c1.finalizeIfReady();

    const c2 = new ManifestChecker('node', ['fixture.mjs', '--flag'], { mode: 'on', cacheDir: tmpDir });
    c2.observeInitialize({ serverInfo: { name: 'fx', version: '1.0' } });
    c2.observeToolsList({ tools: [{ name: 't', inputSchema: {} }] });
    const v2 = c2.finalizeIfReady();

    expect(v1?.serverKey).toBe(v2?.serverKey);
    expect(v2?.status).toBe('unchanged');
  });
});

/// 0.7.0 re-audit (P3): the manifest cache kept the server's full command line in plaintext, in
/// a 0644 file, so a credential passed as a flag or in an upstream URL outlived the process.
describe('manifest cache keeps no command-line credentials', () => {
  let tmpDir: string;
  const prevUmask = process.umask(0o022);
  beforeEach(() => {
    tmpDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'blindseal-manifest-')), 'cache');
  });
  afterEach(() => {
    rmSync(path.dirname(tmpDir), { recursive: true, force: true });
  });
  afterAll(() => { process.umask(prevUmask); });

  function observe(cmd: string, args: string[]) {
    const c = new ManifestChecker(cmd, args, { mode: 'on', cacheDir: tmpDir });
    c.observeInitialize({ serverInfo: { name: 'fx', version: '1.0' } });
    c.observeToolsList({ tools: [{ name: 't', inputSchema: { type: 'object' } }] });
    return c.finalizeIfReady();
  }
  const allCacheText = () => readdirSync(tmpDir).map((f) => readFileSync(path.join(tmpDir, f), 'utf8')).join('\n');

  it('a secret flag and a token-bearing upstream URL never reach the cache; dir 0700, files 0600', () => {
    observe('node', ['server.mjs', '--api-key', 'manifest-canary-12345']);
    observe('http', ['https://user:pw-canary@mcp.example/sse?token=url-canary-678']);
    const text = allCacheText();
    for (const secret of ['manifest-canary-12345', 'pw-canary', 'url-canary-678', 'server.mjs', 'mcp.example']) {
      expect(text).not.toContain(secret);
    }
    expect(statSync(tmpDir).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(tmpDir)) expect(statSync(path.join(tmpDir, f)).mode & 0o777).toBe(0o600);
    const rec = JSON.parse(readFileSync(path.join(tmpDir, readdirSync(tmpDir)[0]!), 'utf8'));
    expect(Object.keys(rec).sort()).toEqual(['commandHash', 'fingerprint', 'firstSeen', 'lastSeen', 'serverKey']);
  });

  it('identity still works from the hash: same command line → unchanged', () => {
    observe('node', ['server.mjs', '--api-key', 'k1']);
    expect(observe('node', ['server.mjs', '--api-key', 'k1'])?.status).toBe('unchanged');
    expect(observe('node', ['server.mjs', '--api-key', 'k2'])?.status).toBe('first-seen');
  });

  it('a cache written by an older version is rewritten without the raw command, and tightened to 0600', () => {
    const key = serverKey('node', ['server.mjs', '--api-key', 'old-canary-999']);
    mkdirSync(tmpDir, { recursive: true, mode: 0o755 });
    const old = path.join(tmpDir, `${key}.json`);
    writeFileSync(old, JSON.stringify({ serverKey: key, command: 'node', args: ['server.mjs', '--api-key', 'old-canary-999'], firstSeen: 'x', lastSeen: 'x', fingerprint: { fingerprint: 'stale', tools: [] } }), { mode: 0o644 });
    observe('node', ['server.mjs', '--api-key', 'old-canary-999']);
    expect(readFileSync(old, 'utf8')).not.toContain('old-canary-999');
    expect(statSync(old).mode & 0o777).toBe(0o600);
    expect(statSync(tmpDir).mode & 0o777).toBe(0o700);
  });
});
