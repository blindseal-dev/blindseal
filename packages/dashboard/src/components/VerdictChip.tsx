import type { Verdict } from '../api/types';

const LABEL: Record<Verdict, string> = { pass: 'Pass', flag: 'Flag', block: 'Block' };

export function VerdictChip({ verdict }: { verdict: Verdict }) {
  return <span className={`bs-chip bs-verdict bs-verdict--${verdict}`}>{LABEL[verdict]}</span>;
}
