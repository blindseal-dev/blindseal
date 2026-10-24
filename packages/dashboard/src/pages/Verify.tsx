import { useState } from 'react';
import { api } from '../api/client';
import type { Attestation } from '../api/types';
import { Icon } from '../kit/react';
import { verifyAttestation, tamper, type VerifyResult } from '../verify/verifier';

// The verify page stores nothing: the pasted JSON and the result live in component state only.
// Verification runs the real Groth16 check in-browser via blindseal-verifier-wasm.
export function Verify() {
  const [text, setText] = useState('');
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (json: string) => {
    setBusy(true);
    try { setResult(await verifyAttestation(json)); }
    finally { setBusy(false); } // never leave the button stuck on "Verifying…"
  };
  const loadSample = async (t: boolean) => {
    const a = await api.get<Attestation>('/attestations/sample');
    const json = JSON.stringify(a, null, 2);
    const use = t ? tamper(json) : json;
    setText(use);
    run(use);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f) f.text().then((t) => { setText(t); run(t); });
  };

  return (
    <div className="page s03" style={{ maxWidth: 820 }}>
      <section className="panel s03-drop reveal" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <header className="panel__head"><h2 className="panel__title">Verify an attestation</h2>
          <p className="sub">drop or paste an attestation.json · verified in your browser · nothing is stored or uploaded</p></header>
        <textarea className="input s03-ta" rows={8} value={text} placeholder='Paste attestation.json here…' spellCheck={false}
          onChange={(e) => setText(e.target.value)} style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }} />
        <div className="s03-actions">
          <button type="button" className="btn primary" disabled={!text || busy} onClick={() => run(text)}>{busy ? 'Verifying…' : 'Verify'}</button>
          <button type="button" className="btn secondary" onClick={() => loadSample(false)}>Load sample</button>
          <button type="button" className="btn secondary" onClick={() => loadSample(true)}>Load tampered</button>
          <button type="button" className="btn secondary" onClick={async () => {
            // a signed, content-free disclosure of the last ten audit entries (accepted here too)
            const head = await api.get<{ index: number }>('/audit/head');
            const d = await api.post<unknown>('/audit/disclose', { from: Math.max(0, head.index - 9), to: head.index });
            const json = JSON.stringify(d, null, 2); setText(json); run(json);
          }}>Load disclosure</button>
          <button type="button" className="btn link" onClick={() => { setText(''); setResult(null); }}>Clear</button>
        </div>
      </section>

      {result && (
        <section className="panel s03-result reveal" aria-live="polite">
          <header className="panel__head">
            <h2 className="panel__title">{result.error ? 'Could not read' : result.valid ? 'Valid' : 'Invalid'}</h2>
            <span className={`verdict ${result.valid && !result.error ? 'pass' : 'block'}`}>{result.error ? 'error' : result.valid ? 'verifies' : 'fails'}</span>
          </header>
          {result.error ? <p className="is-muted">{result.error}</p> : (
            <ol className="s03-checklist">
              {result.steps.map((s) => (
                <li key={s.id} className="s03-step" data-ok={String(s.ok)}>
                  <Icon name={s.ok === true ? 'circle-check' : s.ok === false ? 'triangle-alert' : 'minus'} />
                  <div><p className="s03-step__t">{s.label}</p><p className="s03-step__d is-faint">{s.detail}</p></div>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      <section className="panel s03-reveal reveal">
        <header className="panel__head"><h2 className="panel__title">What this does not reveal</h2></header>
        <ul className="s03-hidden">
          <li>The prompt and tool arguments</li>
          <li>The policy contents, thresholds and custom lists</li>
          <li>Which agent or operator was screened</li>
          <li>The model-layer scores</li>
        </ul>
        <p className="is-faint">Only hashes are in the attestation: the action, the policy root, the detector version, the expiry and the nullifier.</p>
      </section>
    </div>
  );
}
