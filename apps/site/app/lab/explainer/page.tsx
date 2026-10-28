import type { Metadata } from 'next';
import { Explainer } from '../../explainer/Explainer';
import '../../explainer/explainer.css';

// /lab/explainer — the "Blindseal in 20 seconds" explainer on its own, laid out as it will sit in the home
// page's section 02. Not linked, not in the sitemap (sitemap.ts lists routes.ts + the docs pages only), noindex.
export const metadata: Metadata = {
  title: 'Explainer (lab) · Blindseal',
  description: 'Blindseal in 20 seconds: an illustrative explainer.',
  robots: { index: false, follow: false },
};

export default function LabExplainer() {
  return (
    <div className="lab-ex">
      <section className="site-section site-section--flush" aria-labelledby="lab-ex-h">
        <div className="section-head">
          <div className="section-head__lead"><p className="section-head__eyebrow"><b>02</b> / How it works</p><h1 className="section-head__title" id="lab-ex-h">Blindseal in 20 seconds.</h1></div>
          <p className="section-head__body">Blindseal runs on your computer between the AI agent and its tools. It checks each request before passing it on, and for supported actions it can create proof that an app on Solana checks for itself.</p>
        </div>
        <Explainer />
      </section>
    </div>
  );
}
