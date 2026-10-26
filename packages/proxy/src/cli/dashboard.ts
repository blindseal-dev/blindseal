/// `blindseal dashboard` — open the local dashboard. If a proxy is already listening on the
/// local API port, print its URL (with the shared token in the fragment) and open the browser;
/// otherwise start `blindseal run --mock` first and open that.
import { spawn } from 'node:child_process';
import { dashboardTokenPath, resolveDashboardToken } from '../paths.js';
import { runRun } from './run.js';

const HELP = `blindseal dashboard — open the local dashboard in your browser

Usage:
  blindseal dashboard [flags]

Flags
  --port <n>          local API port (default 7777)
  --host <addr>       local API host (default 127.0.0.1)
  --no-open           print the URL only, do not launch a browser
  --help, -h          this help

If nothing is listening, \`blindseal run --mock\` is started for you (Ctrl-C to stop it).
The URL carries the token from ${'~/.blindseal/dashboard.token'} in its fragment; it never leaves this machine.
`;

export interface DashboardOptions { port: number; host: string; open: boolean; help?: boolean }

export function parseDashboardArgs(argv: string[]): DashboardOptions {
  const out: DashboardOptions = { port: 7777, host: '127.0.0.1', open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--port') out.port = Number.parseInt(argv[++i] ?? '', 10);
    else if (a === '--host') out.host = argv[++i] ?? out.host;
    else if (a === '--no-open') out.open = false;
    else if (a && a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
  }
  if (!Number.isFinite(out.port) || out.port <= 0) throw new Error('--port must be a positive integer');
  return out;
}

export function dashboardUrl(host: string, port: number, token: string): string {
  return `http://${host}:${port}/#token=${token}`;
}

/// True if anything answers HTTP on the local API (a 401 without a token still counts).
export async function isListening(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    await fetch(`http://${host}:${port}/api/status`, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/// Best-effort `open` / `xdg-open` / `start`; never throws, never blocks.
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] :
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] :
    ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no browser opener on this machine; the URL was printed */ });
    child.unref();
  } catch { /* ignore */ }
}

export async function runDashboardCli(argv: string[]): Promise<number> {
  let o: DashboardOptions;
  try { o = parseDashboardArgs(argv); } catch (e) {
    process.stderr.write(`blindseal dashboard: ${(e as Error).message}\n${HELP}`);
    return 2;
  }
  if (o.help) { process.stdout.write(HELP); return 0; }

  const token = resolveDashboardToken();
  const url = dashboardUrl(o.host, o.port, token);

  if (await isListening(o.host, o.port)) {
    process.stdout.write(`blindseal dashboard: ${url}\n  (token from ${dashboardTokenPath()})\n`);
    if (o.open) openBrowser(url);
    return 0;
  }

  process.stdout.write(`blindseal dashboard: nothing listening on ${o.host}:${o.port} — starting \`blindseal run --mock\`\n`);
  const running = runRun(['--mock', '--port', String(o.port), '--host', o.host]);
  // wait (briefly) for the server, then open
  for (let i = 0; i < 20; i++) {
    if (await isListening(o.host, o.port, 500)) {
      process.stdout.write(`blindseal dashboard: ${url}\n`);
      if (o.open) openBrowser(url);
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return running;
}
