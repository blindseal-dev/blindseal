// Gate scans (fast, no browser): the never-write marketing scan and zero-external-URL, run over the
// built source. The browser-level versions live in the Playwright specs.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
// Our hand-written TSX/CSS only — the vendored kit lives under src/kit and is carried verbatim.
const files = walk(SRC).filter((f) => /\.(ts|tsx|css)$/.test(f) && !f.includes(`${join('src', 'kit')}`.replace(SRC, 'kit')) && !/\/kit\//.test(f));

describe('never-write scan (hand-written source)', () => {
  const banned = [/\bunhackable\b/i, /\bproves?\s+no\s+injection/i, /\bagent\s+is\s+safe\b/i, /\bmilitary[-\s]grade\b/i, /\bzero[-\s]trust\b(?!\s+[a-z])/i];
  it('no banned marketing claim in hand-written source', () => {
    const hits: string[] = [];
    for (const f of files) {
      const t = readFileSync(f, 'utf8');
      for (const re of banned) if (re.test(t)) hits.push(`${f}: ${re}`);
    }
    expect(hits).toEqual([]);
  });
});

describe('zero external requests', () => {
  it('no off-host absolute URL in hand-written source', () => {
    const urlRe = /(https?|wss?):\/\/([^\s'"`)]+)/gi;
    const allow = /^(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;
    const hits: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(urlRe)) {
        const host = m[2];
        if (/^(www\.)?(w3\.org|json-schema\.org|schema\.org|reactrouter\.com)/.test(host)) continue;
        if (!allow.test(host)) hits.push(`${f}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the API client uses relative /api paths only', () => {
    expect(readFileSync(join(SRC, 'api', 'client.ts'), 'utf8')).toMatch(/fetch\(`\/api\$\{path\}`/);
  });
});
