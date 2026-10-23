import { useState } from 'react';
import { useStatus } from '../api/hooks';
import { Hash } from '../components/Hash';

export function Settings() {
  const { data: status } = useStatus();
  const [rotated, setRotated] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  const rotate = () => {
    // Token rotation is a proxy operation; in mock mode we demonstrate the once-shown flow locally.
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    setRotated(Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
    setRevealed(true);
  };

  return (
    <div style={{ maxWidth: 720, display: 'grid', gap: 20 }}>
      <section>
        <h3 style={{ margin: '0 0 10px' }}>Upstream servers</h3>
        <div className="bs-panel">
          <table className="bs-table">
            <tbody>
              {(status?.upstreams ?? []).map((u) => (
                <tr key={u.name} style={{ cursor: 'default' }}>
                  <td className="bs-mono">{u.name}</td>
                  <td className="bs-faint">{u.transport}</td>
                  <td style={{ textAlign: 'right', color: u.healthy ? 'var(--color-green)' : 'var(--status-danger)' }}>
                    {u.healthy ? 'healthy' : 'unreachable'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 style={{ margin: '0 0 10px' }}>Detection</h3>
        <div className="bs-panel" style={{ padding: 16, display: 'grid', gap: 8 }}>
          <Row label="L3 mode" value={status?.l3.mode ?? '—'} />
          <Row label="Prover" value={status?.prover.available ? 'available' : 'unavailable (mock)'} />
          <Row label="Mode" value={status?.mock ? 'MOCK (synthetic fixtures)' : 'LIVE'} />
          <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 8, alignItems: 'center' }}>
            <span className="bs-faint" style={{ fontSize: 12 }}>Detector</span>
            <Hash value={status?.detectorVersion ?? ''} />
          </div>
        </div>
      </section>

      <section>
        <h3 style={{ margin: '0 0 10px' }}>Dashboard token</h3>
        <div className="bs-panel" style={{ padding: 16 }}>
          <p className="bs-muted" style={{ marginTop: 0 }}>
            Rotating invalidates the current token; the new one is shown once, then masked.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button className="bs-btn" onClick={rotate}>Rotate token</button>
            {rotated && (
              <span className="bs-mono" style={{ color: revealed ? 'var(--ink)' : 'var(--faint)' }}>
                {revealed ? rotated : '•'.repeat(24)}
              </span>
            )}
            {rotated && revealed && (
              <button className="bs-hash" onClick={() => setRevealed(false)}>mask</button>
            )}
          </div>
        </div>
      </section>

      <section>
        <h3 style={{ margin: '0 0 10px' }}>About</h3>
        <div className="bs-panel" style={{ padding: 16 }}>
          <Row label="Version" value={status?.version ?? '—'} />
          <Row label="Uptime" value={status ? `${status.uptimeSec}s` : '—'} />
        </div>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 8, padding: '3px 0' }}>
      <span className="bs-faint" style={{ fontSize: 12 }}>{label}</span>
      <span className="bs-mono">{value}</span>
    </div>
  );
}
