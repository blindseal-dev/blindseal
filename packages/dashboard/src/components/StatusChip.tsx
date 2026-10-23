import type { CSSProperties } from 'react';
import type { AttestationStatus } from '../api/types';

// Red appears in exactly one place in the whole product: a rejected/failed attestation. Everything
// else uses accent or muted (design rule, HANDOFF §5).
const STYLE: Record<AttestationStatus, CSSProperties> = {
  generating: { color: 'var(--accent-text)', background: 'var(--accent-tint)' },
  generated: { color: 'var(--accent-text)', background: 'var(--accent-tint)' },
  submitted: { color: 'var(--accent-text)', background: 'var(--accent-tint)' },
  consumed: { color: 'var(--muted)', background: 'var(--surface-hover)' },
  expired: { color: 'var(--faint)', background: 'var(--surface-hover)' },
  rejected: { color: 'var(--status-danger)', background: 'var(--status-danger-bg)' },
};

export function StatusChip({ status }: { status: AttestationStatus }) {
  return (
    <span className="bs-chip" style={STYLE[status]}>
      {status}
    </span>
  );
}
