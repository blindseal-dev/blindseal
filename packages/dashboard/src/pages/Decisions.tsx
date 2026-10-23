import { useEffect, useMemo, useState, type CSSProperties, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import type { Decision, DecisionPage, Verdict } from '../api/types';
import { useStatus, useBusEvent } from '../api/hooks';
import { useTopActions } from '../App';
import { Hash, Icon, VerdictChip, Layers, StatusChip, useOdometer, reducedMotion } from '../kit/react';

// Reuse the kit's pure formatters (window.BS.fmt) with small fallbacks.
const bs = () => (typeof window !== 'undefined' ? window.BS : undefined);
const fmt = {
  time: (ts: string) => bs()?.fmt?.time?.(ts) ?? new Date(ts).toLocaleTimeString([], { hour12: false }),
  dateTime: (ts: string) => bs()?.fmt?.dateTime?.(ts) ?? new Date(ts).toISOString(),
  ms: (n: number) => bs()?.fmt?.ms?.(n) ?? `${Math.round(n)} ms`,
  int: (n: number) => bs()?.fmt?.int?.(n) ?? String(n),
  pct: (n: number) => bs()?.fmt?.pct?.(n) ?? `${Math.round(n * 100)}%`,
  shortB58: (s: string) => bs()?.fmt?.shortB58?.(s) ?? (s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s),
};

const HOUR = 36e5, DAY = 864e5;
const RANGES: Record<string, number> = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY };

interface Filter { verdict: 'all' | Verdict; server: string; tool: string; range: string; from: number | null; to: number | null; }
const DEFAULT: Filter = { verdict: 'all', server: '', tool: '', range: 'all', from: null, to: null };

function Stat({ label, keyName, value, share }: { label: string; keyName?: Verdict; value: number; share?: string }) {
  const ref = useOdometer(value, { mode: 'roll', format: fmt.int });
  return (
    <div className="stat">
      <p className="stat__k">{keyName && <span className="d01-key" data-v={keyName} />}{label}</p>
      <p className="stat__v num" ref={ref as RefObject<HTMLParagraphElement>}>0</p>
      <p className="stat__d">{share ?? ''}</p>
    </div>
  );
}

export function Decisions() {
  const nav = useNavigate();
  const setActions = useTopActions();
  const { data: status } = useStatus();
  const [filter, setFilter] = useState<Filter>(DEFAULT);
  const [shown, setShown] = useState(50);
  const [live, setLive] = useState(true);
  const [liveRows, setLiveRows] = useState<Decision[]>([]);
  const [queue, setQueue] = useState<Decision[]>([]);

  // Base fetch: everything in the server/tool/time window (all verdicts) so counts are correct.
  const qs = new URLSearchParams();
  if (filter.server) qs.set('server', filter.server);
  if (filter.tool) qs.set('tool', filter.tool);
  if (filter.from != null) qs.set('from', new Date(filter.from).toISOString());
  if (filter.to != null) qs.set('to', new Date(filter.to).toISOString());
  qs.set('limit', '200');
  const { data, error, isLoading } = useQuery({
    queryKey: ['decisions', 'base', qs.toString()],
    queryFn: () => api.get<DecisionPage>(`/decisions?${qs}`),
    retry: (n, e) => !(e instanceof ApiError && (e.status === 401 || e.status === 503)) && n < 1,
  });

  const unauthorized = error instanceof ApiError && error.status === 401;
  const offline = (error instanceof ApiError && error.status === 503) || status?.connection === 'offline';
  const reconnecting = !offline && status?.connection === 'reconnecting';
  const base = data?.items ?? [];
  const empty = !isLoading && !error && base.length === 0 && (status?.audit?.index ?? 0) < 0;

  // live decision frames
  const matchesFilter = useMemo(() => (d: Decision) => {
    const t = Date.parse(d.ts);
    if (filter.server && d.server !== filter.server) return false;
    if (filter.tool && d.tool !== filter.tool) return false;
    if (filter.from != null && t < filter.from) return false;
    if (filter.to != null && t > filter.to) return false;
    return true;
  }, [filter]);
  useBusEvent('decision', (d: Decision) => {
    if (!matchesFilter(d)) return;
    if (live) setLiveRows((r) => (r.some((x) => x.id === d.id) ? r : [d, ...r]));
    else setQueue((q) => (q.some((x) => x.id === d.id) ? q : [d, ...q]));
  });
  const release = () => { setLiveRows((r) => [...queue, ...r]); setQueue([]); };

  // merged + verdict-filtered rows for the table
  const merged = useMemo(() => {
    const seen = new Set<string>();
    const all = [...liveRows, ...base].filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
    all.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    return filter.verdict === 'all' ? all : all.filter((d) => d.verdict === filter.verdict);
  }, [liveRows, base, filter.verdict]);

  const counts = useMemo(() => {
    const c = { total: 0, pass: 0, block: 0, flag: 0 };
    const pool = [...liveRows, ...base];
    const seen = new Set<string>();
    for (const d of pool) { if (seen.has(d.id)) continue; seen.add(d.id); c.total++; c[d.verdict]++; }
    return c;
  }, [liveRows, base]);

  // top-bar Live/Paused + new pill
  useEffect(() => {
    setActions(
      <>
        <div className="glass-seg d01-live" role="group" aria-label="Live stream">
          <button type="button" className={`glass-seg__item${live ? ' is-active' : ''}`} aria-pressed={live} onClick={() => { setLive(true); release(); }}>
            <span className="live-dot" aria-hidden />Live
          </button>
          <button type="button" className={`glass-seg__item${!live ? ' is-active' : ''}`} aria-pressed={!live} onClick={() => setLive(false)}>
            <Icon name="pause" />Paused
          </button>
        </div>
        {!live && queue.length > 0 && (
          <button type="button" className="d01-newpill is-on" onClick={release} aria-label={`Release ${queue.length} new`}>
            <Icon name="chevron-up" /><span className="num">{queue.length}</span><span>new</span>
          </button>
        )}
      </>,
    );
    return () => setActions(null);
  }, [live, queue.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (unauthorized) return <Unauthorized />;

  const setRange = (v: string) => setFilter((f) => ({ ...f, range: v, from: RANGES[v] ? Date.now() - RANGES[v] : null, to: null }));
  const visible = merged.slice(0, shown);

  return (
    <div className="page d01">
      {(offline || reconnecting) && (
        <div className="d01-banner" data-kind={offline ? 'offline' : 'reconnecting'} role="status" aria-live="polite">
          <span className="d01-banner__ico"><Icon name={offline ? 'triangle-alert' : 'refresh-cw'} /></span>
          <p className="d01-banner__main">
            <span className="d01-banner__t">{offline ? 'Proxy unreachable' : 'Event stream reconnecting'}</span>
            <span className="d01-banner__sep">·</span>
            <span className="d01-banner__retry">{offline ? 'showing cached decisions' : 'live updates held'}</span>
          </p>
          <p className="d01-banner__sub">{offline ? 'Start it with blindseal run. Cached rows stay visible.' : 'The API still answers; filters and Load more work on the latest data.'}</p>
        </div>
      )}

      {empty ? <Onboard upstreams={status?.upstreams ?? []} /> : (
        <>
          <section className="panel d01-filters reveal" aria-label="Filters">
            <div className="filter-bar">
              <div className="seg d01-vseg" role="group" aria-label="Verdict">
                {(['all', 'pass', 'block', 'flag'] as const).map((v) => (
                  <button key={v} type="button" className={`seg__item${filter.verdict === v ? ' is-active' : ''}`} aria-pressed={filter.verdict === v}
                    onClick={() => setFilter((f) => ({ ...f, verdict: v }))}>
                    {v === 'all' ? 'All' : v[0].toUpperCase() + v.slice(1)} <span className="count num">{v === 'all' ? counts.total : counts[v]}</span>
                  </button>
                ))}
              </div>
              <span className="d01-sep" aria-hidden />
              <span className="select-wrap d01-sel">
                <select className="select" aria-label="Server" value={filter.server} onChange={(e) => setFilter((f) => ({ ...f, server: e.target.value, tool: '' }))}>
                  <option value="">All servers</option>
                  {(status?.upstreams ?? []).map((u) => <option key={u.name} value={u.name}>{u.name}</option>)}
                </select><Icon name="chevron-down" />
              </span>
              <span className="d01-sep" aria-hidden />
              <div className="tabs d01-range" role="group" aria-label="Time range">
                {['1h', '24h', '7d', 'all'].map((r) => (
                  <button key={r} type="button" className={`tab${filter.range === r ? ' is-active' : ''}`} aria-pressed={filter.range === r}
                    onClick={() => setRange(r)}>{r === 'all' ? 'All' : r}</button>
                ))}
              </div>
              <span className="filter-bar__spacer" />
              <button type="button" className="btn link sm d01-clear" disabled={JSON.stringify(filter) === JSON.stringify(DEFAULT)}
                onClick={() => { setFilter(DEFAULT); setShown(50); }}>Clear</button>
            </div>
          </section>

          <section className="stat-grid d01-counts reveal" style={{ '--cols': 4 } as CSSProperties} aria-label="Counts for the current filter">
            <Stat label="Matching" value={filter.verdict === 'all' ? counts.total : counts[filter.verdict]} share={`of ${fmt.int(counts.total)} decisions`} />
            <Stat label="Pass" keyName="pass" value={counts.pass} share={counts.total ? `${fmt.pct(counts.pass / counts.total)} of all` : '—'} />
            <Stat label="Block" keyName="block" value={counts.block} share={counts.total ? `${fmt.pct(counts.block / counts.total)} of all` : '—'} />
            <Stat label="Flag" keyName="flag" value={counts.flag} share={counts.total ? `${fmt.pct(counts.flag / counts.total)} of all` : '—'} />
          </section>

          <section className={`table-box d01-tablebox reveal${offline ? ' is-stale' : ''}${merged.length === 0 ? ' is-none' : ''}`} aria-label="Decisions">
            <table className="table d01-table">
              <thead><tr>
                <th>Time</th><th>Server</th><th>Tool</th><th>Dir</th><th>Verdict</th>
                <th>Layers</th><th className="num">Redactions</th><th>Action</th><th>Attestation</th><th className="num">Latency</th><th>Payload</th>
              </tr></thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan={11} className="is-muted" style={{ padding: 24 }}>Loading…</td></tr>
                ) : visible.map((d) => <Row key={d.id} d={d} onOpen={() => nav(`/decisions/${d.id}`)} />)}
              </tbody>
            </table>
            {merged.length === 0 && !isLoading && (
              <div className="d01-none">
                <p className="eyebrow">No decisions match</p>
                <p className="is-muted">Nothing in this window matches these filters. Widen the range or clear them.</p>
                <button type="button" className="btn secondary sm" onClick={() => { setFilter(DEFAULT); setShown(50); }}><Icon name="rotate-ccw" />Clear filters</button>
              </div>
            )}
          </section>

          {merged.length > 0 && (
            <div className="d01-more">
              <p className="d01-more__note">Showing <span className="num">{Math.min(shown, merged.length)}</span> of <span className="num">{merged.length}</span></p>
              <button type="button" className="btn secondary" disabled={shown >= merged.length} onClick={() => setShown((s) => s + 50)}>
                <Icon name="chevron-down" /><span>{shown >= merged.length ? 'All loaded' : `Load ${Math.min(50, merged.length - shown)} more`}</span>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Row({ d, onOpen }: { d: Decision; onOpen: () => void }) {
  const rc = (d.redactions || []).reduce((a, r) => a + r.count, 0);
  return (
    <tr className="table__row is-clickable d01-row" data-id={d.id} onClick={(e) => { if (!(e.target as HTMLElement).closest('.hash')) onOpen(); }}>
      <td className="is-time"><span data-tip={fmt.dateTime(d.ts)}>{fmt.time(d.ts)}</span></td>
      <td>{d.server}</td>
      <td className="is-muted d01-tool">{d.tool}</td>
      <td><span className="d01-dir" data-dir={d.direction}>{d.direction === 'request' ? 'req' : 'res'}</span></td>
      <td><VerdictChip verdict={d.verdict} /></td>
      <td><Layers layers={d.layers} /></td>
      <td className="num">{rc ? <span className="d01-red">{rc}</span> : <span className="d01-nil">—</span>}</td>
      <td>{d.action ? <span className="chip outline d01-act"><Icon name="box" />{d.action.chain}</span> : <span className="d01-nil">—</span>}</td>
      <td>{d.attestationId ? <StatusChip status="generated" /> : <span className="d01-nil">—</span>}</td>
      <td className="num d01-lat">{fmt.ms(d.latencyMs)}</td>
      <td><Hash value={d.payloadHash} label="Payload hash (sha256, pre-redaction)" /></td>
    </tr>
  );
}

function Onboard({ upstreams }: { upstreams: { name: string; transport: string; healthy: boolean }[] }) {
  return (
    <section className="panel d01-onboard reveal" aria-labelledby="d01-onboard-title">
      <div className="d01-onboard__lead">
        <p className="eyebrow">Fresh install</p>
        <h2 className="d01-onboard__title" id="d01-onboard-title">No decisions yet.</h2>
        <p className="d01-onboard__body">Point an agent at the proxy and every tool call appears here as it is screened.</p>
        <p className="d01-listen"><span className="live-dot" aria-hidden />Listening on <span className="d01-mono">127.0.0.1:7777</span><span className="d01-listen__sep">·</span>audit #0</p>
      </div>
      <ol className="d01-steps">
        <li className="d01-step"><span className="d01-step__n">01</span><div className="d01-step__main"><p className="d01-step__t">Route an MCP server through the proxy</p>
          <p className="d01-step__d">Launch the server with <span className="d01-mono">blindseal run</span> in front of it.</p></div></li>
        <li className="d01-step"><span className="d01-step__n">02</span><div className="d01-step__main"><p className="d01-step__t">Upstreams detected <span className="num">{upstreams.length}</span></p>
          <ul className="d01-ups">{upstreams.map((u) => <li key={u.name} className="d01-up" data-healthy={u.healthy}><Icon name={u.transport === 'http' ? 'radio' : 'terminal'} /><span className="d01-up__name">{u.name}</span><span className="d01-up__t">{u.transport}</span></li>)}</ul></div></li>
        <li className="d01-step"><span className="d01-step__n">03</span><div className="d01-step__main"><p className="d01-step__t">Or run mock mode</p>
          <div className="d01-mockline"><code className="code">$ BLINDSEAL_MOCK=1 blindseal run</code></div></div></li>
      </ol>
    </section>
  );
}

function Unauthorized() {
  const [tok, setTok] = useState('');
  const [err, setErr] = useState('');
  void reducedMotion();
  return (
    <div className="d01-auth">
      <div className="d01-auth__col">
        <section className="panel d01-auth__panel" aria-labelledby="d01-auth-title">
          <p className="eyebrow">Blindseal · local dashboard</p>
          <h1 className="d01-auth__title" id="d01-auth-title">Dashboard token required</h1>
          <p className="d01-auth__body">The token is printed when the proxy starts and lives at <span className="d01-mono">~/.blindseal/dashboard.token</span>. Open the dashboard with it in the URL fragment:</p>
          <div className="d01-auth__url"><span className="d01-mono">http://127.0.0.1:7777/#token=…</span></div>
          <form className="d01-auth__form" onSubmit={(e) => { e.preventDefault(); if (!/^[0-9a-f]{48}$/i.test(tok.trim())) setErr('A dashboard token is 48 hex characters.'); else setErr(''); }}>
            <div className="field">
              <label htmlFor="d01-token">Paste token</label>
              <div className="d01-auth__row">
                <input className="input mono" id="d01-token" autoComplete="off" spellCheck={false} placeholder="48 hex characters" value={tok} onChange={(e) => { setTok(e.target.value); setErr(''); }} aria-invalid={err ? true : undefined} />
                <button type="submit" className="btn primary">Continue<span className="nudge"><Icon name="arrow-right" /></span></button>
              </div>
              {err && <p className="field__err"><Icon name="triangle-alert" /><span>{err}</span></p>}
            </div>
          </form>
          <p className="d01-auth__note"><Icon name="info" />The token is kept in memory only: never written to storage, and stripped from the address bar once read.</p>
        </section>
      </div>
    </div>
  );
}
