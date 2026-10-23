'use client';
import { useState } from 'react';
import { verifyAttestation, tamper, type VerifyResult } from './verifier';
import sample from './sample.json';

const CANON = JSON.stringify(sample);

export default function VerifyPage() {
  const [text, setText] = useState('');
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (json: string) => { setBusy(true); try { setResult(await verifyAttestation(json)); } finally { setBusy(false); } };
  const load = (t: boolean) => { const j = t ? tamper(CANON) : JSON.stringify(sample, null, 2); setText(j); run(j); };
  const onDrop = (e: React.DragEvent) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) f.text().then((t) => { setText(t); run(t); }); };

  return (
    <section className="site-section s03" aria-labelledby="v-h">
      <div className="section-head"><div className="section-head__lead"><p className="section-head__eyebrow"><b>·</b> / Verify</p>
        <h1 className="section-head__title" id="v-h">Verify an attestation.</h1></div>
        <p className="section-head__body">Drop or paste an <code>attestation.json</code>. It is verified in your browser — nothing is uploaded or stored.</p></div>

      <div className="site-panel s03-drop" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <textarea className="input s03-ta" rows={8} value={text} placeholder="Paste attestation.json…" spellCheck={false}
          onChange={(e) => setText(e.target.value)} style={{ fontFamily: 'var(--font-mono)', fontSize: 13, width: '100%' }} />
        <div className="s03-actions">
          <button type="button" className="btn primary" disabled={!text || busy} onClick={() => run(text)}>{busy ? 'Verifying…' : 'Verify'}</button>
          <button type="button" className="btn secondary" onClick={() => load(false)}>Load sample</button>
          <button type="button" className="btn secondary" onClick={() => load(true)}>Load tampered</button>
          <button type="button" className="btn link" onClick={() => { setText(''); setResult(null); }}>Clear</button>
        </div>
      </div>

      {result && (
        <div className="site-panel s03-result" aria-live="polite">
          <h2 className="panel__title">{result.error ? 'Could not read' : result.valid ? 'Valid' : 'Invalid'}</h2>
          {result.error ? <p className="is-muted">{result.error}</p> : (
            <ol className="s03-checklist">
              {result.steps.map((s) => (
                <li key={s.id} className="s03-step" data-ok={String(s.ok)}>
                  <i data-lucide={s.ok === true ? 'circle-check' : s.ok === false ? 'triangle-alert' : 'minus'} />
                  <div><p className="s03-step__t">{s.label}</p><p className="s03-step__d is-faint">{s.detail}</p></div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <div className="site-panel s03-hidden-panel">
        <h2 className="panel__title">What this does not reveal</h2>
        <ul className="s03-hidden"><li>The prompt and tool arguments</li><li>The policy contents and thresholds</li><li>Which agent or operator was screened</li><li>The model-layer scores</li></ul>
      </div>
    </section>
  );
}
