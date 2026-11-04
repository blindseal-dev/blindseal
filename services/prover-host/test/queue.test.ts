import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AttestationJson, ProofBackend, ProofJob } from '../src/backends/types.js';
import { ProofQueue } from '../src/jobs/queue.js';
import { JobStore, type JobRecord } from '../src/jobs/store.js';
import { fixtureAttestation, rmTmp, tmpDir } from './helpers.js';

const ACTION = { chainId: 1, targetProgram: '9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa', sourceAuthority: 'GdPZNkh4Ugt3PCauGtUdNVDXsxDHFigbGqy4gjYGNC3L', instruction: '0x981894646560fc2b', recipient: '6HwAr9cu97PENQ727LhLErACyGznWyenKpsfTVQ5rmXo', mint: '11111111111111111111111111111111', amount: '1000000' };

let n = 0;
function record(over: Partial<JobRecord> = {}): JobRecord {
  const now = new Date(Date.now() + n++).toISOString();
  return { id: 'j_' + (n.toString(16).padStart(16, '0')), status: 'queued', createdAt: now, updatedAt: now, backend: 'local', payloadHash: '0x00', action: ACTION, expirySlot: '2000000000', decisionId: 'd_test', payment: { status: 'not-billed' }, ...over };
}

/// A backend that records the order jobs start in, how many run at once, and resolves when told to.
function fakeBackend(opts: { fail?: boolean; hold?: boolean } = {}) {
  const started: string[] = [];
  const seenPayloads: string[] = [];
  let concurrent = 0; let peak = 0;
  const releases: Array<() => void> = [];
  const backend: ProofBackend = {
    name: 'local',
    async prove(job: ProofJob, signal: AbortSignal): Promise<AttestationJson> {
      started.push(job.id);
      seenPayloads.push(path.basename(path.dirname(job.payloadPath)));
      concurrent++; peak = Math.max(peak, concurrent);
      try {
        if (opts.hold) await new Promise<void>((resolve, reject) => { releases.push(resolve); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
        if (opts.fail) throw new Error('gpu went away');
        return fixtureAttestation();
      } finally { concurrent--; }
    },
  };
  return { backend, started, seenPayloads, peak: () => peak, release: () => { for (const r of releases.splice(0)) r(); } };
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmTmp(d); });

describe('ProofQueue', () => {
  it('runs jobs first in, first out at concurrency 1 and persists the attestation', async () => {
    const dir = tmpDir(); dirs.push(dir);
    const store = JobStore.open(dir);
    const fb = fakeBackend();
    const q = new ProofQueue({ store, backend: fb.backend, concurrency: 1, tmpRoot: dir });
    const recs = [record(), record(), record()];
    for (const r of recs) { store.create(r, '{"tool":"t","args":{}}'); q.enqueue(r); }
    await q.idle();
    expect(fb.started).toEqual(recs.map((r) => r.id));
    expect(fb.peak()).toBe(1);
    for (const r of recs) {
      const got = store.get(r.id)!;
      expect(got.status).toBe('done');
      expect(got.proveMs).toBeGreaterThanOrEqual(0);
      expect(store.readAttestation(r.id)).toEqual(fixtureAttestation());
      expect(store.readPayload(r.id)).toBeUndefined(); // the payload copy is gone once the job is finished
    }
    // the per-job 0700 directories are removed
    for (const d of fb.seenPayloads) expect(existsSync(path.join(dir, d))).toBe(false);
  });

  it('runs up to `concurrency` jobs at once', async () => {
    const dir = tmpDir(); dirs.push(dir);
    const store = JobStore.open(dir);
    const fb = fakeBackend({ hold: true });
    const q = new ProofQueue({ store, backend: fb.backend, concurrency: 2, tmpRoot: dir });
    for (const r of [record(), record(), record()]) { store.create(r, '{}'); q.enqueue(r); }
    await new Promise((r) => setTimeout(r, 50));
    expect(q.stats()).toEqual({ queued: 1, running: 2 });
    fb.release();
    await new Promise((r) => setTimeout(r, 50));
    fb.release();
    await q.idle();
    expect(fb.peak()).toBe(2);
  });

  it('marks a backend failure as failed, and a settled payment as charged-failed', async () => {
    const dir = tmpDir(); dirs.push(dir);
    const store = JobStore.open(dir);
    const q = new ProofQueue({ store, backend: fakeBackend({ fail: true }).backend, concurrency: 1, tmpRoot: dir });
    const paid = record({ payment: { status: 'settled', payer: 'p', transaction: 'sig', amount: '500000' } });
    const free = record();
    for (const r of [paid, free]) { store.create(r, '{}'); q.enqueue(r); }
    await q.idle();
    expect(store.get(paid.id)!.status).toBe('failed');
    expect(store.get(paid.id)!.payment.status).toBe('charged-failed');
    expect(store.get(paid.id)!.payment.payer).toBe('p');
    expect(store.get(paid.id)!.error?.message).toContain('gpu went away');
    expect(store.get(free.id)!.payment.status).toBe('not-billed');
  });

  it('survives a restart: finished attestations stay, unfinished jobs are queued again', async () => {
    const dir = tmpDir(); dirs.push(dir);
    const store = JobStore.open(dir);
    const fb = fakeBackend({ hold: true });
    const q = new ProofQueue({ store, backend: fb.backend, concurrency: 1, tmpRoot: dir });
    const done = record(); store.create(done, '{}'); q.enqueue(done);
    await new Promise((r) => setTimeout(r, 30)); fb.release(); await q.idle();
    const interrupted = record(); store.create(interrupted, '{}'); q.enqueue(interrupted);
    const waiting = record(); store.create(waiting, '{}'); q.enqueue(waiting);
    await new Promise((r) => setTimeout(r, 30));
    expect(store.get(interrupted.id)!.status).toBe('running');
    await q.shutdown(); // aborts the running job; it goes back to queued with its payload kept
    expect(store.get(interrupted.id)!.status).toBe('queued');
    expect(store.readPayload(interrupted.id)).toBe('{}');
    // a job whose payload is gone cannot be resumed
    const lost = record({ status: 'running' }); store.create(lost, '{}'); store.deletePayload(lost.id);

    const store2 = JobStore.open(dir);
    const fb2 = fakeBackend();
    const q2 = new ProofQueue({ store: store2, backend: fb2.backend, concurrency: 1, tmpRoot: dir });
    expect(q2.recover()).toEqual({ requeued: 2, failed: 1 });
    await q2.idle();
    expect(store2.get(done.id)!.status).toBe('done');
    expect(store2.readAttestation(done.id)).toEqual(fixtureAttestation());
    expect(fb2.started).toEqual([interrupted.id, waiting.id]);
    expect(store2.get(interrupted.id)!.status).toBe('done');
    expect(store2.get(waiting.id)!.status).toBe('done');
    expect(store2.get(lost.id)!.status).toBe('failed');
    expect(store2.get(lost.id)!.error?.code).toBe('lost');
  });
});
