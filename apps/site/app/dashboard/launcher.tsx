'use client';
import { useEffect, useState } from 'react';

type State = 'probing' | 'running' | 'absent';

// Probes the local proxy from the browser: an opaque (no-cors) fetch of its root resolves when anything
// answers on 127.0.0.1:7777 and rejects on connection refused. Deterministic server render ("probing"),
// the result is client-only by nature.
export function DashboardLauncher({ url }: { url: string }) {
  const [state, setState] = useState<State>('probing');
  useEffect(() => {
    let alive = true;
    const probe = () => fetch(url + '/', { mode: 'no-cors', cache: 'no-store' }).then(() => alive && setState('running'), () => alive && setState('absent'));
    probe();
    const t = setInterval(probe, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [url]);
  return (
    <div className="dash-launch__grid">
      <div className="site-panel dash-launch__status" data-state={state} aria-live="polite">
        <p className="site-panel__n">Local proxy</p>
        {state === 'probing' && <><h2 className="site-panel__title">Looking for the proxy…</h2><p className="site-panel__body">Checking <code>{url}</code> from this browser.</p></>}
        {state === 'running' && <><h2 className="site-panel__title">Running on this machine.</h2><p className="site-panel__body">Open it with the token the proxy printed — it is also in <code>~/.blindseal/dashboard.token</code>.</p>
          <p className="dash-launch__actions"><a className="btn primary" href={url} target="_blank" rel="noopener">Open dashboard<i data-lucide="arrow-up-right" /></a></p></>}
        {state === 'absent' && <><h2 className="site-panel__title">Not running here.</h2><p className="site-panel__body">Nothing answered on <code>{url}</code>. Start the proxy on this machine and this page will notice.</p></>}
      </div>
      <div className="site-panel dash-launch__steps">
        <p className="site-panel__n">Three commands</p>
        <ol className="dash-launch__list">
          <li><span>Install</span><pre className="code"><code>npx @blindseal/proxy init</code></pre></li>
          <li><span>Run it in front of an MCP server (or in mock mode to look around)</span><pre className="code"><code>{'blindseal -- <your-mcp-server>\nBLINDSEAL_MOCK=1 blindseal run --mock'}</code></pre></li>
          <li><span>Open the URL it prints — the token travels in the fragment and is never stored</span><pre className="code"><code>{url}/#token=…</code></pre></li>
        </ol>
        <p className="site-panel__body dash-launch__foot">Local-only by design: the dashboard reads the proxy's API on <code>127.0.0.1</code>; the proxy talks to Solana only when you submit an attestation.</p>
      </div>
    </div>
  );
}
