import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDecisions } from '../api/hooks';
import type { Verdict } from '../api/types';
import { Hash } from '../components/Hash';
import { LayerStrip } from '../components/LayerStrip';
import { VerdictChip } from '../components/VerdictChip';

const FILTERS: { key: '' | Verdict; label: string }[] = [
  { key: '', label: 'All' },
  { key: 'pass', label: 'Pass' },
  { key: 'flag', label: 'Flag' },
  { key: 'block', label: 'Block' },
];

function time(ts: string): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

export function Decisions() {
  const [verdict, setVerdict] = useState<'' | Verdict>('');
  const nav = useNavigate();
  const { data, isLoading, error } = useDecisions(verdict ? { verdict } : undefined);
  const items = data?.items ?? [];

  const counts = useMemo(() => {
    const c = { pass: 0, flag: 0, block: 0 };
    for (const d of items) c[d.verdict]++;
    return c;
  }, [items]);

  return (
    <div>
      <div className="bs-pagehead">
        <div className="bs-seg">
          {FILTERS.map((f) => (
            <button key={f.key} aria-pressed={verdict === f.key} onClick={() => setVerdict(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="bs-counts">
          <span><b>{counts.pass}</b> pass</span>
          <span><b>{counts.flag}</b> flag</span>
          <span><b>{counts.block}</b> block</span>
        </div>
      </div>

      <div className="bs-panel">
        {error ? (
          <div className="bs-empty">Proxy unreachable — the stream is paused.</div>
        ) : isLoading ? (
          <div className="bs-empty">Loading…</div>
        ) : items.length === 0 ? (
          <div className="bs-empty">No decisions yet. Screened MCP traffic will stream in here.</div>
        ) : (
          <table className="bs-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Server · Tool</th>
                <th>Verdict</th>
                <th>Layers</th>
                <th>Payload</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id} onClick={() => nav(`/decisions/${d.id}`)}>
                  <td className="bs-mono bs-faint">{time(d.ts)}</td>
                  <td>
                    <span>{d.server}</span> <span className="bs-faint">·</span>{' '}
                    <span className="bs-muted bs-mono">{d.tool}</span>
                  </td>
                  <td><VerdictChip verdict={d.verdict} /></td>
                  <td><LayerStrip layers={d.layers} /></td>
                  <td><Hash value={d.payloadHash} /></td>
                  <td className="bs-muted">
                    {d.action ? `${d.action.instruction} ${d.action.amount}` : <span className="bs-faint">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
