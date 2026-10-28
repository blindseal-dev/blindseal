/// Spawns the stdio proxy (src/index.ts via tsx) in front of a fixture MCP server and gives
/// tests a line-oriented JSON-RPC handle plus captured stderr and exit status.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = path.resolve(__dirname, '..', '..');
export const PROXY_ENTRY = path.join(PKG_ROOT, 'src/index.ts');

export interface RpcMessage {
  jsonrpc: '2.0';
  id: number | string;
  result?: any;
  error?: any;
}

export interface Harness {
  child: ChildProcessWithoutNullStreams;
  stderr: () => string;
  send(msg: unknown): void;
  next(timeoutMs?: number): Promise<RpcMessage>;
  /// Resolves with the exit code, or null if the process is still running after timeoutMs.
  exited(timeoutMs: number): Promise<number | null>;
  close(): void;
}

export function spawnProxy(opts: {
  fixture: string;
  proxyArgs?: string[];
  env?: Record<string, string | undefined>;
}): Harness {
  const env: NodeJS.ProcessEnv = { ...process.env, BLINDSEAL_MANIFEST_CHECK: 'off' };
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', PROXY_ENTRY, ...(opts.proxyArgs ?? []), '--', process.execPath, opts.fixture],
    { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: PKG_ROOT },
  ) as ChildProcessWithoutNullStreams;

  let err = '';
  child.stderr.on('data', (b) => { err += b.toString(); });
  let exitCode: number | null = null;
  let hasExited = false;
  const exitWaiters: Array<(c: number | null) => void> = [];
  child.on('exit', (code, signal) => {
    hasExited = true;
    exitCode = code ?? (signal ? 128 : null);
    for (const w of exitWaiters.splice(0)) w(exitCode);
  });
  child.stdin.on('error', () => { /* proxy may exit before reading stdin */ });

  const queue: RpcMessage[] = [];
  const waiters: Array<(m: RpcMessage) => void> = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    let m: RpcMessage;
    try { m = JSON.parse(line) as RpcMessage; } catch { return; }
    const w = waiters.shift();
    if (w) w(m); else queue.push(m);
  });

  return {
    child,
    stderr: () => err,
    send(msg) { child.stdin.write(JSON.stringify(msg) + '\n'); },
    next(timeoutMs = 20000) {
      return new Promise((resolve, reject) => {
        const q = queue.shift();
        if (q) return resolve(q);
        const t = setTimeout(() => reject(new Error(`no response within ${timeoutMs}ms; stderr:\n${err}`)), timeoutMs);
        waiters.push((m) => { clearTimeout(t); resolve(m); });
      });
    },
    exited(timeoutMs) {
      return new Promise((resolve) => {
        if (hasExited) return resolve(exitCode);
        const t = setTimeout(() => resolve(null), timeoutMs);
        exitWaiters.push((c) => { clearTimeout(t); resolve(c); });
      });
    },
    close() { if (!hasExited) child.kill('SIGKILL'); },
  };
}
