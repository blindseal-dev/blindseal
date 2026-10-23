import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDecision } from '../api/hooks';
import { Hash } from '../components/Hash';
import { LayerStrip } from '../components/LayerStrip';
import { VerdictChip } from '../components/VerdictChip';

export function DecisionDetail() {
  const { id } = useParams();
  const { data: d, isLoading, error } = useDecision(id);

  if (isLoading) return <div className="bs-empty">Loading…</div>;
  if (error || !d) return <div className="bs-empty">Decision not found.</div>;

  return (
    <div style={{ maxWidth: 760 }}>
      <Link to="/decisions" className="bs-muted" style={{ textDecoration: 'none' }}>
        ← Decisions
      </Link>
      <div className="bs-pagehead" style={{ marginTop: 14 }}>
        <h2 style={{ margin: 0 }}>
          {d.server} <span className="bs-faint">·</span> <span className="bs-mono bs-muted">{d.tool}</span>
        </h2>
        <VerdictChip verdict={d.verdict} />
      </div>

      <div className="bs-panel" style={{ padding: 18, marginBottom: 16 }}>
        <div style={{ marginBottom: 12 }}>
          <LayerStrip layers={d.layers} />
        </div>
        <table className="bs-table">
          <tbody>
            {d.layers.map((l) => (
              <tr key={l.layer} style={{ cursor: 'default' }}>
                <td className="bs-mono">{l.layer}</td>
                <td className="bs-muted">{l.ran ? l.verdict : 'skipped'}</td>
                <td className="bs-faint bs-mono">{l.ruleIds?.join(', ') ?? (l.score != null ? `score ${l.score}` : '')}</td>
                <td className="bs-faint bs-mono" style={{ textAlign: 'right' }}>{l.latencyMs} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bs-panel" style={{ padding: 18 }}>
        <Row label="Payload hash"><Hash value={d.payloadHash} lg /></Row>
        {d.redactions.length > 0 && (
          <Row label="Redacted">
            <span className="bs-muted">{d.redactions.map((r) => `${r.kind}×${r.count}`).join(', ')}</span>
          </Row>
        )}
        <Row label="Policy root"><Hash value={d.policyRoot} lg /></Row>
        <Row label="Detector"><Hash value={d.detectorVersion} lg /></Row>
        <Row label="Audit"><span className="bs-muted">#{d.auditIndex}</span> <Hash value={d.auditHash} /></Row>
        {d.action && (
          <Row label="Action">
            <span className="bs-mono bs-muted">
              {d.action.instruction} · {d.action.amount} · → <Hash value={d.action.recipient} />
            </span>
          </Row>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 12, padding: '7px 0', alignItems: 'center' }}>
      <span className="bs-faint" style={{ fontSize: 12 }}>{label}</span>
      <span>{children}</span>
    </div>
  );
}
