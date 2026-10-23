// The mockups' two acceptance gates, ported (FRONTEND.md / HANDOFF §5): the never-write scan and
// zero external requests. Static source scans — cheap, and they keep the production app honest.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(SRC).filter((f) => /\.(ts|tsx|css|html)$/.test(f));

describe('never-write scan', () => {
  // Banned marketing claims (HANDOFF §5). "zero-trust" only as a noun phrase, not the adjective.
  const banned = [/unhackable/i, /proves no injection/i, /agent is safe/i, /military-grade/i, /\bzero[- ]trust\b/i];
  it('no banned marketing claim appears in any source file', () => {
    const hits: string[] = [];
    for (const f of files) {
      // tokens.css is vendored and may carry neutral words; still scan it.
      const text = readFileSync(f, 'utf8');
      for (const re of banned) if (re.test(text)) hits.push(`${f}: ${re}`);
    }
    expect(hits).toEqual([]);
  });
});

describe('zero external requests', () => {
  it('no source file references an off-host absolute URL', () => {
    const urlRe = /(https?|wss?):\/\/([^\s'"`)]+)/gi;
    const allowed = /^(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(urlRe)) {
        const host = m[2];
        // schema URLs (w3.org, json-schema) never get fetched at runtime; flag only network-looking hosts.
        if (/^(www\.)?(w3\.org|json-schema\.org|schema\.org)/.test(host)) continue;
        if (!allowed.test(host)) hits.push(`${f}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the API client uses relative /api paths only', () => {
    const client = readFileSync(join(SRC, 'api', 'client.ts'), 'utf8');
    expect(client).toMatch(/fetch\(`\/api\$\{path\}`/);
  });
});
