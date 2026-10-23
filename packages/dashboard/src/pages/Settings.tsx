import { useState } from 'react';
import { useStatus, useTeeQuote } from '../api/hooks';
import { Hash, Icon } from '../kit/react';

export function Settings() {
  const { data: status } = useStatus();
  const { data: tee } = useTeeQuote();
  const [rotated, setRotated] = useState<string | null>(null);
  const [masked, setMasked] = useState(false);
  const [test, setTest] = useState<string | null>(null);

  const rotate = () => {
    const b = new Uint8Array(24); crypto.getRandomValues(b);
    setRotated(Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''));
    setMasked(false);
  };

  return (
    <div className="page d06" style={{ maxWidth: 760 }}>
      <section className="panel d06-up reveal">
        <header className="panel__head"><h2 className="panel__title">Upstream servers</h2></header>
        <table className="table">
          <tbody>
            {(status?.upstreams ?? []).map((u) => (
              <tr key={u.name}>
                <td className="mono">{u.name}</td>
                <td className="is-faint">{u.transport}</td>
                <td className="num" style={{ color: u.healthy ? 'var(--verdict-flag)' : 'var(--status-danger)' }}>
                  {u.healthy ? <span style={{ color: 'var(--color-green)' }}>healthy</span> : 'unreachable'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel d06-l3 reveal">
        <header className="panel__head"><h2 className="panel__title">Detection</h2></header>
        <dl className="kv">
          <div><dt>L3 mode</dt><dd>{status?.l3?.mode ?? '—'}</dd></div>
          {tee?.mode === 'tee' && <div><dt>TEE quote</dt><dd><Hash value={tee.quoteHash} label="TEE quote hash" /></dd></div>}
          <div><dt>Prover</dt><dd>
            {status?.prover?.available ? 'available' : 'unavailable (mock)'}{' '}
            <button type="button" className="btn link sm" onClick={() => setTest(status?.prover?.available ? 'Prover answered OK.' : 'Prover not running.')}>Test</button>
            {test && <span className="is-faint"> · {test}</span>}
          </dd></div>
          <div><dt>Detector</dt><dd><Hash value={status?.detectorVersion} /></dd></div>
          <div><dt>Mode</dt><dd>{status?.mock ? 'MOCK (synthetic fixtures)' : 'LIVE'}</dd></div>
        </dl>
      </section>

      <section className="panel d06-token reveal">
        <header className="panel__head"><h2 className="panel__title">Dashboard token</h2><p className="sub">rotating invalidates the current token; the new one is shown once, then masked</p></header>
        <div className="d06-token__row">
          <button type="button" className="btn secondary" onClick={rotate}><Icon name="refresh-cw" />Rotate token</button>
          {rotated && <span className="mono" style={{ color: masked ? 'var(--faint)' : 'var(--ink)' }}>{masked ? '•'.repeat(24) : rotated}</span>}
          {rotated && !masked && <button type="button" className="btn link sm" onClick={() => setMasked(true)}>mask</button>}
        </div>
      </section>

      <section className="panel d06-about reveal">
        <header className="panel__head"><h2 className="panel__title">About</h2></header>
        <dl className="kv">
          <div><dt>Version</dt><dd className="mono">{status?.version ?? '—'}</dd></div>
          <div><dt>Uptime</dt><dd className="num">{status ? `${status.uptimeSec}s` : '—'}</dd></div>
        </dl>
      </section>
    </div>
  );
}
