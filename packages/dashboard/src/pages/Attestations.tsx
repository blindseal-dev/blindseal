import { useEffect, useState } from 'react';
import { useAttestations, useAttestation, useSubmitAttestation, useBusEvent } from '../api/hooks';
import type { Attestation, AttestationStatus } from '../api/types';
import { Hash, Icon, StatusChip } from '../kit/react';
import { splitPublicInputs } from '../api/publicInputs';

const STATUSES: (AttestationStatus | '')[] = ['', 'generating', 'generated', 'submitted', 'consumed', 'expired', 'rejected'];
const LIFECYCLE: AttestationStatus[] = ['generating', 'generated', 'submitted', 'consumed'];

function download(a: Attestation) {
  const blob = new Blob([JSON.stringify(a, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const el = document.createElement('a'); el.href = url; el.download = `attestation-${a.id}.json`; el.click();
  URL.revokeObjectURL(url);
}

export function Attestations() {
  const [status, setStatus] = useState<AttestationStatus | ''>('');
  const [selected, setSelected] = useState<string | undefined>();
  const { data: items = [], isLoading, refetch } = useAttestations(status || undefined);
  useBusEvent('attestation', () => refetch());

  return (
    <div className="page d05">
      <section className="panel d05-filters reveal" aria-label="Filter">
        <div className="seg">
          {STATUSES.map((s) => (
            <button key={s || 'all'} type="button" className={`seg__item${status === s ? ' is-active' : ''}`} aria-pressed={status === s} onClick={() => setStatus(s)}>{s || 'All'}</button>
          ))}
        </div>
      </section>
      <section className="table-box d05-table reveal" aria-label="Attestations">
        <table className="table">
          <thead><tr><th>ID</th><th>Decision</th><th>Status</th><th>Action hash</th><th className="num">Expiry slot</th></tr></thead>
          <tbody>
            {isLoading ? <tr><td colSpan={5} className="is-muted" style={{ padding: 24 }}>Loading…</td></tr>
              : items.length === 0 ? <tr><td colSpan={5} className="is-muted" style={{ padding: 24 }}>No attestations in this state.</td></tr>
              : items.map((a) => (
                <tr key={a.id} className="is-clickable" onClick={() => setSelected(a.id)}>
                  <td className="mono">{a.id}</td>
                  <td className="mono is-faint">{a.decisionId.slice(0, 8)}…</td>
                  <td><StatusChip status={a.status} progress={a.progressPct} /></td>
                  <td><Hash value={a.actionHash} /></td>
                  <td className="num">{a.expirySlot}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
      {selected && <Sheet id={selected} onClose={() => setSelected(undefined)} />}
    </div>
  );
}

function Sheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: a, isLoading } = useAttestation(id);
  const submit = useSubmitAttestation();
  const [cluster, setCluster] = useState<'devnet' | 'mainnet-beta'>('devnet');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="d05-scrim" onClick={onClose}>
      <aside className="sheet d05-sheet glass" role="dialog" aria-label="Attestation detail" onClick={(e) => e.stopPropagation()}>
        {isLoading || !a ? <p className="is-muted" style={{ padding: 24 }}>Loading…</p> : (
          <>
            <header className="sheet__head glass-item">
              <StatusChip status={a.status} progress={a.progressPct} />
              <span className="mono is-faint">{a.id}</span>
              <span className="filter-bar__spacer" />
              <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
            </header>
            <div className="sheet__body d05-body">
              <ol className="d05-life" aria-label="Lifecycle">
                {LIFECYCLE.map((s) => <li key={s} className="d05-life__step" data-on={LIFECYCLE.indexOf(a.status as AttestationStatus) >= LIFECYCLE.indexOf(s) ? 'true' : 'false'}>{s}</li>)}
              </ol>
              <h3 className="d05-h">Public inputs <span className="is-faint">(verified, guest order)</span></h3>
              <dl className="kv d05-pi">
                {splitPublicInputs(a.publicInputs).map((f) => <div key={f.label}><dt className="mono">{f.label}</dt><dd>{f.hash ? <Hash value={f.value} /> : <span className="mono">{f.value}</span>}</dd></div>)}
              </dl>
              <dl className="kv">
                <div><dt>Proof</dt><dd><Hash value={a.proof?.bytes} label="Groth16 proof" /> <span className="is-faint">{a.proof?.protocol}/{a.proof?.curve}</span></dd></div>
                <div><dt>Nullifier</dt><dd><Hash value={a.nullifier} /></dd></div>
                <div><dt>TEE</dt><dd>{a.tee?.mode}</dd></div>
                {a.txSig && <div><dt>Tx</dt><dd><Hash value={a.txSig} /></dd></div>}
              </dl>
              <div className="d05-actions">
                <select className="select" value={cluster} onChange={(e) => setCluster(e.target.value as 'devnet' | 'mainnet-beta')} aria-label="Cluster">
                  <option value="devnet">devnet</option><option value="mainnet-beta">mainnet-beta</option>
                </select>
                <button type="button" className="btn primary" disabled={submit.isPending} onClick={() => submit.mutate({ id, cluster })}>{submit.isPending ? 'Submitting…' : 'Submit'}</button>
                <button type="button" className="btn secondary" onClick={() => download(a)}><Icon name="download" />Export</button>
              </div>
              {submit.data && <p className="is-muted">Tx <Hash value={submit.data.txSig} /></p>}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
