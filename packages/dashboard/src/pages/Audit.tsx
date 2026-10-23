import { useState } from 'react';
import { useAuditEntries, useAuditHead, useDisclose, useVerifyChain } from '../api/hooks';
import type { Disclosure } from '../api/types';
import { Hash } from '../components/Hash';
import { VerdictChip } from '../components/VerdictChip';

function download(d: Disclosure) {
  const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `disclosure-${d.from}-${d.to}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function Audit() {
  const { data: head } = useAuditHead();
  const verify = useVerifyChain();
  const disclose = useDisclose();
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(20);
  const { data: entries = [] } = useAuditEntries(from, to);

  return (
    <div style={{ maxWidth: 860 }}>
      <div className="bs-pagehead">
        <div className="bs-counts">
          <span>head <b>#{head?.index ?? '—'}</b></span>
          <span><Hash value={head?.hash ?? ''} lg /></span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="bs-btn" disabled={verify.isPending} onClick={() => verify.mutate()}>
            {verify.isPending ? 'Verifying…' : 'Verify chain'}
          </button>
          <button className="bs-btn" disabled={disclose.isPending} onClick={() => disclose.mutate({ from, to }, { onSuccess: download })}>
            Export disclosure
          </button>
        </div>
      </div>

      {verify.data && (
        <div
          className="bs-panel"
          style={{ padding: '12px 16px', marginBottom: 16, color: verify.data.ok ? 'var(--color-green)' : 'var(--status-danger)' }}
        >
          {verify.data.ok
            ? `Chain intact — #${verify.data.checkedFrom}…#${verify.data.checkedTo} verified from genesis.`
            : `⚠ Chain broken at #${verify.data.brokenAt} — an entry's hash does not match the recomputed chain.`}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <label className="bs-faint" style={{ fontSize: 12 }}>range</label>
        <input type="number" value={from} min={0} onChange={(e) => setFrom(Math.max(0, +e.target.value))}
          style={{ width: 80, background: 'var(--canvas)', color: 'var(--ink)', border: 'var(--hairline)', borderRadius: 8, padding: '5px 8px' }} />
        <span className="bs-faint">→</span>
        <input type="number" value={to} min={from} onChange={(e) => setTo(+e.target.value)}
          style={{ width: 80, background: 'var(--canvas)', color: 'var(--ink)', border: 'var(--hairline)', borderRadius: 8, padding: '5px 8px' }} />
      </div>

      <div className="bs-panel">
        <table className="bs-table">
          <thead>
            <tr><th>#</th><th>Time</th><th>Verdict</th><th>Decision</th><th>Entry hash</th></tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.index} style={{ cursor: 'default' }}>
                <td className="bs-mono">{e.index}</td>
                <td className="bs-mono bs-faint">{new Date(e.ts).toLocaleTimeString([], { hour12: false })}</td>
                <td><VerdictChip verdict={e.verdict} /></td>
                <td className="bs-mono bs-faint">{e.decisionId.slice(0, 8)}…</td>
                <td><Hash value={e.hash} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="bs-faint" style={{ fontSize: 12, marginTop: 10 }}>
        Entries are content-free: only hashes, verdicts and timestamps — never the payload.
      </p>
    </div>
  );
}
