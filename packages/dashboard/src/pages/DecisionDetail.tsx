import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Decision, DecisionPage } from '../api/types';
import { useDecision, useAttestation, useCreateAttestation, useRevealPayload, useBusEvent } from '../api/hooks';
import { Hash, Icon, VerdictChip, StatusChip, Figure } from '../kit/react';

const fmt = {
  dateTime: (ts: string) => window.BS?.fmt?.dateTime?.(ts) ?? new Date(ts).toISOString(),
  ms: (n: number) => window.BS?.fmt?.ms?.(n) ?? `${Math.round(n)} ms`,
};

export function DecisionDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data: d, isLoading, error } = useDecision(id);

  // neighbours: newer (prev) / older (next), by ts, from the decisions list
  const { data: list } = useQuery({ queryKey: ['decisions', 'base', 'limit=200'], queryFn: () => api.get<DecisionPage>('/decisions?limit=200') });
  const neighbours = useMemo(() => {
    const items = (list?.items ?? []).slice().sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    const i = items.findIndex((x) => x.id === id);
    return { prev: i > 0 ? items[i - 1] : null, next: i >= 0 && i < items.length - 1 ? items[i + 1] : null };
  }, [list, id]);

  if (isLoading) return <div className="page d02"><p className="is-muted" style={{ padding: 24 }}>Loading…</p></div>;
  if (error || !d) return <div className="page d02"><div className="panel" style={{ padding: 24 }}><p className="eyebrow">Not found</p><p className="is-muted">No decision with that id.</p><Link className="btn link" to="/decisions">← Decisions</Link></div></div>;

  return (
    <div className="page d02" aria-live="off">
      <nav className="d02-crumb">
        <Link to="/decisions" className="btn link sm"><Icon name="chevron-left" />Decisions</Link>
        <span className="d02-crumb__id mono">{d.id}</span>
        <span className="filter-bar__spacer" />
        <button type="button" className="icon-btn" disabled={!neighbours.prev} aria-label="Newer decision" onClick={() => neighbours.prev && nav(`/decisions/${neighbours.prev.id}`)}><Icon name="chevron-left" /></button>
        <button type="button" className="icon-btn" disabled={!neighbours.next} aria-label="Older decision" onClick={() => neighbours.next && nav(`/decisions/${neighbours.next.id}`)}><Icon name="chevron-right" /></button>
      </nav>

      <section className="panel d02-head reveal">
        <header className="panel__head">
          <h1 className="d02-head__title"><span>{d.server}</span><i aria-hidden>·</i><span className="mono">{d.tool}</span></h1>
          <VerdictChip verdict={d.verdict} />
        </header>
        <dl className="kv d02-meta">
          <div><dt>When</dt><dd className="mono">{fmt.dateTime(d.ts)}</dd></div>
          <div><dt>Direction</dt><dd>{d.direction === 'request' ? 'Request — screened before the call ran' : 'Response — screened before the agent saw it'}</dd></div>
          <div><dt>Latency</dt><dd className="num">{fmt.ms(d.latencyMs)}</dd></div>
          <div><dt>Audit</dt><dd>#{d.auditIndex} <Hash value={d.auditHash} /></dd></div>
        </dl>
      </section>

      <section className="panel d02-layers reveal">
        <header className="panel__head"><h2 className="panel__title">Layers</h2>
          <p className="sub num">{d.layers.filter((l) => l.ran).length} ran · {4 - d.layers.filter((l) => l.ran).length} skipped · {fmt.ms(d.layers.reduce((a, l) => a + (l.latencyMs || 0), 0))} in layers</p>
        </header>
        <Figure name="layers" opts={{ verdict: d.verdict, results: d.layers, caption: false }} className="d02-fig" />
        <div className="d02-layerrows">
          {d.layers.map((l) => (
            <div key={l.layer} className="d02-layerrow" data-v={l.ran ? l.verdict : 'skip'}>
              <span className="mono">{l.layer}</span>
              <span className="is-muted">{l.ran ? l.verdict : 'skipped'}</span>
              <span className="is-faint mono">{l.ruleIds?.join(', ') ?? (l.score != null ? `score ${l.score}` : '')}</span>
              <span className="num is-faint">{l.latencyMs ? fmt.ms(l.latencyMs) : ''}</span>
            </div>
          ))}
        </div>
      </section>

      {d.redactions.length > 0 && (
        <section className="panel d02-red reveal">
          <header className="panel__head"><h2 className="panel__title">Redaction</h2><p className="sub num">{d.redactions.reduce((a, r) => a + r.count, 0)} spans removed before L2/L3</p></header>
          <div className="d02-redlist">{d.redactions.map((r) => <span key={r.kind} className="chip outline">{r.kind} × {r.count}</span>)}</div>
        </section>
      )}

      {d.action && (
        <section className="panel d02-action reveal">
          <header className="panel__head"><h2 className="panel__title">Action</h2><p className="sub">parsed from the payload · hashed into any attestation</p></header>
          <dl className="kv">
            <div><dt>Chain</dt><dd>{d.action.chain}</dd></div>
            <div><dt>Program</dt><dd><Hash value={d.action.targetProgram} /></dd></div>
            {d.action.sourceAuthority && <div><dt>Authority</dt><dd><Hash value={d.action.sourceAuthority} /></dd></div>}
            {d.action.instruction && <div><dt>Instruction</dt><dd className="mono">{d.action.instruction}</dd></div>}
            {d.action.recipient && <div><dt>Recipient</dt><dd><Hash value={d.action.recipient} /></dd></div>}
            {d.action.amount && <div><dt>Amount</dt><dd className="num">{d.action.amount}</dd></div>}
            {d.action.mint && <div><dt>Mint</dt><dd><Hash value={d.action.mint} /></dd></div>}
          </dl>
        </section>
      )}

      <section className="panel d02-hashes reveal">
        <header className="panel__head"><h2 className="panel__title">Commitments</h2></header>
        <dl className="kv">
          <div><dt>Payload</dt><dd><Hash value={d.payloadHash} label="Payload hash" lg /></dd></div>
          <div><dt>Redacted</dt><dd><Hash value={d.redactedHash} label="Redacted hash" lg /></dd></div>
          <div><dt>Policy root</dt><dd><Hash value={d.policyRoot} lg /></dd></div>
          <div><dt>Detector</dt><dd><Hash value={d.detectorVersion} lg /></dd></div>
        </dl>
      </section>

      <AttestationPanel decision={d} />
      <RawPayload decision={d} />
    </div>
  );
}

function AttestationPanel({ decision }: { decision: Decision }) {
  const create = useCreateAttestation();
  const [newId, setNewId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ status: string; pct: number } | null>(null);
  const attId = newId ?? decision.attestationId;
  const { data: att } = useAttestation(attId ?? undefined);
  useBusEvent('attestation', (a: { id: string; status: string; progressPct?: number }) => {
    if (a.id === attId) setProgress({ status: a.status, pct: a.progressPct ?? 0 });
  });
  const status = progress?.status ?? att?.status;

  return (
    <section className="panel d02-att reveal">
      <header className="panel__head"><h2 className="panel__title">Attestation</h2></header>
      {!decision.action ? (
        <p className="is-muted">This decision has no on-chain action to attest.</p>
      ) : status ? (
        <div className="d02-att__row"><StatusChip status={status} progress={progress?.pct} />{att?.proof?.bytes && <Hash value={att.proof.bytes} label="Groth16 proof" />}</div>
      ) : (
        <button type="button" className="btn primary" disabled={create.isPending}
          onClick={() => create.mutate(decision.id, { onSuccess: (r) => { setNewId(r.id); setProgress({ status: 'generating', pct: 0 }); } })}>
          {create.isPending ? 'Requesting…' : 'Request attestation'}
        </button>
      )}
    </section>
  );
}

function RawPayload({ decision }: { decision: Decision }) {
  const reveal = useRevealPayload();
  const [raw, setRaw] = useState<string | null>(null);
  useEffect(() => () => setRaw(null), [decision.id]); // drop on nav (memory only)
  return (
    <section className="panel d02-raw reveal">
      <header className="panel__head"><h2 className="panel__title">Raw payload</h2><p className="sub">hidden by default · never stored · dropped on navigation</p></header>
      {raw != null ? (
        <>
          <pre className="code d02-rawbox">{raw}</pre>
          <button type="button" className="btn secondary sm" onClick={() => setRaw(null)}><Icon name="eye-off" />Hide</button>
        </>
      ) : (
        <button type="button" className="btn secondary" disabled={reveal.isPending}
          onClick={() => { if (window.confirm('Reveal the raw payload? It is shown in memory only and never stored.')) reveal.mutate(decision.id, { onSuccess: (r) => setRaw(r.payload) }); }}>
          <Icon name="eye" />{reveal.isPending ? 'Revealing…' : 'Reveal raw payload'}
        </button>
      )}
    </section>
  );
}
