import type { Metadata } from 'next';
import { DashboardLauncher } from './launcher';
import { DASHBOARD_URL } from '../routes';

export const metadata: Metadata = {
  title: 'Dashboard · Blindseal',
  description: 'The Blindseal dashboard runs on your machine, served by the local proxy. Nothing here is hosted.',
};

// /dashboard — the notch's "Open dashboard" lands here instead of on 127.0.0.1:7777 directly: a public
// page pointing at localhost is a dead end for anyone without the proxy running. The launcher probes the
// local proxy from the visitor's browser (never from this server) and shows either the way in or the
// three commands that get there. Server-rendered static copy; the probe runs in the client component.
export default function Dashboard() {
  return (
    <section className="site-section dash-launch" aria-labelledby="dash-h">
      <div className="section-head">
        <div className="section-head__lead">
          <p className="section-head__eyebrow"><b>·</b> / Dashboard</p>
          <h1 className="section-head__title" id="dash-h">The dashboard runs on your machine.</h1>
        </div>
        <p className="section-head__body">The local proxy serves it at <code>{DASHBOARD_URL}</code> with a token it prints at start. This site never sees your decisions, your policy or your token.</p>
      </div>
      <DashboardLauncher url={DASHBOARD_URL} />
    </section>
  );
}
