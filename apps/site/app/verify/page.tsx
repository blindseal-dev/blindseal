import type { Metadata } from 'next';
import { VerifyClient } from './verify-client';

// S03 · Verify (/verify) — the mockup's static markup, server-rendered one-to-one
// (design/mockups/mockups/S03/index.html). Everything page.js painted (the idle checklist, the
// banner's demo links, panel 5's rows, the result states) is filled by VerifyClient after the kit
// mounts, so nothing here depends on time, randomness or the viewport.
export const metadata: Metadata = {
  title: 'Verify · Blindseal',
  description: 'Check a Blindseal attestation in your browser. Nothing is uploaded, nothing is stored.',
};

export default function VerifyPage() {
  return (
    <>
      {/* ══ masthead: a flat panel band over the faint nebula (S02's band, 300 high) ══ */}
      <header className="vf-mast" aria-labelledby="vf-title">
        <div className="vf-mast__space" aria-hidden="true" />
        <div className="vf-mast__copy">
          <p className="vf-mast__eyebrow">Verify</p>
          <h1 className="vf-mast__title" id="vf-title">Check an attestation.</h1>
          <p className="vf-mast__lede">Runs in your browser. Nothing is uploaded, nothing is stored.</p>
        </div>
      </header>

      {/* ══ the checker: input 5 / checklist 7 ═════════════════════════════ */}
      <div className="vf">

        {/* left: input (no animation on this panel itself: it holds a glass button) */}
        <section className="vf-in site-panel" aria-labelledby="vf-in-title">
          <div className="vf-head vf-enter">
            <p className="site-panel__n">Input</p>
            <h2 className="site-panel__title" id="vf-in-title">Your attestation</h2>
          </div>

          <button type="button" className="vf-drop vf-enter" id="vf-drop" aria-describedby="vf-drop-sub">
            <span className="vf-drop__ico"><i data-lucide="upload" /></span>
            <span className="vf-drop__title">Drop attestation.json</span>
            <span className="vf-drop__sub" id="vf-drop-sub">or choose a file · it is read in this tab, never uploaded</span>
          </button>
          <input type="file" id="vf-file" accept=".json,application/json" hidden />

          <div className="field vf-field vf-enter">
            <label htmlFor="vf-text">…or paste it</label>
            <textarea className="textarea mono vf-text" id="vf-text" rows={10} spellCheck={false} autoComplete="off" autoCapitalize="off" wrap="off"
              placeholder='{ "version": 1, "actionHash": "0x…", … }' aria-describedby="vf-help" defaultValue="" />
            <p className="help vf-help" id="vf-help" aria-live="polite">Paste the JSON, or load a sample below.</p>
          </div>

          <div className="vf-actions">
            <button type="button" className="btn secondary vf-enter" id="vf-load-sample"><i data-lucide="file-check" />Load sample</button>
            <button type="button" className="btn secondary vf-enter" id="vf-load-tampered"><i data-lucide="file-json" />Load tampered</button>
            <span className="vf-actions__spacer" />
            <button type="button" className="btn link vf-enter" id="vf-clear">Clear</button>
            <button type="button" className="glass-btn primary sm vf-enter vf-verify" id="vf-verify" disabled>Verify</button>
          </div>

          <p className="vf-note vf-enter"><i data-lucide="cpu" /><span>Verification runs in the browser via the WASM verifier. The nullifier check is optional and is the only step that touches the network.</span></p>
        </section>

        {/* right: checklist */}
        <section className="vf-out site-panel" aria-labelledby="vf-out-title">
          <div className="vf-head vf-head--split vf-enter">
            <div>
              <p className="site-panel__n">Checklist</p>
              <h2 className="site-panel__title" id="vf-out-title">What the verifier finds</h2>
            </div>
            <span className="vf-source" id="vf-source" hidden />
          </div>

          <div className="vf-banner vf-enter" id="vf-banner" data-tone="idle" role="status" aria-live="polite">
            <span className="vf-banner__mark" aria-hidden="true" />
            <div className="vf-banner__main">
              <p className="vf-banner__title">Waiting for an attestation</p>
              <p className="vf-banner__sub">Load a sample, drop a file or paste JSON. The checks fill in, in order.</p>
            </div>
            <span className="vf-banner__end" />
          </div>

          <ol className="checklist vf-checks vf-enter" id="vf-checks" aria-label="Verification steps" />

          <section className="vf-hidden" id="vf-hidden" aria-labelledby="vf-hidden-title" hidden>
            <div className="vf-hidden__head">
              <p className="vf-hidden__n">05</p>
              <h3 className="vf-hidden__title" id="vf-hidden-title">What this does not reveal</h3>
              <p className="vf-hidden__lede">The attestation carries hashes and a proof. These stay on the machine that screened the call.</p>
            </div>
            <ul className="vf-hidden__rows" id="vf-hidden-rows" />
            <div className="vf-hidden__foot">
              <p className="vf-hidden__k">Public</p>
              <p className="vf-hidden__pub">That a valid attestation exists · Policy root (a hash) · Detector version · Action hash, expiry, nullifier</p>
            </div>
          </section>
        </section>

      </div>
      <VerifyClient />
    </>
  );
}
