/// A small pool of worker threads that answers requests in order of arrival, one request per
/// worker at a time. Used for the scan workers (scan-pool.ts: Layer 0/1, redaction, blob decoding)
/// and for the Layer 2 worker (layer2-pool.ts: the embedding model), so neither ever runs on the
/// event loop.
///
/// A worker signals `{ ready: true }` once its modules are loaded; tasks are only dispatched to
/// ready workers, so start-up never counts against a task's deadline. A task still running past
/// its deadline gets an OverrunError and its worker is replaced. If no worker can start at all,
/// requests run inline through `fallback` and stderr says so once ("<name> worker unavailable").

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export class OverrunError extends Error {
  constructor() {
    super('worker overran its time allowance');
  }
}

interface Task<Req, Res> {
  req: Req;
  timeoutMs: number;
  resolve: (r: Res) => void;
  reject: (e: Error) => void;
}

type Reply<Res> = { ready: true } | ({ ok: true } & Res) | { ok: false; error: string };

/// The worker script beside this module: dist/<entry>.js in the published bundle, or the
/// TypeScript source loaded through tsx when running from source (tests, `pnpm dev`).
function workerEntry(entry: string): { url: URL; execArgv: string[] } {
  const here = import.meta.url;
  if (here.endsWith('.ts')) {
    const tsx = pathToFileURL(createRequire(here).resolve('tsx')).href.replace(/\/dist\/[^/]+$/, '/dist/loader.mjs');
    return { url: new URL(`./${entry}.ts`, here), execArgv: ['--import', tsx] };
  }
  return { url: new URL(`./${entry}.js`, here), execArgv: [] };
}

class Slot<Req, Res> {
  worker: Worker;
  task: Task<Req, Res> | null = null;
  timer: NodeJS.Timeout | null = null;
  ready = false;

  constructor(private readonly pool: WorkerPool<Req, Res>) {
    this.worker = this.spawn();
  }

  private spawn(): Worker {
    const { url, execArgv } = workerEntry(this.pool.entry);
    const w = new Worker(url, { execArgv });
    this.ready = false;
    w.unref();
    // Events from a worker this slot has already replaced are ignored: they must not touch the
    // task now running on its successor.
    const current = () => w === this.worker;
    w.on('message', (reply: Reply<Res>) => {
      if (!current()) return;
      if ('ready' in reply) {
        this.ready = true;
        this.pool.started = true;
        this.pool.next(this);
        return;
      }
      const task = this.finish();
      if (task) {
        if (reply.ok) task.resolve(reply as unknown as Res);
        else task.reject(new Error(`${this.pool.name} worker: ${reply.error}`));
      }
      this.pool.next(this);
    });
    w.on('error', (err) => { if (current()) this.crashed(err); });
    w.on('exit', (code) => { if (current() && code !== 0) this.crashed(new Error(`${this.pool.name} worker exited with code ${code}`)); });
    return w;
  }

  private finish(): Task<Req, Res> | null {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const t = this.task;
    this.task = null;
    return t;
  }

  run(task: Task<Req, Res>): void {
    this.task = task;
    if (Number.isFinite(task.timeoutMs)) {
      this.timer = setTimeout(() => this.replace(new OverrunError()), task.timeoutMs);
      this.timer.unref();
    }
    this.worker.postMessage(task.req);
  }

  private replace(err: Error): void {
    const task = this.finish();
    const old = this.worker;
    this.worker = this.spawn();
    void old.terminate();
    task?.reject(err);
  }

  private crashed(err: Error): void {
    if (!this.pool.started) {
      this.finish();
      this.pool.fallBackInline(err, this.task);
      return;
    }
    this.replace(err);
  }

  terminate(): void {
    void this.worker.terminate();
  }
}

export class WorkerPool<Req, Res> {
  private slots: Slot<Req, Res>[] = [];
  private queue: Task<Req, Res>[] = [];
  inline = false;
  /// Set once any worker has started: a later crash is a crash, not a missing worker.
  started = false;

  constructor(
    readonly name: string,
    readonly entry: string,
    private readonly size: () => number,
    private readonly fallback: (req: Req) => Res | Promise<Res>,
  ) {}

  private ensure(): void {
    if (this.inline || this.slots.length > 0) return;
    try {
      for (let i = 0, n = this.size(); i < n; i++) this.slots.push(new Slot(this));
    } catch (err) {
      this.fallBackInline(err as Error, null);
    }
  }

  fallBackInline(err: Error, task: Task<Req, Res> | null): void {
    if (!this.inline) {
      this.inline = true;
      process.stderr.write(`blindseal: ${this.name} worker unavailable (${err.message}); running on the main thread\n`);
      for (const s of this.slots) s.terminate();
      this.slots = [];
    }
    const pending = [...(task ? [task] : []), ...this.queue];
    this.queue = [];
    for (const t of pending) this.runInline(t);
  }

  private runInline(t: Task<Req, Res>): void {
    Promise.resolve()
      .then(() => this.fallback(t.req))
      .then(t.resolve, (e: unknown) => t.reject(e instanceof Error ? e : new Error(String(e))));
  }

  submit(req: Req, timeoutMs: number): Promise<Res> {
    this.ensure();
    return new Promise((resolve, reject) => {
      const task: Task<Req, Res> = { req, timeoutMs, resolve, reject };
      if (this.inline) return this.runInline(task);
      const idle = this.slots.find((s) => s.ready && !s.task);
      if (idle) idle.run(task);
      else this.queue.push(task);
    });
  }

  next(slot: Slot<Req, Res>): void {
    if (slot.task || !slot.ready) return;
    const t = this.queue.shift();
    if (t) slot.run(t);
  }
}
