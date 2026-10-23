import { useState, type ReactNode } from 'react';
import { useAttestation, useAttestations, useSubmitAttestation } from '../api/hooks';
import type { Attestation, AttestationStatus } from '../api/types';
import { Hash } from '../components/Hash';
import { StatusChip } from '../components/StatusChip';

const STATUSES: (AttestationStatus | '')[] = ['', 'generating', 'generated', 'submitted', 'consumed', 'expired', 'rejected'];

// Decoded public inputs, in the guest commit order (docs/FRONTEND-CONTRACT.md §1).
const PI_LABELS = ['payloadHash', 'policyRoot', 'detectorVersion', 'actionHash', 'nullifier', 'expirySlot'];

function download(a: Attestation) {
  const blob = new Blob([JSON.stringify(a, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `attestation-${a.id}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function Attestations() {
  const [status, setStatus] = useState<AttestationStatus | ''>('');
  const [selected, setSelected] = useState<string | undefined>();
  const { data: items = [], isLoading } = useAttestations(status || undefined);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 360px' : '1fr', gap: 20 }}>
      <div>
        <div className="bs-pagehead">
          <div className="bs-seg">
            {STATUSES.map((s) => (
              <button key={s || 'all'} aria-pressed={status === s} onClick={() => setStatus(s)}>
                {s || 'All'}
              </button>
            ))}
          </div>
        </div>
        <div className="bs-panel">
          {isLoading ? (
            <div className="bs-empty">Loading…</div>
          ) : items.length === 0 ? (
            <div className="bs-empty">No attestations in this state.</div>
          ) : (
            <table className="bs-table">
              <thead>
                <tr><th>ID</th><th>Decision</th><th>Status</th><th>Action hash</th><th>Expiry</th></tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id} onClick={() => setSelected(a.id)}>
                    <td className="bs-mono">{a.id}</td>
                    <td className="bs-mono bs-faint">{a.decisionId.slice(0, 8)}…</td>
                    <td><StatusChip status={a.status} /></td>
                    <td><Hash value={a.actionHash} /></td>
                    <td className="bs-mono bs-faint">{a.expirySlot}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {selected && <Detail id={selected} onClose={() => setSelected(undefined)} />}
    </div>
  );
}

function Detail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: a, isLoading } = useAttestation(id);
  const submit = useSubmitAttestation();
  const [cluster, setCluster] = useState<'devnet' | 'mainnet-beta'>('devnet');

  if (isLoading || !a) return <div className="bs-panel bs-stub">Loading…</div>;

  return (
    <aside className="bs-panel" style={{ padding: 18, alignSelf: 'start', position: 'sticky', top: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <StatusChip status={a.status} />
        <button className="bs-hash" onClick={onClose} aria-label="close">✕</button>
      </div>

      <div className="bs-faint" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
        Public inputs <span style={{ textTransform: 'none' }}>(verified, guest order)</span>
      </div>
      <div style={{ display: 'grid', gap: 6, marginBottom: 16 }}>
        {(a.publicInputs ?? []).map((pi, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '116px 1fr', gap: 8, alignItems: 'center' }}>
            <span className="bs-faint bs-mono" style={{ fontSize: 11 }}>{PI_LABELS[i] ?? `#${i}`}</span>
            <Hash value={pi} />
          </div>
        ))}
      </div>

      <KV label="Proof"><Hash value={a.proof.bytes} /> <span className="bs-faint">{a.proof.protocol}/{a.proof.curve}</span></KV>
      <KV label="Nullifier"><Hash value={a.nullifier} /></KV>
      <KV label="TEE">{a.tee.mode}</KV>
      {a.txSig && <KV label="Tx"><Hash value={a.txSig} /></KV>}

      <div style={{ display: 'flex', gap: 8, marginTop: 16, alignItems: 'center' }}>
        <select value={cluster} onChange={(e) => setCluster(e.target.value as 'devnet' | 'mainnet-beta')}
          style={{ background: 'var(--canvas)', color: 'var(--ink)', border: 'var(--hairline)', borderRadius: 8, padding: '6px 8px' }}>
          <option value="devnet">devnet</option>
          <option value="mainnet-beta">mainnet-beta</option>
        </select>
        <button className="bs-btn bs-btn--primary" disabled={submit.isPending} onClick={() => submit.mutate({ id, cluster })}>
          {submit.isPending ? 'Submitting…' : 'Submit'}
        </button>
        <button className="bs-btn" onClick={() => download(a)}>Export</button>
      </div>
      {submit.data && <p className="bs-muted" style={{ marginTop: 10 }}>Tx <Hash value={submit.data.txSig} /></p>}
    </aside>
  );
}

function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 8, padding: '5px 0', alignItems: 'center' }}>
      <span className="bs-faint" style={{ fontSize: 12 }}>{label}</span>
      <span>{children}</span>
    </div>
  );
}
