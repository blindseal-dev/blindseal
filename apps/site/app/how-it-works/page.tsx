import type { CSSProperties } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { HowKit, type HowData } from './how-kit';
import { actionHash, nullifierOf, sha256Hex } from './action-hash';
import att from './attestation-mainnet.json';
import call from './toolcall-mainnet.json';
import './narrow.css';
import { TocToggle } from './toc-toggle';

// S02 · How it works — the mockup's <main> (design/mockups/mockups/S02/index.html) one-to-one;
// page.css is loaded verbatim as kit/pages/s02.css. page.js lives in how-kit.tsx.
//
// Every value page.js pulled from the mockup fixtures comes from real, committed, deterministic
// sources (fixtures.js is never loaded by the site):
//   attestation-mainnet.json  the attestation consumed on Solana mainnet-beta on 2026-10-23
//                             (tests/fixtures/attestation-mainnet.json, verbatim): action fields,
//                             hashes, nullifier, expiry slot, nonce. Its tx signature is TX_SIG
//                             (REPORT.md, "Mainnet signatures").
//   toolcall-mainnet.json     the tool call `blindseal attest` screened for it
//                             (tests/fixtures/mainnet-toolcall.json, verbatim). payloadHash is
//                             recomputed from it here and asserted against the attestation.
//   REDACTED_PAYLOAD          what the real redactor (packages/redactor) returns for that payload:
//                             the two base58 addresses are opaque 32+ char tokens, so they hit the
//                             high_entropy catch-all (×2). Reproduce with
//                             `redact(JSON.stringify({ tool: call.toolName, args: call.args }))`.
//   RULES                     the committed policy snapshot the proxy serves (fixtures/policy.json,
//                             root 0x36a9e945…8397 = this attestation's policyRoot): 22 L1 rules,
//                             4 L0 decoders — the same lists crates/detector-core compiles.
//   the audit chain           apps/site/app/verify/disclosure-sample.json (a real signed
//                             disclosure, #190–#199), recomputed client-side in how-kit.tsx.
export const metadata: Metadata = {
  title: 'How it works · Blindseal',
  description: 'Four detection layers, redaction before the judge, a hash-chained audit log, and a Groth16 attestation bound to one on-chain action — and a plain line where the claim stops.',
};

const TX_SIG = '7iwA4nxnBG73o8H8j8XUESYsmyGhGrxU5HiqXww8Nzp1YRC9oa7oE2ArWsd2fZN736vyhMatECyd2zw5agedpye';
const PROGRAM_NAMES: Record<string, string> = {
  '9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa': 'transfer-gate',
  '6z4HehpRyppJDxGXJubE7Z4GpE6feNytUb2Udya6kaGx': 'blindseal-verify',
  '11111111111111111111111111111111': 'System Program',
};
const RULES = { L0: 4, L1: 22 };
const REDACTED_PAYLOAD = '{"tool":"transfer_sol","args":{"to":"[REDACTED:high_entropy:1]","lamports":1000000,"from":"[REDACTED:high_entropy:2]","memo":"blindseal m2 mainnet acceptance: one gated 0.001 SOL transfer"}}';
const REDACTIONS = [{ kind: 'high_entropy', count: 2 }];

function data(): HowData {
  const payload = JSON.stringify({ tool: call.toolName, args: call.args });
  const payloadHash = sha256Hex(payload);
  if (payloadHash !== att.payloadHash) throw new Error('how-it-works: the committed tool call does not hash to the attestation payloadHash');
  const inputs = { chainId: att.chainId, action: att.action, payloadHash: att.payloadHash, policyRoot: att.policyRoot, detectorVersion: att.detectorVersion, expirySlot: att.expirySlot, nonce: att.nonce };
  const h = actionHash(inputs);
  if (h !== att.actionHash || nullifierOf(h) !== att.nullifier) throw new Error('how-it-works: recomputed action hash does not match the attestation');
  const altered = actionHash({ ...inputs, action: { ...att.action, amount: String(BigInt(att.action.amount) + 1n) } });
  return {
    att: { actionHash: att.actionHash, nullifier: att.nullifier, expirySlot: att.expirySlot, policyRoot: att.policyRoot, txSig: TX_SIG, status: 'consumed' },
    action: att.action,
    programName: PROGRAM_NAMES[att.action.targetProgram] ?? null,
    hashes: { intact: h, altered },
    decision: {
      id: att.decisionId, server: 'blindseal attest', tool: call.toolName,
      // `blindseal attest` runs the deterministic layers only (packages/proxy/src/cli/attest.ts): L0 decoded
      // nothing, L1 matched no rule → clean. L2/L3 did not run for this call.
      layers: [
        { layer: 'L0', ran: true, verdict: 'pass' }, { layer: 'L1', ran: true, verdict: 'pass' },
        { layer: 'L2', ran: false, verdict: 'skip' }, { layer: 'L3', ran: false, verdict: 'skip' },
      ],
      verdict: 'pass',
      payloadHash, redactedHash: sha256Hex(REDACTED_PAYLOAD), redactions: REDACTIONS,
    },
    rules: RULES,
  };
}

const kv5 = { '--kv-cols': 5 } as CSSProperties;
const kv2 = { '--kv-cols': 2 } as CSSProperties;

export default function HowItWorks() {
  const d = data();
  return (
    <>
      {/* ══ masthead: a flat panel band over the faint nebula ══════════════ */}
      <header className="hiw-mast" aria-labelledby="hiw-title">
        <div className="hiw-mast__space" aria-hidden />
        <div className="hiw-mast__copy">
          <p className="hiw-mast__eyebrow">How it works</p>
          <h1 className="hiw-mast__title" id="hiw-title">Your agent acts. Blindseal checks.</h1>
          <p className="hiw-caption hiw-caption--mast">A screening layer that can prove it ran.</p>
          <p className="hiw-mast__lede">Blindseal sits between your AI agent and its tools. Each request sent through it is checked before it goes through.</p>
        </div>
      </header>

      {/* ══ body: TOC rail + content column ═══════════════════════════════ */}
      <div className="hiw">
        <aside className="hiw-toc-col">
          <nav className="hiw-toc" aria-label="Contents">
            <TocToggle />
            <p className="hiw-toc__head">Contents</p>
            <div className="hiw-toc__rail" id="hiw-toc-rail">
              <div className="hiw-toc__track" aria-hidden><span className="hiw-toc__fill" /></div>
              <ol className="hiw-toc__list">
                <li><a className="hiw-toc__link" href="#architecture" data-toc="architecture"><span className="hiw-toc__n">01</span>Architecture</a></li>
                <li><a className="hiw-toc__link" href="#four-layers" data-toc="four-layers"><span className="hiw-toc__n">02</span>Four layers</a></li>
                <li><a className="hiw-toc__link" href="#redaction" data-toc="redaction"><span className="hiw-toc__n">03</span>Redaction before the judge</a></li>
                <li><a className="hiw-toc__link" href="#attestation" data-toc="attestation"><span className="hiw-toc__n">04</span>The attestation</a></li>
                <li><a className="hiw-toc__link" href="#binding" data-toc="binding"><span className="hiw-toc__n">05</span>What binds it</a></li>
                <li><a className="hiw-toc__link" href="#audit-chain" data-toc="audit-chain"><span className="hiw-toc__n">06</span>The audit chain</a></li>
                <li><a className="hiw-toc__link" href="#claim" data-toc="claim"><span className="hiw-toc__n">07</span>What we claim</a></li>
                <li><a className="hiw-toc__link" href="#next" data-toc="next"><span className="hiw-toc__n">08</span>Next</a></li>
              </ol>
            </div>
            {/* disabled at the top of the page (page.js: y < 8); the scroll handler owns it after mount */}
            <button type="button" className="hiw-toc__top" data-top="" disabled><i data-lucide="chevron-up" />Back to top</button>
          </nav>
        </aside>

        <article className="hiw-body">

          {/* 01 ─ architecture */}
          <section className="hiw-sec" id="architecture" aria-labelledby="h-architecture">
            <div className="hiw-head reveal">
              <div className="section-head">
                <div className="section-head__lead"><p className="section-head__eyebrow"><b>01</b> / Architecture</p><h2 className="section-head__title" id="h-architecture">One checkpoint for your agent&apos;s tools</h2><p className="hiw-caption">One proxy between the agent and its tools.</p></div>
                <p className="section-head__body">Instead of talking directly to a tool, the agent talks through Blindseal running on your computer.</p>
              </div>
            </div>
            <figure className="hiw-fig" id="fig-architecture" data-fig="architecture" data-fig-n="1" />
            <div className="hiw-grid2 reveal cascade">
              <div className="hiw-art">
                <p className="hiw-art__eyebrow">The path</p>
                <h3 className="hiw-art__title">Every call goes through 127.0.0.1</h3>
                <p className="hiw-art__body">The agent&apos;s MCP client talks to the proxy instead of the server. The proxy screens each call, forwards what passes to the upstream server, and writes the decision to the local log either way.</p>
                <p className="hiw-route"><span>Agent</span><span aria-hidden>→</span><span>Proxy <span className="hiw-route__port" data-port="" /></span><span aria-hidden>→</span><strong data-upstreams="">Tools</strong></p>
              </div>
              <div className="hiw-art">
                <p className="hiw-art__eyebrow">What stays on the machine</p>
                <h3 className="hiw-art__title">Only a proof crosses the line</h3>
                <p className="hiw-art__body">The prompt, the tool arguments, the operator&apos;s rules and every model score stay on the machine. A proof and its five public inputs leave it, and only when something downstream asks for one.</p>
                <p className="hiw-route"><span>Decision</span><span aria-hidden>→</span><span>Prover</span><span aria-hidden>→</span><strong>Solana verifier</strong></p>
              </div>
            </div>
          </section>

          {/* 02 ─ four layers */}
          <section className="hiw-sec" id="four-layers" aria-labelledby="h-four-layers">
            <div className="hiw-head reveal">
              <div className="section-head">
                <div className="section-head__lead"><p className="section-head__eyebrow"><b>02</b> / Four layers</p><h2 className="section-head__title" id="h-four-layers">Four ways to spot suspicious instructions</h2><p className="hiw-caption">Two layers that match, two that judge.</p></div>
                <p className="section-head__body">Some checks look for known attack patterns. Others look at what the text means. Today&apos;s proof covers only the pattern checks.</p>
              </div>
            </div>
            <div className="hiw-layers">
              <figure className="hiw-fig hiw-fig--narrow" id="fig-layers" data-fig="layers" data-fig-n="2" />
              <ul className="hiw-flows reveal cascade" aria-label="The four layers">
                <li><span className="hiw-flows__k"><b>L0</b>Decode</span><span className="hiw-flows__v">Decodes base64, hex, URL and HTML-entity encodings, nested, and re-screens the result. Runs in the proxy; not in the proof yet. <span data-count="L0" /></span><span className="chip neutral">Not in proof yet</span></li>
                <li><span className="hiw-flows__k"><b>L1</b>Patterns</span><span className="hiw-flows__v">Expressions for override phrasing, prompt extraction, hidden unicode, role tags and exfiltration links. <span data-count="L1" /></span><span className="chip outline">Proven</span></li>
                <li><span className="hiw-flows__k"><b>L2</b>Similarity</span><span className="hiw-flows__v">Scores the redacted payload against known injections, from 0 to 1. Runs locally; TEE mode planned.</span><span className="chip neutral">Attested</span></li>
                <li><span className="hiw-flows__k"><b>L3</b>Judge</span><span className="hiw-flows__v">Reads the redacted payload when L2 or a rule raises a doubt, and can clear an L2 flag. Runs locally; TEE mode planned.</span><span className="chip neutral">Attested</span></li>
              </ul>
            </div>
            <div className="hiw-example reveal" data-example="">
              <p className="hiw-example__k">An example decision</p>
              <div className="hiw-example__row">
                <span className="hiw-example__tool" data-ex-tool="" />
                <span data-ex-strip="" />
                <span data-ex-verdict="" />
                <p className="hiw-example__note" data-ex-note="" />
              </div>
            </div>
          </section>

          {/* 03 ─ redaction */}
          <section className="hiw-sec" id="redaction" aria-labelledby="h-redaction">
            <div className="hiw-head reveal">
              <div className="section-head">
                <div className="section-head__lead"><p className="section-head__eyebrow"><b>03</b> / Redaction before the judge</p><h2 className="section-head__title" id="h-redaction">Hide private details before deeper checks</h2><p className="hiw-caption">The judge sees less than the agent sent.</p></div>
                <p className="section-head__body">Secrets and personal details are removed before the AI-based checks examine the request.</p>
              </div>
            </div>
            <div className="hiw-redact reveal" data-redact="">
              <div className="hiw-redact__side">
                <p className="hiw-redact__k">payloadHash</p>
                <div className="hiw-redact__v" data-ph="" />
                <p className="hiw-redact__sub">The canonical call as the agent sent it. L0 and L1 read this.</p>
              </div>
              <div className="hiw-redact__arrow" aria-hidden>
                <svg viewBox="0 0 120 24" focusable="false"><path data-draw="" pathLength={1} d="M2 12H116" style={{ '--i': 0 } as CSSProperties} /><path data-draw="fast" pathLength={1} d="M108 5l8 7-8 7" style={{ '--i': 3 } as CSSProperties} /></svg>
                <span className="hiw-redact__step" data-draw-label="">redact</span>
              </div>
              <div className="hiw-redact__side">
                <p className="hiw-redact__k">redactedHash</p>
                <div className="hiw-redact__v" data-rh="" />
                <p className="hiw-redact__sub">What L2 and L3 actually saw. The two hashes differ because something was removed.</p>
              </div>
              <div className="hiw-redact__foot">
                <span className="hiw-redact__label">Redacted</span>
                <span className="hiw-redact__chips" data-kinds="" />
                <span className="hiw-redact__note">The payload itself is never on this page, only its hashes.</span>
              </div>
            </div>
          </section>

          {/* 04 ─ the attestation */}
          <section className="hiw-sec" id="attestation" aria-labelledby="h-attestation">
            <div className="hiw-head reveal">
              <div className="section-head">
                <div className="section-head__lead"><p className="section-head__eyebrow"><b>04</b> / The attestation</p><h2 className="section-head__title" id="h-attestation">One proof for one action</h2><p className="hiw-caption">One attestation, one action, one use.</p></div>
                <p className="section-head__body">The proof is tied to an exact action. It cannot approve a different action or be used twice on Solana.</p>
              </div>
            </div>
            <figure className="hiw-fig" id="fig-lifecycle" data-fig="lifecycle" data-fig-n="3" />
            <p className="hiw-cols reveal">When something downstream needs proof — an escrow contract, a counterparty, an auditor — Blindseal produces a zero-knowledge attestation that a specific tool call passed a committed policy. The attestation binds to the action itself: target program, recipient, amount, policy root, and expiry are hashed into it, so it is worthless for any other call. It is single-use. The proof is generated locally and verified with one Solana instruction, so any program can gate agent actions without seeing the prompt, the arguments, the operator&apos;s rules, or which agent was screened.</p>
            <div className="hiw-panel reveal">
              <p className="hiw-panel__k">The attestation in the figure</p>
              <div className="kv hiw-kv" style={kv5} data-att-kv="" />
            </div>
          </section>

          {/* 05 ─ what binds it */}
          <section className="hiw-sec" id="binding" aria-labelledby="h-binding">
            <div className="hiw-head reveal">
              <div className="section-head">
                <div className="section-head__lead"><p className="section-head__eyebrow"><b>05</b> / What binds it</p><h2 className="section-head__title" id="h-binding">The proof cannot be swapped onto another transfer</h2><p className="hiw-caption">Hashed into the attestation.</p></div>
                <p className="section-head__body">Change the app, sending account, receiving account, token, or amount and the proof no longer matches.</p>
              </div>
            </div>
            <div className="hiw-bind reveal" data-bind="">
              <div className="kv hiw-kv" style={kv5} data-bind-kv="" />
              <div className="hiw-bind__out">
                <div className="hiw-bind__res">
                  {/* the committed blob is payloadHash ‖ policyRoot ‖ detectorVersion ‖ actionHash ‖ nullifier ‖ expirySlot (docs/hashing): the action hash is field 3 */}
                  <span className="hiw-bind__k">Action hash · public input 3</span>
                  <span className="hiw-bind__v" data-bind-hash="" />
                  <span className="hiw-bind__state" data-bind-state="" />
                </div>
                <button type="button" className="btn secondary sm" data-bind-toggle="" aria-pressed="false"><i data-lucide="refresh-cw" /><span>Change the amount by one lamport</span></button>
              </div>
            </div>
          </section>

          {/* 06 ─ the audit chain */}
          <section className="hiw-sec" id="audit-chain" aria-labelledby="h-audit-chain">
            <div className="hiw-head reveal">
              <div className="section-head">
                <div className="section-head__lead"><p className="section-head__eyebrow"><b>06</b> / The audit chain</p><h2 className="section-head__title" id="h-audit-chain">A record that helps reveal changes</h2><p className="hiw-caption">A log that commits to itself.</p></div>
                <p className="section-head__body">Each entry links to the previous one. Changing an earlier entry breaks that chain of digital fingerprints.</p>
              </div>
            </div>
            <figure className="hiw-fig" id="fig-chain" data-fig="chain" data-fig-n="4" />
            <div className="hiw-grid2 reveal cascade">
              <div className="hiw-art">
                <p className="hiw-art__eyebrow">Hash-chained</p>
                <h3 className="hiw-art__title">Change one entry, break every hash after it</h3>
                <p className="hiw-art__body">Each entry stores the hash of the one before it, its decision id, its payload hash and its verdict. Anyone holding the head can walk the chain back and recompute every link.</p>
                <ul className="checklist hiw-walk" data-walk="" />
                <div><button type="button" className="btn secondary sm" data-walk-btn=""><i data-lucide="link" /><span>Walk the chain</span></button></div>
              </div>
              <div className="hiw-art">
                <p className="hiw-art__eyebrow">Selective disclosure</p>
                <h3 className="hiw-art__title">Show a window, not the traffic</h3>
                <p className="hiw-art__body">A disclosure is a signed range of entries: the hashes and verdicts from the highlighted window, checkable against the head, with no payload in it.</p>
                <div className="kv hiw-kv" style={kv2} data-head-kv="" />
              </div>
            </div>
          </section>

          {/* 07 ─ what we claim */}
          <section className="hiw-sec" id="claim" aria-labelledby="h-claim">
            <div className="hiw-head reveal">
              <div className="section-head">
                <div className="section-head__lead"><p className="section-head__eyebrow"><b>07</b> / What we claim</p><h2 className="section-head__title" id="h-claim">What Blindseal proves, and what it doesn&apos;t</h2><p className="hiw-caption">A deliberately narrow claim.</p></div>
                <p className="section-head__body">Proof of passing specific checks is not a promise that an action is completely safe.</p>
              </div>
            </div>
            <div className="hiw-claim reveal cascade">
              <div className="site-panel hiw-claim__panel">
                <div className="callout"><p className="callout__title">What we claim</p><p className="callout__body" data-honest="">Blindseal proves that a specific call was screened under a committed policy by a specific detector version, and that the committed L1 rules passed. L0 decoding is run by the proxy but is not inside the proof yet; the model-based layers run locally and are attested, not proven (a TEE mode is planned). Blindseal does not prove an agent is safe, and does not cover traffic that doesn&apos;t pass through the proxy.</p></div>
              </div>
              <figure className="hiw-table" aria-label="Hidden versus public">
                <table>
                  <thead><tr><th scope="col">Hidden</th><th scope="col">Public</th></tr></thead>
                  <tbody>
                    <tr><td>Prompt and tool arguments</td><td>That a valid attestation exists</td></tr>
                    <tr><td>Policy contents, thresholds, custom lists</td><td>Policy root (a hash)</td></tr>
                    <tr><td>Which agent / operator was screened</td><td>Detector version</td></tr>
                    <tr><td>Model-layer scores</td><td>Action hash, expiry, nullifier</td></tr>
                  </tbody>
                </table>
              </figure>
            </div>
          </section>

          {/* 08 ─ next */}
          <section className="hiw-sec" id="next" aria-labelledby="h-next">
            <div className="hiw-head reveal">
              <div className="section-head">
                <div className="section-head__lead"><p className="section-head__eyebrow"><b>08</b> / Next</p><h2 className="section-head__title" id="h-next">Try the proof yourself</h2><p className="hiw-caption">Check it yourself.</p></div>
                <p className="section-head__body">Load a sample, check that it passes, then try the altered version.</p>
              </div>
            </div>
            <div className="hiw-next reveal cascade">
              <Link className="site-panel card--interactive hiw-next__card" href="/verify">
                <span className="site-panel__n">Verify</span>
                <span className="hiw-next__title">Verify an attestation <i data-lucide="arrow-right" /></span>
                <span className="site-panel__body">Paste or drop attestation.json. The proof is checked in your browser; nothing is uploaded.</span>
              </Link>
              <Link className="site-panel card--interactive hiw-next__card" href="/docs">
                <span className="site-panel__n">Docs</span>
                <span className="hiw-next__title">Read the docs <i data-lucide="arrow-right" /></span>
                <span className="site-panel__body">Install the proxy, point an agent at it, write policy rules, and read the local API.</span>
              </Link>
            </div>
          </section>

        </article>
      </div>
      <HowKit data={d} />
    </>
  );
}
