import { useEffect, useState } from 'react';
import { useDryRun, usePolicy, useSavePolicy } from '../api/hooks';
import type { Decision, PolicyRule } from '../api/types';
import { Hash } from '../components/Hash';
import { LayerStrip } from '../components/LayerStrip';
import { VerdictChip } from '../components/VerdictChip';

export function Policy() {
  const { data: policy, isLoading } = usePolicy();
  const save = useSavePolicy();
  const dryRun = useDryRun();
  const [rules, setRules] = useState<PolicyRule[]>([]);
  const [dirty, setDirty] = useState(false);
  const [payload, setPayload] = useState('');
  const [result, setResult] = useState<Decision | null>(null);

  useEffect(() => {
    if (policy && !dirty) setRules(policy.rules);
  }, [policy, dirty]);

  if (isLoading || !policy) return <div className="bs-empty">Loading…</div>;

  const toggle = (id: string) => {
    setRules((rs) => rs.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
    setDirty(true);
  };

  return (
    <div style={{ maxWidth: 820 }}>
      <div className="bs-pagehead">
        <div className="bs-counts">
          <span>policy <b>v{policy.version}</b></span>
          <span>root <b><Hash value={policy.root} lg /></b></span>
          <span><b>{policy.leafCount}</b> leaves</span>
        </div>
        <button
          className="bs-btn bs-btn--primary"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate(rules, { onSuccess: () => setDirty(false) })}
        >
          {save.isPending ? 'Saving…' : dirty ? 'Save — recompute root' : 'Saved'}
        </button>
      </div>

      {save.data && !dirty && (
        <p className="bs-muted" style={{ marginTop: -6, marginBottom: 14 }}>
          New root <Hash value={save.data.root} /> · v{save.data.version} — computed by the proxy over
          the serialized rule DFAs (not in the browser).
        </p>
      )}

      <div className="bs-panel" style={{ marginBottom: 20 }}>
        <table className="bs-table">
          <thead>
            <tr><th>Rule</th><th>Severity</th><th>Layer</th><th style={{ textAlign: 'right' }}>Enabled</th></tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} style={{ cursor: 'default' }}>
                <td className="bs-mono">{r.name}</td>
                <td><VerdictChip verdict={r.verdict} /></td>
                <td className="bs-faint bs-mono">{r.layer}</td>
                <td style={{ textAlign: 'right' }}>
                  <input type="checkbox" checked={r.enabled} onChange={() => toggle(r.id)} aria-label={`toggle ${r.name}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ margin: '0 0 10px' }}>Dry run <span className="bs-faint" style={{ fontWeight: 400, fontSize: 13 }}>— not logged, not chained</span></h3>
      <div className="bs-panel" style={{ padding: 16 }}>
        <textarea
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          placeholder="Paste a payload to screen against the current policy…"
          rows={3}
          style={{ width: '100%', background: 'var(--canvas)', color: 'var(--ink)', border: 'var(--hairline)', borderRadius: 8, padding: 10, fontFamily: 'var(--font-mono)', fontSize: 13, resize: 'vertical' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 12 }}>
          <button className="bs-btn" disabled={!payload || dryRun.isPending} onClick={() => dryRun.mutate(payload, { onSuccess: setResult })}>
            {dryRun.isPending ? 'Screening…' : 'Screen'}
          </button>
          {result && (
            <>
              <VerdictChip verdict={result.verdict} />
              <LayerStrip layers={result.layers} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
