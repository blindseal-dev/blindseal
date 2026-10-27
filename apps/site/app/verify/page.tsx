import type { Metadata } from 'next';
import { pageMeta } from '../meta';
import { VerifyClient } from './verify-client';

// S03 · Verify (/verify) — the mockup's static markup, server-rendered one-to-one
// (design/mockups/mockups/S03/index.html). Everything page.js painted (the idle checklist, the
// banner's demo links, panel 5's rows, the result states) is filled by VerifyClient after the kit
// mounts, so nothing here depends on time, randomness or the viewport.
export const metadata: Metadata = pageMeta({
  path: '/verify',
  title: 'Verify · Blindseal',
  description: 'Check a Blindseal proof in your browser. Nothing is uploaded, nothing is stored.',
});

export default function VerifyPage() {
  return (
    <>
      {/* ══ masthead: a flat panel band over the faint nebula (S02's band, 300 high) ══ */}
      <header className="vf-mast" aria-labelledby="vf-title">
        <div className="vf-mast__space" aria-hidden="true" />
        <div className="vf-mast__copy">
          <p className="vf-mast__eyebrow">Verify</p>
          <h1 className="vf-mast__title" id="vf-title">Don&apos;t take our word for it. Check the proof yourself.</h1>
          <p className="vf-mast__lede">Try a real Blindseal proof in your browser. Then try an altered one and watch verification fail. No wallet or installation needed.</p>
        </div>
      </header>

      {/* ══ the checker: input 5 / checklist 7 ═════════════════════════════ */}
      <div className="vf">

        {/* left: input (no animation on this panel itself: it holds a glass button) */}
        <section className="vf-in site-panel" aria-labelledby="vf-in-title">
          <div className="vf-head vf-enter">
            <p className="site-panel__n">Input</p>
            <h2 className="site-panel__title" id="vf-in-title">Your proof file</h2>
          </div>

          <button type="button" className="vf-drop vf-enter" id="vf-drop" aria-describedby="vf-drop-sub">
            <span className="vf-drop__ico"><i data-lucide="upload" /></span>
            <span className="vf-drop__title">Drop a proof file (attestation.json)</span>
            <span className="vf-drop__sub" id="vf-drop-sub">or choose a file · it is read in this tab, never uploaded</span>
          </button>
          <input type="file" id="vf-file" accept=".json,application/json" hidden />

          <div className="field vf-field vf-enter">
            <label htmlFor="vf-text">…or paste it</label>
            <textarea className="textarea mono vf-text" id="vf-text" rows={10} spellCheck={false} autoComplete="off" autoCapitalize="off" wrap="off"
              placeholder='{ "version": 1, "actionHash": "0x…", … }' aria-describedby="vf-help" defaultValue="" />
            <p className="help vf-help" id="vf-help" aria-live="polite">Paste the JSON, or try a valid or an altered proof.</p>
          </div>

          <div className="vf-actions">
            <button type="button" className="btn secondary vf-enter" id="vf-load-sample"><i data-lucide="file-check" />Try a valid proof</button>
            <button type="button" className="btn secondary vf-enter" id="vf-load-tampered"><i data-lucide="file-json" />Try an altered proof</button>
            <span className="vf-actions__spacer" />
            <button type="button" className="btn link vf-enter" id="vf-clear">Clear</button>
            <button type="button" className="glass-btn primary sm vf-enter vf-verify" id="vf-verify" disabled>Verify</button>
          </div>

          <p className="vf-note vf-enter"><i data-lucide="cpu" /><span>Verification runs in your browser. Checking whether the proof was already used on Solana is optional, and it is the only step that goes online.</span></p>
        </section>

        {/* right: checklist */}
        <section className="vf-out site-panel" aria-labelledby="vf-out-title">
          <div className="vf-head vf-head--split vf-enter">
            <div>
              <p className="site-panel__n">Checklist</p>
              <h2 className="site-panel__title" id="vf-out-title">What was checked</h2>
            </div>
            <span className="vf-source" id="vf-source" hidden />
          </div>

          <div className="vf-banner vf-enter" id="vf-banner" data-tone="idle" role="status" aria-live="polite">
            <span className="vf-banner__mark" aria-hidden="true" />
            <div className="vf-banner__main">
              <p className="vf-banner__title">Waiting for a proof</p>
              <p className="vf-banner__sub">Try a valid or an altered proof, drop a file, or paste JSON. The checks fill in, in order.</p>
            </div>
            <span className="vf-banner__end" />
          </div>

          <ol className="checklist vf-checks vf-enter" id="vf-checks" aria-label="Verification steps" />

          <section className="vf-hidden" id="vf-hidden" aria-labelledby="vf-hidden-title" hidden>
            <div className="vf-hidden__head">
              <p className="vf-hidden__n">05</p>
              <h3 className="vf-hidden__title" id="vf-hidden-title">What the proof covers</h3>
              <p className="vf-hidden__lede">The proof file carries the proof and digital fingerprints. The private details stay on the computer that checked the request.</p>
            </div>
            <ul className="vf-hidden__rows" id="vf-hidden-rows" />
            <div className="vf-hidden__foot">
              <p className="vf-hidden__k">Public</p>
              <p className="vf-hidden__pub">That a valid proof exists · Fingerprint of the security rules · Version of the checking software · Fingerprint of the action, its time limit, and a marker that prevents reuse</p>
            </div>
          </section>
        </section>

      </div>
      <VerifyClient />
    </>
  );
}
