// Release 0.7.0 (owner, after the audit rerun): personal data in structured JSON is redacted by
// KEY before L2/L3 see it — name, address, phone, dob, ssn, passport, iban, account number, … —
// case-insensitive, nested, inside arrays. Free-text names/addresses are NOT covered.
import { describe, it, expect } from 'vitest';
import { redact, redactValue, isPersonalKey, PERSONAL_KEYS } from '../src/index.js';

describe('redactor — personal data by key', () => {
  it('redacts the audit payload: name and address no longer reach the model layers', () => {
    const r = redact(JSON.stringify({ password: 'hunter2222', api_key: 'shortkey123', name: 'Alice Smith', address: '123 Main Street, Seattle', email: 'a@example.com' }));
    for (const leak of ['hunter2222', 'shortkey123', 'Alice Smith', '123 Main Street']) expect(r.redacted).not.toContain(leak);
    expect(r.redacted).toContain('[REDACTED:personal_field:1]');
    expect(r.redacted).toContain('[REDACTED:personal_field:2]');
  });

  it('every listed key, case-insensitive and -/_ normalised', () => {
    const keys = [
      'name', 'Name', 'first_name', 'firstName', 'last-name', 'full_name', 'address', 'Street', 'city',
      'postcode', 'postal_code', 'zip', 'ZIP_CODE', 'phone', 'phone_number', 'dob', 'date_of_birth',
      'ssn', 'passport', 'passport_number', 'IBAN', 'account_number', 'accountNumber',
    ];
    for (const k of keys) {
      const r = redact(JSON.stringify({ [k]: 'v1', note: 'kept' }));
      expect(r.redacted, k).not.toContain('"v1"');
      expect(r.redacted, k).toContain('"note":"kept"');
    }
    expect(PERSONAL_KEYS.length).toBeGreaterThanOrEqual(20);
  });

  it('nested objects and arrays', () => {
    const value = { customers: [{ name: 'Alice Smith', billing: { address: '1 High St', zip: '98101' } }, { full_name: 'Bob Jones', phone: '555-0100' }] };
    const out = redactValue(value).redacted;
    for (const leak of ['Alice Smith', '1 High St', '98101', 'Bob Jones', '555-0100']) expect(out).not.toContain(leak);
  });

  it('JSON that does not parse is covered by the quoted-key rule', () => {
    const r = redact('log line {"name": "Alice Smith", "address": "1 High St", "trunc');
    expect(r.redacted).not.toContain('Alice Smith');
    expect(r.redacted).not.toContain('1 High St');
  });

  it('no generic suffix: tool_name, filename, ip_address, wallet_address stay readable', () => {
    for (const k of ['tool_name', 'filename', 'username', 'ip_address', 'wallet_address', 'toAddress', 'namespace']) {
      expect(isPersonalKey(k), k).toBe(false);
    }
  });

  it('free text outside structured fields is NOT covered (documented limit)', () => {
    const r = redact('Please ship to Alice Smith, 123 Main Street, Seattle.');
    expect(r.redacted).toContain('Alice Smith');
  });
});
