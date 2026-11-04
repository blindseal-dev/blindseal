/// A session with the Blindseal proxy (`blindseal -- node <mcp server>`) over stdio: the agent side of
/// the JSON-RPC pipe. Every tools/call goes through the proxy's outbound screen and capability gate, and
/// every reply through its reply screen; this module only recognises the proxy's refusals.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { blindsealCli, mcpServerEntry } from './paths.js';

export interface RpcReply { jsonrpc?: string; id?: number | string | null; result?: any; error?: { code?: number; message?: string; data?: unknown } }

export type Blocked = { tool: string; direction: 'request' | 'response' | 'capability'; notice: string };

/// JSON-RPC error code the proxy uses for a tool call whose arguments were blocked (transports/shared.ts).
export const OUTBOUND_BLOCKED_CODE = -32001;

/// The proxy's refusal, if the reply is one. A blocked request is a JSON-RPC error; a blocked reply or
/// a capability block is a tool result with isError and the fixed notice text.
export function blockedBy(reply: RpcReply, tool: string): Blocked | undefined {
  if (reply.error && reply.error.code === OUTBOUND_BLOCKED_CODE) return { tool, direction: 'request', notice: reply.error.message ?? '' };
  const r = reply.result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | undefined;
  if (r?.isError && Array.isArray(r.content)) {
    const text = r.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
    if (text.includes('[BLINDSEAL_CAPABILITY_BLOCKED]')) return { tool, direction: 'capability', notice: text.slice(0, 400) };
    if (text.includes('[BLINDSEAL_BLOCKED]')) return { tool, direction: 'response', notice: text.slice(0, 400) };
  }
  return undefined;
}

/// The text of a tool result (content[].text joined), parsed as JSON when it is JSON.
export function resultText(reply: RpcReply): { text: string; json?: unknown; isError: boolean } {
  const r = reply.result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | undefined;
  const text = Array.isArray(r?.content) ? r!.content!.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : '';
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { text, json, isError: r?.isError === true };
}

export interface ProxySessionOptions {
  /// Environment for the proxy (and, inherited, the MCP server). Secrets go here, never in arguments.
  env: NodeJS.ProcessEnv;
  allowDegraded?: boolean;
  onStderr?: (line: string) => void;
  /// Test hook: another server command instead of this service's MCP server.
  serverArgs?: string[];
}

export class ProxySession {
  private nextId = 1;
  private readonly waiters = new Map<number, { resolve: (r: RpcReply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stderrText = '';
  private exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  private constructor(readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      let m: RpcReply;
      try { m = JSON.parse(line) as RpcReply; } catch { return; }
      if (typeof m.id !== 'number') return;
      const w = this.waiters.get(m.id);
      if (!w) return;
      this.waiters.delete(m.id);
      clearTimeout(w.timer);
      w.resolve(m);
    });
  }

  static start(opts: ProxySessionOptions): ProxySession {
    const cli = blindsealCli();
    const server = opts.serverArgs ?? mcpServerEntry().args;
    const args = [...cli.args, ...(opts.allowDegraded ? ['--allow-degraded'] : []), '--', process.execPath, ...server];
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env: opts.env }) as ChildProcessWithoutNullStreams;
    const s = new ProxySession(child);
    createInterface({ input: child.stderr }).on('line', (line) => {
      s.stderrText += line + '\n';
      if (s.stderrText.length > 200_000) s.stderrText = s.stderrText.slice(-100_000);
      opts.onStderr?.(line);
    });
    child.stdin.on('error', () => { /* the proxy may be gone */ });
    child.on('exit', (code, signal) => {
      s.exited = { code, signal };
      for (const [id, w] of s.waiters) {
        s.waiters.delete(id);
        clearTimeout(w.timer);
        w.reject(new Error(`proxy exited (code ${code}, signal ${signal}) before answering request ${id}\n${s.stderrTail()}`));
      }
    });
    return s;
  }

  stderr(): string { return this.stderrText; }
  stderrTail(n = 2000): string { return this.stderrText.slice(-n); }
  hasExited(): boolean { return this.exited !== undefined; }

  request(method: string, params: unknown, timeoutMs: number): Promise<RpcReply> {
    const id = this.nextId++;
    return new Promise<RpcReply>((resolve, reject) => {
      if (this.exited) return reject(new Error(`proxy already exited (code ${this.exited.code})\n${this.stderrTail()}`));
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error(`no reply to ${method} within ${timeoutMs} ms\n${this.stderrTail()}`));
      }, timeoutMs);
      this.waiters.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n');
  }

  /// MCP handshake. The first reply also waits for the proxy's startup (layer-2 model load).
  async initialize(timeoutMs = 180_000): Promise<RpcReply> {
    const r = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'blindseal-dogfood', version: '0.0.1' },
    }, timeoutMs);
    this.notify('notifications/initialized');
    return r;
  }

  callTool(name: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<RpcReply> {
    return this.request('tools/call', { name, arguments: args }, timeoutMs);
  }

  /// End the agent side; the proxy forwards EOF to the server and exits with it. Force-kill after a grace period.
  async close(graceMs = 5000): Promise<void> {
    if (this.exited) return;
    try { this.child.stdin.end(); } catch { /* ignore */ }
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, graceMs);
      this.child.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }
}
