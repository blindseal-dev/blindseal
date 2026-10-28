import { useEffect, useState } from 'react';
import { usePolicy, useSavePolicy, useDryRun } from '../api/hooks';
import type { Decision, PolicyRule } from '../api/types';
import { Hash, Icon, VerdictChip, Layers } from '../kit/react';

export function Policy() {
  const { data: policy, isLoading } = usePolicy();
  const save = useSavePolicy();
  const dry = useDryRun();
  const [rules, setRules] = useState<PolicyRule[]>([]);
  const [dirty, setDirty] = useState(false);
  const [payload, setPayload] = useState('');
  const [result, setResult] = useState<Decision | null>(null);

  useEffect(() => { if (policy && !dirty) setRules(policy.rules); }, [policy, dirty]);
  if (isLoading || !policy) return <div className="page d04"><p className="is-muted" style={{ padding: 24 }}>Loading…</p></div>;

  const readOnly = policy.readOnly === true;
  const toggle = (id: string) => { if (readOnly) return; setRules((rs) => rs.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))); setDirty(true); };
  const savedRoot = save.data?.root && !dirty ? save.data.root : policy.root;
  const savedVersion = save.data && !dirty ? save.data.version : policy.version;

  return (
    <div className="page d04">
      <section className="panel d04-root reveal" aria-labelledby="d04-root-h">
        <header className="panel__head"><h2 className="panel__title" id="d04-root-h">Policy root</h2>
          <p className="sub">v{savedVersion} · {policy.leafCount} leaves · Merkle over the committed rule DFAs</p></header>
        {readOnly && (
          <p className="d04-readonly" data-testid="policy-readonly">
            <strong>Read-only.</strong> This is the committed default rule set of this release{policy.source ? <> (<span className="mono">{policy.source}</span>)</> : null}.
            The proxy does not load rule toggles from this file, so it cannot be edited here. The dry run below screens text with the real detector.
          </p>
        )}
        <div className="d04-root__row">
          <div><p className="d04-k">Committed root</p><Hash value={savedRoot} lg /></div>
          <div><p className="d04-k">Pending</p>{dirty ? <span className="is-muted">recomputed by the proxy on Save</span> : <span className="is-faint">—</span>}</div>
          <span className="filter-bar__spacer" />
          {!readOnly && <>
          <button type="button" className="btn secondary sm" disabled={!dirty || save.isPending} onClick={() => { setRules(policy.rules); setDirty(false); }}>Discard</button>
          <button type="button" className="btn primary" disabled={!dirty || save.isPending}
            onClick={() => save.mutate(rules, { onSuccess: () => setDirty(false) })}>{save.isPending ? 'Saving…' : 'Save — recompute root'}</button>
          </>}
        </div>
      </section>

      <section className="table-box d04-rules reveal" aria-labelledby="d04-rules-h">
        <header className="panel__head"><h2 className="panel__title" id="d04-rules-h">Rules</h2>
          <p className="sub num">{rules.filter((r) => r.enabled).length} of {rules.length} enabled</p></header>
        <table className="table">
          <thead><tr><th>Rule</th><th>Layer</th><th>Severity</th><th className="num">Enabled</th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className={r.enabled ? undefined : 'is-off'}>
                <td className="mono">{r.name}</td>
                <td className="is-faint mono">{r.layer}</td>
                <td><VerdictChip verdict={r.verdict} /></td>
                <td className="num"><input type="checkbox" checked={r.enabled} disabled={readOnly} onChange={() => toggle(r.id)} aria-label={`toggle ${r.name}`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel d04-dry reveal" aria-labelledby="d04-dry-h">
        <header className="panel__head"><h2 className="panel__title" id="d04-dry-h">Dry run</h2><p className="sub mono">POST /policy/dry-run · not logged · not chained</p></header>
        <textarea className="input d04-dry__in" rows={3} value={payload} onChange={(e) => setPayload(e.target.value)} placeholder="Paste a tool call to screen against the current policy…" />
        <div className="d04-dry__row">
          <button type="button" className="btn secondary" disabled={!payload || dry.isPending} onClick={() => dry.mutate(payload, { onSuccess: setResult })}>
            <Icon name="play" />{dry.isPending ? 'Screening…' : 'Screen'}</button>
          {result && (
            <div className="d04-dry__out"><VerdictChip verdict={result.verdict} /><Layers layers={result.layers} /><span className="is-faint mono">not chained · no index</span></div>
          )}
        </div>
      </section>
    </div>
  );
}
