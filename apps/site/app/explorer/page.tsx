const DAYS = [12, 18, 9, 24, 31, 15, 22, 28, 19, 26, 14, 33, 21, 17];
const ROOTS = [{ root: '0x36a9e9457db6ecfd752a379fc9279ad6a0acfea07928f61e2f3638a685c38397', count: 184 }, { root: '0x9f21c0…447a', count: 42 }];
const PROGRAMS = [{ id: 'BSveriFy11111111111111111111111111111111111', calls: 203 }, { id: 'Escrow1111111111111111111111111111111111111', calls: 58 }];
export default function Explorer() {
  const max = Math.max(...DAYS);
  return (
    <section className="site-section s05">
      <div className="section-head"><div className="section-head__lead"><p className="section-head__eyebrow"><b>·</b> / Explorer</p><h1 className="section-head__title">Mainnet explorer</h1></div>
        <p className="section-head__body">Public on-chain reads only — verifications over time, allowlisted policy roots, and consumer programs. No agent is identifiable here.</p></div>
      <div className="stat-grid" style={{ ['--cols' as any]: 3 }}>
        <div className="stat"><p className="stat__k">Verifications</p><p className="stat__v num">{DAYS.reduce((a, b) => a + b, 0)}</p><p className="stat__d">last 14 days</p></div>
        <div className="stat"><p className="stat__k">Policy roots</p><p className="stat__v num">{ROOTS.length}</p><p className="stat__d">allowlisted</p></div>
        <div className="stat"><p className="stat__k">Consumer programs</p><p className="stat__v num">{PROGRAMS.length}</p><p className="stat__d">gating on attestations</p></div>
      </div>
      <div className="site-panel s05-bars"><h2 className="panel__title">Verifications per day</h2>
        <div className="s05-chart" role="img" aria-label="Verifications per day, last 14 days">
          {DAYS.map((d, i) => <span key={i} className="s05-bar" style={{ height: `${(d / max) * 100}%` }} title={`${d} verifications`} />)}
        </div>
      </div>
      <div className="site-panel"><h2 className="panel__title">Policy roots</h2>
        <table className="table"><tbody>{ROOTS.map((r) => <tr key={r.root}><td className="mono is-faint">{r.root.length > 20 ? `${r.root.slice(0, 10)}…${r.root.slice(-4)}` : r.root}</td><td className="num">{r.count}</td></tr>)}</tbody></table></div>
      <div className="site-panel"><h2 className="panel__title">Consumer programs</h2>
        <table className="table"><tbody>{PROGRAMS.map((p) => <tr key={p.id}><td className="mono is-faint">{p.id.slice(0, 8)}…{p.id.slice(-4)}</td><td className="num">{p.calls}</td></tr>)}</tbody></table></div>
    </section>
  );
}
