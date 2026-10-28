// Canonical audit-chain verdicts: the only values a hash-chain entry's `verdict` may take.
// CLEAN_VERDICT is the one success verdict: attest, the proxy, `blindseal verify`, the browser
// verifiers and the fixtures all use it. Byte-identical copies of this file live in
// apps/site/app/verify/verdict.ts and packages/dashboard/src/verify/verdict.ts (the browser
// verifiers cannot import @blindseal/audit, which needs node:fs); packages/audit/test/verdict.test.ts
// fails if any copy drifts. No imports, so the file is valid in every copy's location.

export const CLEAN_VERDICT = 'pass';
export const FLAG_VERDICT = 'flag';
export const BLOCK_VERDICT = 'block';
export const ERROR_VERDICT = 'error';

export const CHAIN_VERDICTS = [CLEAN_VERDICT, FLAG_VERDICT, BLOCK_VERDICT, ERROR_VERDICT] as const;
export type ChainVerdict = (typeof CHAIN_VERDICTS)[number];

/// Map a detector verdict (clean | suspicious | malicious) or a capability action
/// (allow | warn | block) onto the chain vocabulary. Anything unknown is recorded as an error,
/// never as a pass.
export function toChainVerdict(v: string): ChainVerdict {
  switch (v) {
    case 'clean':
    case 'allow':
    case CLEAN_VERDICT:
      return CLEAN_VERDICT;
    case 'suspicious':
    case 'warn':
    case FLAG_VERDICT:
      return FLAG_VERDICT;
    case 'malicious':
    case BLOCK_VERDICT:
      return BLOCK_VERDICT;
    default:
      return ERROR_VERDICT;
  }
}
