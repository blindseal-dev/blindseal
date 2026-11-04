/// In-memory FIFO over the persisted records. Each job gets a private 0700 directory for the payload
/// and the attestation, removed when the job ends however it ends; the payload copy in the store goes
/// with it. A job interrupted by shutdown goes back to `queued` and is picked up again by `recover()`.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProofBackend, ProofJob } from '../backends/types.js';
import type { JobRecord, JobStore } from './store.js';

export interface QueueOptions {
  store: JobStore;
  backend: ProofBackend;
  concurrency: number;
  log?: (line: string) => void;
  /// Where the per-job directories are made (default os.tmpdir()).
  tmpRoot?: string;
}

export class ProofQueue {
  private readonly pending: string[] = [];
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly waiters: Array<() => void> = [];
  private stopping = false;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: QueueOptions) {
    this.log = opts.log ?? (() => {});
  }

  stats(): { queued: number; running: number } {
    return { queued: this.pending.length, running: this.running.size };
  }

  /// Queue a record the store already holds (with its payload).
  enqueue(record: JobRecord): void {
    if (this.stopping) throw new Error('queue is shutting down');
    this.pending.push(record.id);
    this.pump();
  }

  /// After a restart: re-queue unfinished jobs whose payload is still on disk; fail the rest.
  recover(): { requeued: number; failed: number } {
    let requeued = 0; let failed = 0;
    for (const r of this.opts.store.list()) {
      if (r.status !== 'queued' && r.status !== 'running') continue;
      if (this.opts.store.readPayload(r.id) === undefined) {
        this.fail(r, 'lost', 'the service restarted and the payload of this unfinished job is gone');
        failed++;
        continue;
      }
      r.status = 'queued';
      this.opts.store.update(r);
      this.pending.push(r.id);
      requeued++;
    }
    this.pump();
    return { requeued, failed };
  }

  /// Resolves when nothing is queued or running.
  idle(): Promise<void> {
    if (this.pending.length === 0 && this.running.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /// Stop taking work, abort what runs (those jobs go back to `queued`), wait for it to wind down.
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const { controller } of this.running.values()) controller.abort(new Error('shutdown'));
    await Promise.all([...this.running.values()].map((r) => r.done));
  }

  private pump(): void {
    while (!this.stopping && this.running.size < this.opts.concurrency && this.pending.length > 0) {
      const id = this.pending.shift()!;
      const record = this.opts.store.get(id);
      if (!record) continue;
      const controller = new AbortController();
      const done = this.run(record, controller.signal).finally(() => {
        this.running.delete(id);
        this.pump();
        if (this.pending.length === 0 && this.running.size === 0) for (const w of this.waiters.splice(0)) w();
      });
      this.running.set(id, { controller, done });
    }
  }

  private fail(record: JobRecord, code: string, message: string): void {
    record.status = 'failed';
    record.error = { code, message };
    if (record.payment.status === 'settled') record.payment.status = 'charged-failed';
    this.opts.store.update(record);
    this.opts.store.deletePayload(record.id);
  }

  private async run(record: JobRecord, signal: AbortSignal): Promise<void> {
    const payload = this.opts.store.readPayload(record.id);
    if (payload === undefined) { this.fail(record, 'lost', 'the payload of this job is gone'); return; }
    record.status = 'running';
    this.opts.store.update(record);
    const dir = mkdtempSync(path.join(this.opts.tmpRoot ?? os.tmpdir(), 'blindseal-prover-host-'));
    chmodSync(dir, 0o700);
    const t0 = Date.now();
    try {
      const payloadPath = path.join(dir, 'payload.json');
      writeFileSync(payloadPath, payload, { mode: 0o600, flag: 'wx' });
      chmodSync(payloadPath, 0o600);
      const job: ProofJob = {
        id: record.id, payloadPath, out: path.join(dir, 'attestation.json'),
        action: record.action, expirySlot: record.expirySlot, decisionId: record.decisionId, nonce: record.nonce,
      };
      this.log(`job ${record.id}: proving on ${this.opts.backend.name}`);
      const attestation = await this.opts.backend.prove(job, signal);
      this.opts.store.writeAttestation(record.id, attestation);
      record.status = 'done';
      record.proveMs = Date.now() - t0;
      delete record.error;
      this.opts.store.update(record);
      this.opts.store.deletePayload(record.id);
      this.log(`job ${record.id}: done in ${record.proveMs} ms`);
    } catch (e) {
      if (signal.aborted) {
        // Shutdown, not failure: the payload stays and recover() queues the job again.
        record.status = 'queued';
        this.opts.store.update(record);
        this.log(`job ${record.id}: interrupted, queued again`);
      } else {
        const err = e as Error & { name?: string };
        this.fail(record, err.name && err.name !== 'Error' ? err.name : 'backend', err.message);
        this.log(`job ${record.id}: failed (${record.error!.code}): ${record.error!.message}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
