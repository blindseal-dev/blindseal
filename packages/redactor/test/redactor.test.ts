import { describe, it, expect } from 'vitest';
import { redact, redactionTotal, type RedactionKind } from '../src/index.js';

function kinds(text: string): Set<RedactionKind> {
  return new Set(redact(text).counts.map((c) => c.kind));
}

describe('redactor — each kind', () => {
  it('api_key (provider + labeled)', () => {
    expect(kinds('key is sk-ant-abcdefghij0123456789XYZ here')).toContain('api_key');
    expect(kinds('ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toContain('api_key');
    expect(kinds('AKIAIOSFODNN7EXAMPLE')).toContain('api_key');
    expect(kinds('password: hunter2hunter2')).toContain('api_key');
  });
  it('private_key (PEM + raw 0x key)', () => {
    const pem = '-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIabcdefg\n-----END EC PRIVATE KEY-----';
    expect(kinds(pem)).toContain('private_key');
    expect(kinds('0x' + 'a'.repeat(64))).toContain('private_key');
  });
  it('jwt', () => {
    expect(kinds('token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0NTY.SflKxwRJSMeKKF2QT4')).toContain('jwt');
  });
  it('seed_phrase (12 + 24 words)', () => {
    const twelve = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
    expect(kinds(twelve)).toContain('seed_phrase');
  });
  it('email', () => {
    expect(kinds('contact alice@example.com for access')).toContain('email');
  });
  it('phone', () => {
    expect(kinds('call +1 415 555 0199 now')).toContain('phone');
    expect(kinds('555-123-4567')).toContain('phone');
  });
  it('card', () => {
    expect(kinds('card 4111 1111 1111 1111 expires soon')).toContain('card');
  });
  it('ssn', () => {
    expect(kinds('ssn 123-45-6789')).toContain('ssn');
  });
  it('high_entropy catch-all', () => {
    const tok = 'Zx9Qw3Ma7Lp2Vt8Rk5Nf1Hj6Cd0Bg4Ys'; // 33 random-ish chars
    expect(kinds(tok)).toContain('high_entropy');
  });
});

describe('redactor — format and counts', () => {
  it('replaces with [REDACTED:<kind>:<n>] and numbers per kind', () => {
    const r = redact('alice@example.com and bob@example.com');
    expect(r.redacted).toBe('[REDACTED:email:1] and [REDACTED:email:2]');
    expect(r.counts).toEqual([{ kind: 'email', count: 2 }]);
  });
  it('originals never appear in the redacted output', () => {
    const secret = 'sk-ant-SUPERSECRETVALUE0123456789';
    const r = redact(`here: ${secret}`);
    expect(r.redacted).not.toContain(secret);
    expect(r.redacted).toContain('[REDACTED:api_key:1]');
  });
  it('redactionTotal sums across kinds', () => {
    const r = redact('a@b.co 123-45-6789');
    expect(redactionTotal(r)).toBe(2);
  });
});

describe('redactor — does not over-redact normal prose', () => {
  it('leaves ordinary text untouched', () => {
    const prose = 'The quick brown fox jumps over the lazy dog near the river at dawn today.';
    const r = redact(prose);
    expect(r.redacted).toBe(prose);
    expect(r.counts).toHaveLength(0);
  });
  it('a long ordinary word is not flagged high_entropy', () => {
    const r = redact('antidisestablishmentarianism supercalifragilisticexpialidocious');
    expect(r.counts.find((c) => c.kind === 'high_entropy')).toBeUndefined();
  });
});
