import { useMemo, useState } from 'react';
import { useAuditHead, useAuditEntries, useVerifyChain, useDisclose } from '../api/hooks';
import type { Disclosure, VerifyResult } from '../api/types';
import { Hash, Icon, VerdictChip, Figure } from '../kit/react';

const fmt = {
  dateTime: (ts: string) => window.BS?.fmt?.dateTime?.(ts) ?? new Date(ts).toISOString(),
  time: (ts: string) => window.BS?.fmt?.time?.(ts) ?? new Date(ts).toLocaleTimeString([], { hour12: false }),
};

function download(d: Disclosure) {
  const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `disclosure-${d.from}-${d.to}.json`; a.click();
  URL.revokeObjectURL(url);
}

export function Audit() {
  const { data: head } = useAuditHead();
  const verify = useVerifyChain();
  const disclose = useDisclose();
  const headIndex = head?.index ?? -1;
  const [range, setRange] = useState<{ from: number; to: number }>({ from: 0, to: 20 });

  // clamp the range to the head
  const from = Math.max(0, Math.min(range.from, Math.max(headIndex, 0)));
  const to = Math.max(from, Math.min(range.to, Math.max(headIndex, 0)));
  const { data: entries = [] } = useAuditEntries(from, to);
  const result = verify.data as VerifyResult | undefined;
  const broken = result && result.ok === false ? result.brokenAt : null;

  const preset = (v: string) => {
    if (v === 'all') setRange({ from: 0, to: Math.max(headIndex, 0) });
    else if (v === 'last100') setRange({ from: Math.max(0, headIndex - 99), to: Math.max(headIndex, 0) });
    else setRange({ from: Math.max(0, headIndex - 99), to: Math.max(headIndex, 0) }); // 24h ~ last 100 at fixture scale
  };

  const figOpts = useMemo(() => ({ from, to, brokenAt: broken ?? undefined }), [from, to, broken]);

  return (
    <div className="page d03">
      <section className="panel d03-head reveal" aria-label="Chain head">
        <div className="d03-head__main">
          <p className="eyebrow d03-head__eyebrow"><span className="live-dot" aria-hidden />Chain head</p>
          <div className="d03-head__row">
            <p className="d03-head__index"><span className="d03-head__hashmark" aria-hidden>#</span><span className="d03-odo num">{headIndex < 0 ? 0 : headIndex}</span></p>
            <span className="d03-head__hash"><Hash value={head?.hash} lg /></span>
          </div>
          <p className="meta-line d03-head__meta">
            <span>{head?.ts ? fmt.dateTime(head.ts) : '—'}</span>
            <span className="d03-dot" aria-hidden />
            <span>entries <b className="num">{headIndex < 0 ? 0 : headIndex + 1}</b></span>
          </p>
          <p className="d03-head__copy">Every decision is written to a hash-chained local log. Entries carry hashes and verdicts, never content.</p>
        </div>
        <div className="d03-verify" aria-live="polite">
          {result ? (
            <div className={`d03-v ${result.ok ? 'is-ok' : 'is-broken'}`}>
              <Icon name={result.ok ? 'circle-check' : 'triangle-alert'} />
              <div className="d03-v__txt">
                <p className="d03-v__title">{result.ok ? 'Chain intact' : `Chain broken at #${broken}`}</p>
                <p className="d03-v__sub">{result.ok ? `#${result.checkedFrom}…#${result.checkedTo} verified from genesis` : 'an entry hash does not match the recomputed chain'}</p>
              </div>
            </div>
          ) : null}
          <button type="button" className="btn primary sm d03-vbtn" disabled={verify.isPending} onClick={() => verify.mutate()}>
            <Icon name="circle-check" />{verify.isPending ? 'Verifying…' : 'Verify chain'}
          </button>
        </div>
      </section>

      <section className="panel d03-range reveal" aria-label="Range">
        <div className="filter-bar">
          <span className="filter-bar__label">Range</span>
          <label className="d03-idx"><span className="d03-idx__k">From</span>
            <input className="input num" type="text" inputMode="numeric" value={from} aria-label="From audit index"
              onChange={(e) => setRange((r) => ({ ...r, from: Number(e.target.value) || 0 }))} /></label>
          <span className="d03-range__arrow" aria-hidden>→</span>
          <label className="d03-idx"><span className="d03-idx__k">To</span>
            <input className="input num" type="text" inputMode="numeric" value={to} aria-label="To audit index"
              onChange={(e) => setRange((r) => ({ ...r, to: Number(e.target.value) || 0 }))} /></label>
          <span className="d03-sep" aria-hidden />
          <div className="tabs d03-presets" role="group" aria-label="Range presets">
            {[['last100', 'Last 100'], ['24h', 'Last 24 h'], ['all', 'All']].map(([v, l]) => (
              <button key={v} type="button" className="tab" onClick={() => preset(v)}>{l}</button>
            ))}
          </div>
          <span className="filter-bar__spacer" />
          <p className="d03-range__count"><b className="num">{entries.length}</b> entries</p>
          <button type="button" className="btn secondary sm" disabled={disclose.isPending || headIndex < 0}
            onClick={() => disclose.mutate({ from, to }, { onSuccess: download })}><Icon name="download" />Export disclosure</button>
        </div>
      </section>

      <section className="panel d03-fig reveal" aria-label="Chain">
        <Figure name="chain" opts={figOpts} className="d03-figbox" />
      </section>

      <section className="table-box d03-entries reveal" aria-label="Entries">
        <table className="table">
          <thead><tr><th className="num">#</th><th>Time</th><th>Verdict</th><th>Decision</th><th>Entry hash</th></tr></thead>
          <tbody>
            {entries.length === 0 ? (
              <tr><td colSpan={5} className="is-muted" style={{ padding: 24 }}>No entries in this range.</td></tr>
            ) : entries.map((e) => (
              <tr key={e.index} className={broken === e.index ? 'is-broken' : undefined}>
                <td className="num">{e.index}</td>
                <td className="mono is-faint">{fmt.time(e.ts)}</td>
                <td><VerdictChip verdict={e.verdict} /></td>
                <td className="mono is-faint">{e.decisionId.slice(0, 8)}…</td>
                <td><Hash value={e.hash} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="is-faint" style={{ fontSize: 12, padding: '10px 2px' }}>Entries are content-free: only hashes, verdicts and timestamps — never the payload.</p>
    </div>
  );
}
