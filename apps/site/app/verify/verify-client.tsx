'use client';
import { usePageKit, type BSAny } from '../use-page-kit';
import { schemaCheck, verifyProof, decodePublicInputs, verifyDisclosureSteps, tamper, type AttestationDoc, type Decoded } from './verifier';
import type { Disclosure } from './disclosure';
import sample from './sample.json';

/* ============================================================================
   S03 · Verify — the mockup's page.js, run through usePageKit against the REAL verifier.
   One run (token-guarded, so Clear or a new load cancels the old one) walks the steps in order:
     1  Schema valid           schemaCheck(text)            (running ≥ 240 ms)
     2  Proof verifies         verifyProof(text) — the groth16 check in the wasm (held ≥ 600 ms, sweep)
     3  Public inputs decoded  the 168-byte blob → six fields, cross-checked with the file; the .kv grid
     4  Nullifier status       NOT automatic: "Check on mainnet" in the row → GET /verify/nullifier
                               (a same-origin server read, held ≥ 900 ms) → unused / consumed at slot …,
                               or "RPC unavailable · try again"
     5  "What this does not reveal" — a panel, shown once step 1 passes, kept through every later failure.
   A pasted disclosure.json runs its own four steps (schema, ed25519 signature, hash chain, clean window).
   A failed step stops the ones after it (they go to "skip"), never panel 5.
   Nothing touches storage; the attestation lives in this tab's memory only.
   ========================================================================== */

const SAMPLE_PRETTY = JSON.stringify(sample, null, 2);
const TAMPERED = tamper(JSON.stringify(sample));

type Step = { n: number; title: string; idle: string };
const STEPS: Step[] = [
  { n: 1, title: 'Schema valid', idle: 'Version 1, groth16 on bn254, every required field present.' },
  { n: 2, title: 'Proof verifies', idle: 'In this tab, via @blindseal/verifier-wasm (the real groth16 check).' },
  { n: 3, title: 'Public inputs decoded', idle: 'Payload hash, policy root, detector version, action hash, nullifier, expiry slot.' },
  { n: 4, title: 'Nullifier status on chain', idle: 'Optional · reads mainnet through this site · the only step that touches the network.' },
];
const DSTEPS: Step[] = [
  { n: 1, title: 'Schema valid', idle: 'A disclosure window: head, entries, signer and signature present.' },
  { n: 2, title: 'Signature verifies', idle: 'ed25519 over the canonical window, by the stated proxy identity.' },
  { n: 3, title: 'Entries recomputed', idle: 'Every entry hash reproduces from its six fields and links to the previous one.' },
  { n: 4, title: 'Clean window', idle: 'Every disclosed decision passed.' },
];
const HIDDEN: [string, string][] = [
  ['Prompt', 'What the agent was asked.'],
  ['Tool arguments', 'What the call actually carried.'],
  ['Policy contents', 'Rules and thresholds stay local.'],
  ['Agent identity', 'Which agent was screened.'],
];

export function VerifyClient() {
  usePageKit((BS: BSAny) => {
    const M = BS.motion, ui = BS.ui, fmt = BS.fmt || ui.fmt;
    const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T;
    const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll(s)) as T[];
    const esc = (s: unknown) => ui.esc(String(s ?? ''));
    const ico = (n: string) => (BS.icon ? BS.icon(n) : '');
    const hash = (v: string, label: string) => ui.hash(v, { label, lg: true });
    const reduced = (): boolean => M.reduced();
    const now = () => (window.performance && performance.now ? performance.now() : Date.now());
    const timers: number[] = [];
    const later = (fn: () => void, ms: number) => { timers.push(window.setTimeout(fn, ms)); };

    /* ── masthead field + the entrance ───────────────────────────────────── */
    const mast = $('.vf-mast'), grid = $('.vf');
    if (!mast || !grid) return;
    const space = $('.vf-mast__space');
    if (BS.mountSpace && space && !space.hasAttribute('data-space-mounted')) { space.setAttribute('data-space-mounted', ''); BS.mountSpace(space, { intensity: 'faint', fade: false }); }
    $$('.vf-enter').forEach((el, i) => { el.style.setProperty('--e', String(Math.min(i, 6))); });
    if (!reduced()) {
      mast.classList.add('is-rising'); grid.classList.add('is-rising');
      // drop the class once the entrance has played, so no finished animation lingers on the glass button
      later(() => { grid.classList.remove('is-rising'); }, M.scale(260 + 6 * 40 + 400 + 80));
    }

    /* ── refs ────────────────────────────────────────────────────────────── */
    const drop = $('#vf-drop'), file = $<HTMLInputElement>('#vf-file'), text = $<HTMLTextAreaElement>('#vf-text'), help = $('#vf-help');
    const btnSample = $<HTMLButtonElement>('#vf-load-sample'), btnTampered = $<HTMLButtonElement>('#vf-load-tampered'), btnVerify = $<HTMLButtonElement>('#vf-verify'), btnClear = $<HTMLButtonElement>('#vf-clear');
    const out = $('.vf-out'), banner = $('#vf-banner'), source = $('#vf-source'), list = $<HTMLOListElement>('#vf-checks');
    const hiddenPanel = $('#vf-hidden'), hiddenRows = $('#vf-hidden-rows');

    hiddenRows.innerHTML = HIDDEN.map((r, i) =>
      '<li class="vf-hidden__row" style="--i:' + i + '"><span class="vf-hidden__name">' + esc(r[0]) + '</span>' +
      '<span class="vf-hidden__why">' + esc(r[1]) + '</span><span class="chip neutral">hidden</span></li>').join('');

    let steps: Step[] = STEPS;
    const li = (i: number) => list.children[i] as HTMLElement;
    function paintIdle(set: Step[] = STEPS) {
      steps = set;
      list.innerHTML = set.map((s) => ui.checkItem({ n: s.n, title: s.title, detail: s.idle, state: 'pending' })).join('');
      // step 3 gets its kv slot; step 4 gets its on-demand button row
      const main3 = $('.check__main', li(2));
      const kv = document.createElement('div'); kv.className = 'kv vf-kv'; kv.hidden = true; main3.appendChild(kv);
      const main4 = $('.check__main', li(3));
      const row = document.createElement('div'); row.className = 'vf-n4'; row.hidden = true;
      row.innerHTML = '<button type="button" class="btn secondary sm" data-n4>' + ico('radio') + '<span>Check on mainnet</span></button>';
      main4.appendChild(row);
      $('[data-n4]', row).addEventListener('click', checkNullifier);
    }
    paintIdle();

    /* a state change: the kit's ui.check + the detail / reason line rising in (rise-8, 220 out-expo) */
    function setCheck(i: number, state: string, o: { reason?: string; end?: string; detail?: string; html?: boolean } = {}) {
      const el = li(i);
      ui.check(el, state, { reason: o.reason != null ? o.reason : '', end: o.end != null ? o.end : '', detail: o.detail, html: o.html });
      if (state === 'skip') $('.check__end', el).textContent = 'Skipped';
      if (state === 'pass' || state === 'fail' || state === 'skip') {
        ['.check__detail', '.check__reason'].forEach((s) => { const x = el.querySelector(s); if (x) M.restart(x, 'is-new'); });
      }
    }

    /* ── banner ──────────────────────────────────────────────────────────── */
    function setBanner(tone: string, title: string, sub: string, end?: string) {
      banner.setAttribute('data-tone', tone);
      $('.vf-banner__mark', banner).innerHTML = tone === 'pass' ? ico('check') : tone === 'fail' ? ico('circle-alert') : '';
      $('.vf-banner__title', banner).textContent = title;
      $('.vf-banner__sub', banner).textContent = sub;
      $('.vf-banner__end', banner).textContent = end || '';
      banner.classList.remove('is-drop', 'is-fade');
      if (tone === 'idle') return;
      M.restart(banner, tone === 'running' ? 'is-fade' : 'is-drop');
    }
    function idleBanner() {
      setBanner('idle', 'Waiting for an attestation', '');
      // the demo path above the fold: the same handlers as the input panel's buttons
      $('.vf-banner__sub', banner).innerHTML =
        '<button type="button" class="btn link vf-banner__link" data-demo="sample">Load a sample</button>' +
        '<span class="vf-banner__dot" aria-hidden="true">·</span>' +
        '<button type="button" class="btn link vf-banner__link" data-demo="tampered">Load the tampered one</button>';
    }
    const onBannerClick = (e: Event) => {
      const b = (e.target as Element).closest && (e.target as Element).closest('[data-demo]');
      if (!b) return;
      if (b.getAttribute('data-demo') === 'sample') loadSample(); else loadTampered();
    };
    banner.addEventListener('click', onBannerClick);

    function setSource(kind: string | null, label?: string) {
      if (!kind) { source.hidden = true; source.textContent = ''; source.removeAttribute('data-tip'); return; }
      source.hidden = false;
      source.innerHTML = ico(kind === 'file' || kind === 'pasted' ? 'file-json' : 'file-check') + '<span class="vf-source__name">' + esc(label) + '</span>';
      source.setAttribute('data-tip', label || '');
    }

    /* ── textarea → the Verify gate ──────────────────────────────────────── */
    function parses(s: string) { try { const v = JSON.parse(s); return !!v && typeof v === 'object'; } catch { return false; } }
    let running = false, hasResult = false, runTok = 0, decoded: Decoded | null = null;
    function syncGate() {
      const v = text.value.trim();
      const ok = v.length > 0 && parses(v);
      btnVerify.disabled = !ok || running;
      help.classList.toggle('is-warn', v.length > 0 && !ok);
      help.textContent = !v.length ? 'Paste the JSON, or load a sample below.' :
        ok ? (fmt.bytes ? fmt.bytes(new Blob([v]).size) : v.length + ' chars') + ' of JSON, held in this tab only.' :
          'Not valid JSON yet. Verify unlocks when it parses.';
    }
    const onInput = () => {
      if (hasResult || running) resetResults(false);
      setSource(text.value.trim() ? 'pasted' : null, 'pasted');
      syncGate();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !btnVerify.disabled) { e.preventDefault(); verifyCurrent(); }
    };
    text.addEventListener('input', onInput);
    text.addEventListener('keydown', onKey);

    /* ── reset: fade-out 140 in-quick, then the idle checklist (instant under reduce) ── */
    function resetResults(animate: boolean) {
      const tok = ++runTok;
      running = false; hasResult = false; decoded = null;
      btnVerify.removeAttribute('aria-busy');
      const finish = () => {
        if (tok !== runTok) return;
        out.classList.remove('is-clearing');
        paintIdle(); idleBanner(); hiddenPanel.hidden = true; hiddenPanel.classList.remove('is-in');
        syncGate();
      };
      if (animate && !reduced()) { out.classList.add('is-clearing'); later(finish, M.scale(140)); }
      else finish();
      return tok;
    }

    /* ── the run ─────────────────────────────────────────────────────────── */
    const stale = (tok: number) => tok !== runTok;
    /* a step's running hold is a timer, not an animation: under reduce it keeps its unscaled length */
    const hold = (ms: number): Promise<void> => (reduced() ? new Promise((r) => later(r, ms)) : M.wait(ms));
    const skipFrom = (from: number, why: string) => { for (let i = from; i < 4; i++) setCheck(i, 'skip', { detail: why }); };

    async function run(json: string, kind: string, label: string) {
      const tok = resetResults(false);
      setSource(kind, label);
      running = true; syncGate(); btnVerify.setAttribute('aria-busy', 'true');
      setBanner('running', 'Verifying in this tab', 'Step 1 of 3 · Schema valid', '');

      // 1 · schema
      setCheck(0, 'running');
      await hold(240);
      if (stale(tok)) return;
      const sc = schemaCheck(json);
      if (sc.kind === 'disclosure') { paintIdle(DSTEPS); setCheck(0, 'running'); }
      if (!sc.ok) {
        const more = sc.errors.length > 1 ? ' (+' + (sc.errors.length - 1) + ' more)' : '';
        setCheck(0, 'fail', { detail: 'The file does not match the ' + (sc.kind === 'disclosure' ? 'Disclosure' : 'Attestation') + ' schema.', reason: sc.errors[0] + more });
        skipFrom(1, 'Skipped: the schema check failed.');
        return done(tok, false, 1, 'Schema valid');
      }
      if (sc.kind === 'disclosure') return runDisclosure(tok, sc.doc as Disclosure);
      const att = sc.doc as AttestationDoc;
      setCheck(0, 'pass', { detail: 'version 1 · groth16 · bn254 · one 168-byte public-input blob · required fields present' });
      showHidden();

      // 2 · proof — the wasm groth16 check, held ≥ 600 ms so the sweep reads
      setCheck(1, 'running');
      setBanner('running', 'Verifying in this tab', 'Step 2 of 3 · Proof verifies', '');
      let t0 = now();
      const [res] = await Promise.all([verifyProof(json), hold(600)]);
      if (stale(tok)) return;
      let ms = fmt.ms(Math.round(now() - t0));
      if (!res.ok) {
        setCheck(1, 'fail', { detail: res.loadError ? 'The verifier could not be loaded in this tab.' : 'The proof does not verify against its public inputs.', reason: res.reason || 'proof did not verify', end: res.loadError ? '' : ms });
        skipFrom(2, 'Skipped: the proof did not verify.');
        return done(tok, false, 2, 'Proof verifies');
      }
      setCheck(1, 'pass', { detail: 'The groth16 proof verifies against the committed public-input blob and the detector vkey.', end: ms });

      // 3 · decode
      setCheck(2, 'running');
      setBanner('running', 'Verifying in this tab', 'Step 3 of 3 · Public inputs decoded', '');
      await hold(220);
      if (stale(tok)) return;
      const dec = decodePublicInputs(att);
      if (dec.mismatches.length) {
        const more = dec.mismatches.length > 1 ? ' (+' + (dec.mismatches.length - 1) + ' more)' : '';
        setCheck(2, 'fail', { detail: 'The blob decodes, but the file’s fields do not match it.', reason: dec.mismatches[0] + more });
        renderKv(dec);
        skipFrom(3, 'Skipped: the public inputs did not match.');
        return done(tok, false, 3, 'Public inputs decoded');
      }
      decoded = dec;
      setCheck(2, 'pass', { detail: 'Six fields from one blob, exactly as the on-chain program reads them; each matches the file.' });
      renderKv(dec);
      // 4 · on demand
      $('.vf-n4', li(3)).hidden = false;
      setCheck(3, 'pending', { detail: STEPS[3].idle });
      done(tok, true);
    }

    async function runDisclosure(tok: number, d: Disclosure) {
      setCheck(0, 'pass', { detail: 'window #' + d.from + '–#' + d.to + ' · ' + d.entries.length + ' content-free entries · signer and signature present' });
      showHidden();
      setCheck(1, 'running');
      setBanner('running', 'Verifying in this tab', 'Step 2 of 4 · Signature verifies', '');
      const t0 = now();
      const [v] = await Promise.all([verifyDisclosureSteps(d), hold(600)]);
      if (stale(tok)) return;
      const ms = fmt.ms(Math.round(now() - t0));
      if (!v.sigOk) {
        setCheck(1, 'fail', { detail: 'The signature does not verify over the canonical window.', reason: v.reason || 'signature mismatch', end: ms });
        skipFrom(2, 'Skipped: the signature did not verify.');
        return done(tok, false, 2, 'Signature verifies');
      }
      setCheck(1, 'pass', { detail: 'ed25519 over the canonical window · signer ' + d.signerPubkey.slice(0, 16) + '…', end: ms });
      setCheck(2, 'running');
      setBanner('running', 'Verifying in this tab', 'Step 3 of 4 · Entries recomputed', '');
      await hold(220);
      if (stale(tok)) return;
      if (v.chainOk === false) {
        setCheck(2, 'fail', { detail: 'An entry does not reproduce from its fields, or does not link.', reason: v.reason || 'hash mismatch' });
        skipFrom(3, 'Skipped: the chain did not recompute.');
        return done(tok, false, 3, 'Entries recomputed');
      }
      setCheck(2, 'pass', { detail: d.entries.length + ' entries recomputed from their six fields; every prevHash links to the previous hash.' });
      setCheck(3, 'running');
      setBanner('running', 'Verifying in this tab', 'Step 4 of 4 · Clean window', '');
      await hold(220);
      if (stale(tok)) return;
      const nonPass = d.entries.filter((e) => e.verdict !== 'pass').length;
      if (v.clean) setCheck(3, 'pass', { detail: 'Every disclosed decision passed.' });
      else setCheck(3, 'fail', { detail: 'The disclosure is valid, but the window is not clean.', reason: nonPass + ' non-pass verdict' + (nonPass === 1 ? '' : 's') + ' in the window' });
      running = false; hasResult = true;
      btnVerify.removeAttribute('aria-busy'); syncGate();
      // a signed, linking window is a valid disclosure either way; only the clean-window claim differs
      setBanner('pass', 'Valid disclosure', v.clean ? 'Signature, chain and window check out. No content was disclosed.' : 'Signature and chain check out. The window is not clean: ' + nonPass + ' non-pass verdict' + (nonPass === 1 ? '' : 's') + '.', (v.clean ? '4' : '3') + ' of 4');
    }

    function done(tok: number, ok: boolean, failedAt?: number, failedName?: string) {
      if (stale(tok)) return;
      running = false; hasResult = true;
      btnVerify.removeAttribute('aria-busy'); syncGate();
      if (ok) setBanner('pass', 'Valid attestation', 'Schema, proof and public inputs check out. The nullifier check is optional.', '3 of 3');
      else setBanner('fail', 'Does not verify', 'Failed at step ' + failedAt + ', ' + failedName + '.' + ((failedAt as number) < 3 ? ' Later steps were skipped.' : ''), 'Step ' + failedAt);
    }

    /* panel 5: once step 1 passes; never removed by a later failure */
    function showHidden() {
      if (!hiddenPanel.hidden) return;
      hiddenPanel.hidden = false;
      if (!reduced()) M.restart(hiddenPanel, 'is-in');
    }

    /* step 3's grid: every hex through BS.ui.hash (.lg), the slot as a mono number */
    function renderKv(dec: Decoded) {
      const kv = $('.vf-kv', li(2));
      const items: [string, string][] = [
        ['Action hash', hash(dec.actionHash, 'Action hash')],
        ['Policy root', hash(dec.policyRoot, 'Policy root')],
        ['Nullifier', hash(dec.nullifier, 'Nullifier')],
        ['Detector version', hash(dec.detectorVersion, 'Detector version hash')],
        ['Payload hash', hash(dec.payloadHash, 'Payload hash')],
        ['Expiry slot', '<span class="vf-mono num">' + esc(fmt.slot(dec.expirySlot)) + '</span>'],
        ['Proof', '<span class="vf-mono">groth16 · bn254 · ' + esc(fmt.bytes(dec.proofBytes)) + '</span>'],
      ];
      kv.innerHTML = items.map((p, i) =>
        '<div class="kv__item" style="--i:' + i + '"><span class="kv__k">' + esc(p[0]) + '</span><span class="kv__v">' + p[1] + '</span></div>').join('') +
        '<div class="vf-kv__foot"><p class="help">Download them as text; the attestation itself stays here.</p>' +
        '<button type="button" class="btn ghost sm" data-dl>' + ico('download') + '<span>Public inputs .txt</span></button></div>';
      kv.hidden = false;
      kv.classList.remove('is-in');
      if (!reduced()) M.restart(kv, 'is-in');
      $('[data-dl]', kv).addEventListener('click', () => { downloadInputs(dec); });
    }

    function downloadInputs(dec: Decoded) {
      const lines = [
        'Blindseal attestation: decoded public inputs',
        'payloadHash      ' + dec.payloadHash,
        'policyRoot       ' + dec.policyRoot,
        'detectorVersion  ' + dec.detectorVersion,
        'actionHash       ' + dec.actionHash,
        'nullifier        ' + dec.nullifier,
        'expirySlot       ' + dec.expirySlot,
        '',
      ].join('\n');
      try {
        const url = URL.createObjectURL(new Blob([lines], { type: 'text/plain' }));
        const a = document.createElement('a'); a.href = url; a.download = 'public-inputs.txt'; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        later(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
      } catch { /* no-op */ }
      BS.toast({ title: 'Saved public-inputs.txt', body: 'Six public inputs as text. The attestation never left this tab.', tone: 'ok', id: 'vf-dl' });
    }

    /* ── step 4: the one network step, on its button (a same-origin server read) ── */
    function checkNullifier() {
      if (!decoded || !decoded.nullifier) return;
      const tok = runTok;
      const row = $('.vf-n4', li(3)), b = $<HTMLButtonElement>('[data-n4]', row);
      b.disabled = true; b.setAttribute('aria-busy', 'true');
      setCheck(3, 'running', { detail: 'Looking up the nullifier PDA on mainnet…' });
      const t0 = now();
      const read = fetch('/verify/nullifier?n=' + encodeURIComponent(decoded.nullifier), { cache: 'no-store' })
        .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j as { consumed: boolean; consumedAtSlot?: number; consumerProgram?: string }; })
        .then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));
      Promise.all([read, M.wait(900)]).then(([r]) => {
        if (stale(tok)) return;
        const ms = fmt.ms(Math.round(now() - t0));
        b.disabled = false; b.removeAttribute('aria-busy');
        if (!r.ok) {
          setCheck(3, 'fail', { detail: 'The mainnet RPC did not answer. Steps 1–3 stand without it.', reason: 'RPC unavailable · try again' });
          $('span', b).textContent = 'Try again';
          return;
        }
        let html: string;
        if (r.r.consumed) html = '<span class="vf-res">' + ui.status('consumed') + '<span>at slot</span><span class="vf-mono num">' + esc(fmt.slot(r.r.consumedAtSlot)) + '</span>' +
          (r.r.consumerProgram ? '<span>by</span>' + ui.hash(r.r.consumerProgram, { label: 'Consumer program', lg: true }) : '') + '</span>';
        else html = '<span class="vf-res"><span class="chip outline">unused</span><span>No transaction has consumed this nullifier yet.</span></span>';
        setCheck(3, 'pass', { detail: html, html: true, end: 'mainnet · ' + ms });
        $('span', b).textContent = 'Check again';
      });
    }

    /* ── inputs ──────────────────────────────────────────────────────────── */
    function load(json: string, kind: string, label: string) {
      text.value = json;
      text.scrollTop = 0; text.scrollLeft = 0;
      syncGate();
      run(text.value, kind, label);
    }
    function loadSample() { load(SAMPLE_PRETTY, 'sample', 'attestation-sample.json'); }
    function loadTampered() { load(TAMPERED, 'tampered', 'attestation-tampered.json'); }
    btnSample.addEventListener('click', loadSample);
    btnTampered.addEventListener('click', loadTampered);
    function verifyCurrent() {
      const v = text.value.trim(); if (!v) return;
      const label = source.hidden ? 'pasted' : (source.textContent || 'pasted');
      const kind = /attestation-sample/.test(label) ? 'sample' : /attestation-tampered/.test(label) ? 'tampered' : label === 'pasted' ? 'pasted' : 'file';
      run(v, kind, label);
    }
    const onClear = () => {
      text.value = ''; file.value = '';
      setSource(null);
      resetResults(true);
      text.focus();
    };
    btnVerify.addEventListener('click', verifyCurrent);
    btnClear.addEventListener('click', onClear);

    /* drop zone: click = the file picker; drag = accent hairline (150 ms) */
    const onDropClick = () => { file.click(); };
    const onFile = () => { if (file.files && file.files[0]) readFile(file.files[0]); };
    let depth = 0;
    const onEnter = (e: DragEvent) => { e.preventDefault(); depth++; drop.classList.add('is-over'); };
    const onOver = (e: DragEvent) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; };
    const onLeave = () => { depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove('is-over'); };
    const onDrop = (e: DragEvent) => {
      e.preventDefault(); depth = 0; drop.classList.remove('is-over');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readFile(f);
    };
    drop.addEventListener('click', onDropClick);
    file.addEventListener('change', onFile);
    drop.addEventListener('dragenter', onEnter);
    drop.addEventListener('dragover', onOver);
    drop.addEventListener('dragleave', onLeave);
    drop.addEventListener('drop', onDrop);
    // a file dropped anywhere else must not navigate the tab away
    const onWindowDrag = (e: Event) => { if (!drop.contains(e.target as Node)) e.preventDefault(); };
    window.addEventListener('dragover', onWindowDrag);
    window.addEventListener('drop', onWindowDrag);

    function readFile(f: File) {
      if (f.size > 256 * 1024) {
        BS.toast({ title: 'That file is too large', body: f.name + ' is ' + fmt.bytes(f.size) + '. An attestation is about 2 KB.', tone: 'warn', id: 'vf-file' });
        return;
      }
      const r = new FileReader();
      r.onload = () => {
        text.value = String(r.result || '');
        text.scrollTop = 0; syncGate();
        run(text.value, 'file', f.name);
      };
      r.readAsText(f);
    }

    idleBanner();
    syncGate();

    // QA hook (read-only): lets a test drive a file drop without a real drag
    (window as any).S03 = { verifyText: (s: string, name?: string) => { text.value = s; syncGate(); run(s, name ? 'file' : 'pasted', name || 'pasted'); } };

    return () => {
      runTok++;
      timers.forEach((t) => clearTimeout(t));
      banner.removeEventListener('click', onBannerClick);
      text.removeEventListener('input', onInput); text.removeEventListener('keydown', onKey);
      btnSample.removeEventListener('click', loadSample); btnTampered.removeEventListener('click', loadTampered);
      btnVerify.removeEventListener('click', verifyCurrent); btnClear.removeEventListener('click', onClear);
      drop.removeEventListener('click', onDropClick); file.removeEventListener('change', onFile);
      drop.removeEventListener('dragenter', onEnter); drop.removeEventListener('dragover', onOver);
      drop.removeEventListener('dragleave', onLeave); drop.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', onWindowDrag); window.removeEventListener('drop', onWindowDrag);
      delete (window as any).S03;
    };
  });
  return null;
}
