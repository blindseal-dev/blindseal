import Link from 'next/link';
import { CopyButton } from './copy';

const INSTALL = 'npx @blindseal/proxy init';

export default function Home() {
  return (
    <>
      <section className="hero" aria-label="Introduction">
        <div className="hero__space" data-bg="nebula" data-intensity="hero" aria-hidden />
        <div className="hero__shade" aria-hidden />
        <div className="hero__content"><div className="hero__col">
          <p className="hero__eyebrow"><i className="hero__dot" aria-hidden /><span>Local proxy</span><span className="hero__sep" aria-hidden>·</span><span>Zero-knowledge attestation</span><span className="hero__sep" aria-hidden>·</span><span>Verified on Solana</span></p>
          <h1 className="hero__title">Prove an agent&apos;s action was screened <br /><em>without showing what it was</em>.</h1>
          <p className="hero__sub">Blindseal is a privacy-preserving, verifiable screening layer for AI agents.<br />Nothing sensitive leaves the machine.</p>
          <div className="hero__actions">
            <div className="install"><span className="install__tile" aria-hidden>$</span><code className="install__cmd">{INSTALL}</code><CopyButton text={INSTALL} label="Copy the install command" /></div>
            <Link className="hero__secondary" href="/how-it-works">Read how it works<i data-lucide="arrow-right" /></Link>
          </div>
          <ul className="hero__trust">
            <li><span className="hero__trust-ico"><i data-lucide="terminal" /></span>Local-only dashboard</li>
            <li><span className="hero__trust-ico"><i data-lucide="stamp" /></span>Single-use attestations</li>
            <li><span className="hero__trust-ico"><i data-lucide="git-commit-horizontal" /></span>Content-free audit log</li>
          </ul>
        </div></div>
      </section>

      <section className="site-section s01-problem" aria-labelledby="problem-h">
        <p className="section-head__eyebrow reveal" id="problem-h"><b>01</b> / The problem</p>
        <div className="s01-problem__lines">
          <p className="s01-problem__line reveal">AI agents are easy to trick — put the wrong text in front of one and it does what the attacker wants.</p>
          <p className="s01-problem__line reveal">When a tricked agent shows up at an app, the app can&apos;t tell.</p>
          <p className="s01-problem__line reveal">The only fix today is a service that reads all your agent&apos;s prompts, so proving you&apos;re safe means handing over your secrets.</p>
        </div>
      </section>

      <section className="site-section reveal s01-how" aria-labelledby="how-h">
        <div className="section-head">
          <div className="section-head__lead"><p className="section-head__eyebrow"><b>02</b> / How it works</p><h2 className="section-head__title" id="how-h">Screen, attest, prove, verify.</h2></div>
          <p className="section-head__body">Blindseal checks every action your agent takes, on your own machine, and never sends your data anywhere. When your agent needs to prove it was checked, Blindseal gives it a one-time stamp.</p>
        </div>
        <figure className="fig s01-flow" data-figure="flow4" aria-label="Screen → attest → prove → verify" />
        <ol className="s01-cols reveal cascade" aria-label="The four steps">
          <li className="s01-col"><span className="s01-col__k">Screen</span><p className="s01-col__p">It sits between an agent and its tools as a local proxy, inspecting every tool call with four layers of prompt-injection detection before the call executes.</p></li>
          <li className="s01-col"><span className="s01-col__k">Attest</span><p className="s01-col__p">Blindseal produces a zero-knowledge attestation that a specific tool call passed a committed policy.</p></li>
          <li className="s01-col"><span className="s01-col__k">Prove</span><p className="s01-col__p">The proof is generated locally. It is single-use.</p></li>
          <li className="s01-col"><span className="s01-col__k">Verify</span><p className="s01-col__p">Verified with one Solana instruction, so any program can gate agent actions without seeing the prompt, the arguments, the operator&apos;s rules, or which agent was screened.</p></li>
        </ol>
        <p className="s01-more"><Link className="btn link s01-link" href="/how-it-works">Read the long version<i data-lucide="arrow-right" className="nudge" /></Link></p>
      </section>

      <section className="site-section reveal" aria-labelledby="hp-h">
        <div className="section-head">
          <div className="section-head__lead"><p className="section-head__eyebrow"><b>03</b> / Hidden vs public</p><h2 className="section-head__title" id="hp-h">What stays on the machine,<br />and what the app sees.</h2></div>
          <p className="section-head__body">The app sees the stamp and nothing else — not what the agent was asked, what it did, or who it is. Each stamp works once.</p>
        </div>
        <div className="s01-hp">
          <section className="site-panel s01-hp__panel"><h3 className="s01-hp__head"><span>Hidden</span><span className="s01-hp__note">never leaves the machine</span></h3>
            <ul className="s01-hp__rows reveal cascade">
              <li>Prompt and tool arguments</li><li>Policy contents, thresholds, custom lists</li><li>Which agent / operator was screened</li><li>Model-layer scores</li>
            </ul></section>
          <section className="site-panel s01-hp__panel"><h3 className="s01-hp__head"><span>Public</span><span className="s01-hp__note">on the attestation</span></h3>
            <ul className="s01-hp__rows reveal cascade">
              <li>That a valid attestation exists</li><li>Policy root (a hash)</li><li>Detector version</li><li>Action hash, expiry, nullifier</li>
            </ul></section>
        </div>
      </section>

      <section className="site-section reveal" aria-labelledby="scope-h">
        <div className="callout s01-scope"><p className="callout__eyebrow" id="scope-h">What we claim</p>
          <p className="callout__body">Blindseal proves that a specific call was screened under a committed policy by a specific detector version, and that the deterministic layers passed. The model-based layers run locally or in a TEE and are attested, not proven. Blindseal does not prove an agent is safe, and does not cover traffic that doesn&apos;t pass through the proxy.</p>
        </div>
      </section>

      <section className="site-section site-cta reveal" aria-labelledby="cta-h">
        <h2 className="section-head__title" id="cta-h">Screen the next tool call.</h2>
        <div className="hero__actions"><div className="install"><span className="install__tile" aria-hidden>$</span><code className="install__cmd">{INSTALL}</code><CopyButton text={INSTALL} /></div></div>
      </section>
    </>
  );
}
