// Mainnet explorer — a server component: the read happens on the server via @blindseal/chain-reads
// (BLINDSEAL_RPC_URL), so the visitor's browser never contacts an RPC (zero-egress). When no RPC
// is configured or the read fails, the page shows clearly-labelled example figures, never
// presented as live.
import { getExplorerSnapshot, VERIFY_PROGRAM_ID } from '@blindseal/chain-reads';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const EXAMPLE = {
  perDay: [12, 18, 9, 24, 31, 15, 22, 28, 19, 26, 14, 33, 21, 17],
  policyRoots: [{ root: '0x36a9e9457db6ecfd752a379fc9279ad6a0acfea07928f61e2f3638a685c38397', registeredAtSlot: 0 }],
  consumers: [{ id: 'ErAS5x2oUky3aCJPasSKNaf8USVE9of5vzHHCPWwSEVG', calls: 203 }, { id: 'direct submit', calls: 58 }],
};
const short = (s: string) => (s.length > 20 ? `${s.slice(0, 10)}…${s.slice(-4)}` : s);

export default async function Explorer() {
  const snap = await getExplorerSnapshot();
  const live = snap.live;
  const perDay = live ? snap.perDay : EXAMPLE.perDay;
  const roots = live ? snap.policyRoots : EXAMPLE.policyRoots;
  const consumers = live ? snap.consumers : EXAMPLE.consumers;
  const verifications = live ? snap.verifications : perDay.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...perDay);
  return (
    <section className="site-section s05">
      <div className="section-head"><div className="section-head__lead"><p className="section-head__eyebrow"><b>·</b> / Explorer</p><h1 className="section-head__title">Mainnet explorer</h1></div>
        <p className="section-head__body">Public on-chain reads only — verifications over time, allowlisted policy roots, and consumer programs. No agent is identifiable here.</p></div>
      <p className="s05-source mono is-faint" data-live={String(live)}>
        {live
          ? <>live · Solana mainnet · program <span className="mono">{short(VERIFY_PROGRAM_ID)}</span>{snap.currentSlot ? <> · slot {snap.currentSlot}</> : null}{snap.rpc === 'public' ? ' · public RPC (rate-limited)' : ''}</>
          : <>example figures — {snap.rpc === 'off' ? 'reads disabled' : snap.error ? `mainnet read failed: ${snap.error}` : 'no RPC configured'} · program <span className="mono">{short(VERIFY_PROGRAM_ID)}</span></>}
      </p>
      <div className="stat-grid" style={{ ['--cols' as any]: 3 }}>
        <div className="stat"><p className="stat__k">Verifications</p><p className="stat__v num">{verifications}</p><p className="stat__d">{live ? 'nullifiers consumed, all time' : 'example'}</p></div>
        <div className="stat"><p className="stat__k">Policy roots</p><p className="stat__v num">{roots.length}</p><p className="stat__d">registered</p></div>
        <div className="stat"><p className="stat__k">Consumer programs</p><p className="stat__v num">{consumers.length}</p><p className="stat__d">gating on attestations</p></div>
      </div>
      <div className="site-panel s05-bars"><h2 className="panel__title">Verifications per day <span className="is-faint">(last 14)</span></h2>
        <div className="s05-chart" role="img" aria-label="Verifications per day, last 14 days">
          {perDay.map((d, i) => <span key={i} className="s05-bar" style={{ height: `${(d / max) * 100}%` }} title={`${d} verifications`} />)}
        </div>
      </div>
      <div className="site-panel"><h2 className="panel__title">Policy roots</h2>
        <table className="table"><tbody>{roots.length === 0 ? <tr><td className="is-muted">none registered yet</td></tr> : roots.map((r) => <tr key={r.root}><td className="mono is-faint">{short(r.root)}</td><td className="num">{r.registeredAtSlot ? `slot ${r.registeredAtSlot}` : ''}</td></tr>)}</tbody></table></div>
      <div className="site-panel"><h2 className="panel__title">Consumer programs</h2>
        <table className="table"><tbody>{consumers.length === 0 ? <tr><td className="is-muted">no verifications yet</td></tr> : consumers.map((p) => <tr key={p.id}><td className="mono is-faint">{p.id === 'direct submit' ? p.id : short(p.id)}</td><td className="num">{p.calls}</td></tr>)}</tbody></table></div>
    </section>
  );
}
