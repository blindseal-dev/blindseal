import Link from 'next/link';
// prefetch={false} on every next/link: Next 15 inserts <link rel=preload as=style> for a prefetched route's
// CSS into <head>, so the DOM would change after hydration (e2e/mismatch-probe.mts must see none).
import type { Metadata } from 'next';
import { pageMeta, ONE_LINER } from './meta';
import { CopyButton } from './copy';
import { HomeKit } from './home-kit';

// Plain-language copy; the hero disclaimer is small secondary text. Layout reuses the S01 kit classes; additions live in app/home.css.
const INSTALL = 'npx blindseal init';

const FAQ: [string, React.ReactNode][] = [
  ['What does Blindseal actually do?', <p key="a">It checks the tool calls your AI agent makes and the replies those tools send back, on your computer. For supported actions, it can create a private, one-time proof that the pattern checks passed. An app on Solana can check that proof for itself.</p>],
  ['Does Blindseal hold or move my crypto?', <p key="a">No. Blindseal doesn&apos;t hold, route, or mix funds. The receiving app decides whether to accept an action after checking the proof.</p>],
  ['Why does the blockchain need proof?', <p key="a">Because an app shouldn&apos;t have to rely only on an agent saying it was checked. It can verify a proof tied to that exact action.</p>],
  ['Can Blindseal see my prompts or security rules?', <><p key="a">Blindseal checks tool calls and replies on your computer. Its log keeps only fingerprints and results; the details are stored encrypted on your computer. The proof checker receives the proof and its public details, not your private instructions or security-rule text. Blindseal&apos;s website does not receive that raw screening data.</p><p key="b">Your agent and its tools may have their own data-sharing settings. Blindseal does not make those separate services private.</p></>],
  ['Does anything leave my computer?', <><p key="a">Not by default. The first run downloads the model Blindseal uses to compare text with known attacks; after that, the checks run on your computer.</p><p key="b">The AI judge, an extra check, is off until you turn it on. Point it at a model on your computer and nothing leaves. Choose an online AI provider instead and the tool replies it checks are sent to that provider, after Blindseal removes the secrets and personal details it recognizes, such as passwords, keys, tokens, e-mail addresses, and names or addresses in labelled fields. That removal is best effort: it will not catch every secret, or names and addresses written as plain sentences.</p></>],
  ['Does a valid proof mean the action is completely safe?', <p key="a">No. It proves that the rules currently covered by the proof passed. Other checks may catch more attacks, but their results are not yet proven inside the proof. Unknown attacks may still get through.</p>],
  ['Can an attacker create proof using weaker rules?', <p key="a">By default, Blindseal&apos;s checker on Solana only accepts approved rule sets and checking-software versions, and the example payment app also checks the rule set against its own list. An app can choose which rule sets and versions it accepts, and reject a proof made with anything else. It still needs to choose those carefully.</p>],
  ['How long does it take?', <p key="a">Creating a proof took about 2 hours and 16 minutes in the product&apos;s Apple M1 Max test. Checking it in a browser took about 0.6 seconds. Today&apos;s version is for actions prepared ahead of time, rather than actions that need a new proof right away.</p>],
];

export const metadata: Metadata = pageMeta({ path: '/', title: 'Blindseal — prove an agent was screened', description: ONE_LINER });

export default function Home() {
  return (
    <>
      {/* Round 2: the hero is pinned for one viewport of scrolling (kit/site.css .hero--pinned / .hero__stage). Behind the
          copy: the dial banner (data-bg="banner", mounted by the kit as img.hero__banner) and, over it, the scroll-scrubbed
          clip of the dial igniting (.hero__reveal, home-kit.tsx: the plate is sized to the banner's ring; scroll sets
          currentTime, nothing autoplays; phones and reduced motion show the end still and never request the clip). */}
      <section className="hero hero--pinned" aria-label="Introduction">
        <div className="hero__stage">
          <div className="hero__space" data-bg="banner" data-intensity="hero" aria-hidden />
          <div className="hero__reveal hm-light" aria-hidden>
            <div className="hm-light__plate">
              <img className="hm-light__still" alt="" width={1920} height={1080} decoding="async" hidden />
              <video className="hm-light__video" playsInline preload="none" disablePictureInPicture disableRemotePlayback tabIndex={-1} />
            </div>
            <div className="hm-light__scrim" />
          </div>
          <div className="hero__shade" aria-hidden />
          <div className="hero__content"><div className="hero__col">
          <h1 className="hero__title">AI agents can be tricked. <br /><em>Blindseal helps stop them.</em></h1>
          <p className="hero__sub">Blindseal checks your AI agent&apos;s requests for hidden threats and can provide proof that specific checks passed, without revealing your instructions or security rules.</p>
          <p className="hero__sub">Blindseal runs the checks on your computer and can create a proof for supported actions. Apps can check that proof before accepting your agent&apos;s request.</p>
          <p className="hero__note">Today&apos;s proof covers checks for known attack patterns. It does not guarantee that an action is safe.</p>
          <div className="hero__actions">
            <Link prefetch={false} className="btn primary hero__primary" href="/how-it-works">See how it works<i data-lucide="arrow-right" /></Link>
            <Link prefetch={false} className="hero__secondary" href="/docs">Install Blindseal<i data-lucide="arrow-right" /></Link>
          </div>
          <ul className="hero__trust">
            <li><span className="hero__trust-ico"><i data-lucide="file-check" /></span>Checks before tools run</li>
            <li><span className="hero__trust-ico"><i data-lucide="terminal" /></span>Private instructions and rules stay out of the proof</li>
            <li><span className="hero__trust-ico"><i data-lucide="stamp" /></span>One-time proof checked on Solana</li>
          </ul>
        </div></div>
        </div>
      </section>
      <HomeKit />

      <section className="site-section s01-problem site-section--textured" data-texture="rock" aria-labelledby="problem-h">
        <div className="section-head">
          <div className="section-head__lead"><p className="section-head__eyebrow reveal"><b>01</b> / The problem</p><h2 className="section-head__title reveal" id="problem-h">AI agents can be tricked into doing things you never asked them to do.</h2></div>
        </div>
        <div className="s01-problem__lines">
          <p className="s01-problem__line reveal">An AI agent is software that uses tools to carry out tasks for you. It might read a malicious website, follow hidden instructions, or try to send funds to the wrong wallet.</p>
          <p className="s01-problem__line reveal">Security tools can check those actions. But how does the app receiving an action know the checks actually happened?</p>
          <p className="s01-problem__line reveal">That&apos;s the problem Blindseal solves.</p>
        </div>
      </section>

      <section className="site-section reveal s01-how site-section--textured" data-texture="metal" aria-labelledby="how-h">
        <div className="section-head">
          <div className="section-head__lead"><p className="section-head__eyebrow"><b>02</b> / How it works</p><h2 className="section-head__title" id="how-h">Three steps. One private proof.</h2></div>
        </div>
        <ol className="s01-cols hm-steps reveal cascade" aria-label="The three steps">
          <li className="s01-col"><span className="s01-col__k">1 · We check the action</span><p className="s01-col__p">Blindseal runs on your computer between the AI agent and its tools. It checks each tool call before the tool gets it, and each reply before your agent reads it. Anything that fails the checks can be blocked.</p></li>
          <li className="s01-col"><span className="s01-col__k">2 · We create proof</span><p className="s01-col__p">For supported actions that pass, your computer can create proof that the pattern checks passed. The proof is tied to the exact action and the set of rules used to check it. If the checked request does not describe that action, no proof is made.</p></li>
          <li className="s01-col"><span className="s01-col__k">3 · The blockchain verifies it</span><p className="s01-col__p">An app on Solana can require that proof before accepting the action. Once the proof has been used to approve the action, it cannot be used again.</p></li>
        </ol>
        <p className="hm-note">Creating a proof can take hours. Checking it is fast. Today&apos;s version is built for actions prepared ahead of time, such as scheduled payments.</p>
        <div className="site-panel hm-example reveal">
          <p className="site-panel__n">Concrete example</p>
          <h3 className="hm-example__title">An AI agent is preparing a payment.</h3>
          <p className="site-panel__body">Blindseal checks the proposed action. If it passes and supports proof creation, your computer can create a private proof tied to that payment. Once the proof is ready, the receiving app checks it before allowing the payment. The proof must still be within its time limit.</p>
          <p className="site-panel__body"><strong>Blindseal does not hold, send, or mix the funds.</strong> It checks and proves; the receiving app decides.</p>
        </div>
        <p className="s01-more"><Link prefetch={false} className="btn link s01-link" href="/how-it-works">See how it works<i data-lucide="arrow-right" className="nudge" /></Link></p>
      </section>

      <section className="site-section reveal site-section--textured" data-texture="halo" aria-labelledby="hp-h">
        <div className="section-head">
          <div className="section-head__lead"><p className="section-head__eyebrow"><b>03</b> / What stays private</p><h2 className="section-head__title" id="hp-h">Show proof, not your private data.</h2></div>
          <p className="section-head__body">The proof checker receives a proof and digital fingerprints: short codes made from the data. It does not need your private instructions, the private details sent to tools, or the text of your security rules. The proof is tied to one action and expires.</p>
        </div>
        <div className="s01-hp">
          <section className="site-panel s01-hp__panel"><h3 className="s01-hp__head"><span>Stays private from the proof checker</span></h3>
            <ul className="s01-hp__rows reveal cascade">
              <li>What the agent was asked</li><li>Private details in the checked tool requests and replies</li><li>Your security rules and limits</li><li>Which agent or operator was checked</li><li>Scores from the AI-based checks</li>
            </ul></section>
          <section className="site-panel s01-hp__panel"><h3 className="s01-hp__head"><span>Included in the proof&apos;s public data</span></h3>
            <ul className="s01-hp__rows reveal cascade">
              <li>Fingerprint of the checked request</li><li>Fingerprint of the security rules</li><li>Version of the checking software</li><li>Fingerprint of the action</li><li>Time limit and a marker that prevents reuse</li>
            </ul></section>
        </div>
        <p className="hm-note">Normal Solana transaction details, such as the receiving wallet and amount, may still be public. Blindseal hides the private details used in its checks, not the transaction itself. It does not promise that the person behind a payment cannot be identified.</p>
      </section>

      <section className="site-section reveal site-section--textured" data-texture="rock" aria-labelledby="who-h">
        <div className="section-head">
          <div className="section-head__lead"><p className="section-head__eyebrow">Who is it for?</p><h2 className="section-head__title" id="who-h">For people using AI agents and teams building apps.</h2></div>
        </div>
        <div className="s01-hp">
          <section className="site-panel hm-who"><p className="site-panel__n">Using an AI agent?</p><p className="site-panel__body">You don&apos;t need to have built it yourself. Connect Blindseal between your agent and its tools to check the calls and replies that pass through it, right on your computer. Your private instructions and security rules aren&apos;t sent to Blindseal&apos;s website.</p></section>
          <section className="site-panel hm-who"><p className="site-panel__n">Building an app on Solana?</p><p className="site-panel__body">Add Blindseal so your app can require proof that an agent&apos;s action passed your approved pattern checks before accepting it.</p></section>
        </div>
        <p className="hm-note">Blindseal works with agents that use tools to carry out tasks. It needs to be connected to those tools; it does not automatically protect every AI chat or app.</p>
      </section>

      <section className="site-section reveal site-section--textured" data-texture="metal" aria-labelledby="scope-h">
        <div className="callout s01-scope"><p className="callout__eyebrow">What the proof actually means</p>
          <h2 className="hm-scope__title" id="scope-h">What does the proof guarantee?</h2>
          <p className="callout__body">It proves that the checked request, tied to a specific action, passed checks for known attack patterns under a specific rule set and software version.</p>
          <p className="callout__body">Other checks run on your computer too, but their results are not yet proven by this proof. A valid proof does <strong>not</strong> mean an agent or transaction is guaranteed safe.</p>
          <p className="callout__body"><Link prefetch={false} className="btn link" href="/docs/scope">Read exactly what is proven<i data-lucide="arrow-right" className="nudge" /></Link></p>
        </div>
      </section>

      <section className="site-section reveal site-section--textured" data-texture="halo" aria-labelledby="faq-h" id="faq">
        <div className="section-head">
          <div className="section-head__lead"><p className="section-head__eyebrow">FAQ</p><h2 className="section-head__title" id="faq-h">Questions, answered plainly.</h2></div>
        </div>
        <div className="hm-faq">
          {FAQ.map(([q, a]) => (
            <details className="hm-faq__item" key={q}><summary className="hm-faq__q">{q}</summary><div className="hm-faq__a">{a}</div></details>
          ))}
        </div>
      </section>

      <section className="site-section site-cta reveal site-section--textured" data-texture="rock" aria-labelledby="cta-h">
        <h2 className="section-head__title" id="cta-h">Want to see proof that an action was checked?</h2>
        <p className="section-head__body hm-cta__body">Try the sample proof in your browser, or add Blindseal between your agent and its tools.</p>
        <div className="hero__actions">
          <Link prefetch={false} className="btn primary hero__primary" href="/verify">Try a sample proof<i data-lucide="arrow-right" /></Link>
          <Link prefetch={false} className="hero__secondary" href="/docs">Install Blindseal<i data-lucide="arrow-right" /></Link>
          <div className="install"><span className="install__tile" aria-hidden>$</span><code className="install__cmd">{INSTALL}</code><CopyButton text={INSTALL} label="Copy the install command" /></div>
        </div>
      </section>
    </>
  );
}
