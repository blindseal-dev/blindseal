/// The email and PEM rules match exactly what their regexes match, in linear time: the regexes
/// rescanned long runs from every start (64 KB of "a." took 7 s), which stalled screening.
import { describe, it, expect } from 'vitest';
import { redact, emailSpans, pemSpans } from '../src/index.js';

const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;
const PEM_RE = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const spansOf = (re: RegExp, t: string) => [...t.matchAll(re)].map((m) => [m.index!, m.index! + m[0].length]);

describe('linear rules equal their regexes', () => {
  it('email on 50k random strings', () => {
    const r = rng(7);
    const alpha = ['a', 'B', '1', '.', '-', '_', '%', '+', '@', ' ', 'com', '.io', '!', 'é', 'x@y.zz'];
    for (let n = 0; n < 50000; n++) {
      let t = '';
      for (let i = 0, len = 1 + Math.floor(r() * 30); i < len; i++) t += alpha[Math.floor(r() * alpha.length)];
      expect(emailSpans(t), JSON.stringify(t)).toEqual(spansOf(EMAIL_RE, t));
    }
  });

  it('PEM on 30k random strings', () => {
    const r = rng(9);
    const alpha = ['-----BEGIN PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----', '-----END PRIVATE KEY-----', '-----END EC PRIVATE KEY-----', 'x', '\n', '-----BEGIN ', 'PRIVATE KEY-----', ' ', 'A'];
    for (let n = 0; n < 30000; n++) {
      let t = '';
      for (let i = 0, len = 1 + Math.floor(r() * 12); i < len; i++) t += alpha[Math.floor(r() * alpha.length)];
      expect(pemSpans(t), JSON.stringify(t)).toEqual(spansOf(PEM_RE, t));
    }
  });
});

describe('redact() is fast on any 1 MB input', () => {
  const units = ['a.', 'a-', '1-', '1.', '+1', 'a@', '"token":[', '"password":[1,', '-----BEGIN PRIVATE KEY-----', '\\"', 'a ', 'A'];
  for (const u of units) {
    it(JSON.stringify(u), () => {
      const t = u.repeat(Math.ceil((1 << 20) / u.length));
      const t0 = performance.now();
      redact(t);
      expect(performance.now() - t0).toBeLessThan(3000);
    });
  }
  it('still redacts a closed composite value after many unclosed ones', () => {
    expect(redact('"token": [ '.repeat(3) + ' "secret": ["x"]').redacted).toContain('[REDACTED:');
  });
});
