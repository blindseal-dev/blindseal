/// Job state on disk, so a restart loses nothing finished:
///   <dataDir>/jobs/<id>.json          the record (status, action, payment, error) — never the payload
///   <dataDir>/payloads/<id>.json      the payload of a job that is not finished yet (0600), removed when it is
///   <dataDir>/attestations/<id>.json  the attestation of a finished job
/// Writes go through a temp file and rename, so a crash leaves either the old file or the new one.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BackendName, ProofAction } from '../backends/types.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

/// 'not-billed': price 0. 'settled': the USDC moved before the job was queued. 'charged-failed': settled,
/// then the proof failed — the payer (recorded) is owed a refund by hand; nothing here can move funds.
export type PaymentStatus = 'not-billed' | 'settled' | 'charged-failed';

export interface JobPayment {
  status: PaymentStatus;
  network?: string;
  asset?: string;
  amount?: string;
  payer?: string;
  transaction?: string;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  backend: BackendName;
  payloadHash: string;
  action: ProofAction;
  expirySlot: string;
  decisionId: string;
  nonce?: string;
  payment: JobPayment;
  error?: { code: string; message: string };
  proveMs?: number;
}

const ID_RE = /^j_[0-9a-f]{16}$/;
export function isJobId(s: string): boolean { return ID_RE.test(s); }

function writePrivate(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export class JobStore {
  private constructor(readonly dir: string) {}

  static open(dir: string): JobStore {
    for (const sub of ['', 'jobs', 'payloads', 'attestations']) {
      const d = path.join(dir, sub);
      mkdirSync(d, { recursive: true, mode: 0o700 });
      chmodSync(d, 0o700);
    }
    return new JobStore(dir);
  }

  private file(kind: 'jobs' | 'payloads' | 'attestations', id: string): string {
    if (!isJobId(id)) throw new Error(`bad job id ${JSON.stringify(id)}`);
    return path.join(this.dir, kind, `${id}.json`);
  }

  create(record: JobRecord, payload: string): void {
    if (existsSync(this.file('jobs', record.id))) throw new Error(`job ${record.id} exists`);
    writePrivate(this.file('payloads', record.id), payload);
    writePrivate(this.file('jobs', record.id), JSON.stringify(record, null, 2) + '\n');
  }

  update(record: JobRecord): void {
    record.updatedAt = new Date().toISOString();
    writePrivate(this.file('jobs', record.id), JSON.stringify(record, null, 2) + '\n');
  }

  get(id: string): JobRecord | undefined {
    if (!isJobId(id)) return undefined;
    try { return JSON.parse(readFileSync(this.file('jobs', id), 'utf8')) as JobRecord; } catch { return undefined; }
  }

  /// Every record, oldest first.
  list(): JobRecord[] {
    const out: JobRecord[] = [];
    for (const f of readdirSync(path.join(this.dir, 'jobs'))) {
      if (!f.endsWith('.json')) continue;
      const r = this.get(f.slice(0, -5));
      if (r) out.push(r);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  readPayload(id: string): string | undefined {
    try { return readFileSync(this.file('payloads', id), 'utf8'); } catch { return undefined; }
  }

  deletePayload(id: string): void {
    rmSync(this.file('payloads', id), { force: true });
  }

  writeAttestation(id: string, attestation: unknown): void {
    writePrivate(this.file('attestations', id), JSON.stringify(attestation, null, 2) + '\n');
  }

  readAttestation(id: string): unknown | undefined {
    try { return JSON.parse(readFileSync(this.file('attestations', id), 'utf8')) as unknown; } catch { return undefined; }
  }
}
