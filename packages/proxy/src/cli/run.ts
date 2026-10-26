/// `blindseal run [--mock]` — start the local API + WS and serve the dashboard at /.
/// `--mock` serves the sample fixtures shipped with the package behind the real API contract,
/// with a fake decision stream, so the dashboard can be explored without wrapping a server.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { startMockApi } from '../api/mock-server.js';
import { nearestFixturesDir, packageRoot, shippedDashboardDir, shippedFixturesDir } from '../paths.js';

export interface RunOptions {
  mock: boolean;
  port?: number;
  host?: string;
  fixturesDir?: string;
  dashboard?: string; // built dashboard dir to serve at `/` (application/wasm + CSP)
  help?: boolean;
}

const HELP = `blindseal run — start the local API + WS and serve the dashboard

Usage:
  blindseal run --mock [flags]

Flags
  --mock              serve the bundled sample data with a fake decision stream
  --port <n>          listen port (default 7777)
  --host <addr>       listen host (default 127.0.0.1)
  --fixtures <dir>    sample data directory (default: the fixtures/ shipped in the package,
                      else the nearest fixtures/ above the current directory; $BLINDSEAL_FIXTURES)
  --dashboard <dir>   built dashboard to serve at / (default: the dashboard/ shipped in the
                      package; $BLINDSEAL_DASHBOARD_DIST)
  --help, -h          this help

Then open the dashboard: blindseal dashboard (or the http://127.0.0.1:7777/#token=… URL printed).
`;

export function parseRunArgs(argv: string[]): RunOptions {
  const out: RunOptions = { mock: process.env.BLINDSEAL_MOCK === '1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--mock') out.mock = true;
    else if (a === '--port') out.port = Number.parseInt(argv[++i] ?? '', 10);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--fixtures') out.fixturesDir = argv[++i];
    else if (a === '--dashboard') out.dashboard = argv[++i];
    else if (a && a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

/// --fixtures → $BLINDSEAL_FIXTURES → <package>/fixtures → nearest fixtures/ above cwd.
export function resolveFixturesDir(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.BLINDSEAL_FIXTURES) return process.env.BLINDSEAL_FIXTURES;
  const found = shippedFixturesDir() ?? nearestFixturesDir();
  if (found) return found;
  throw new Error(
    `sample data not found: this install has no ${path.join(packageRoot(), 'fixtures')} and no fixtures/ above ${process.cwd()}; ` +
    'pass --fixtures <dir> or set BLINDSEAL_FIXTURES',
  );
}

/// --dashboard → $BLINDSEAL_DASHBOARD_DIST → <package>/dashboard → (source checkout only)
/// ../dashboard/dist next to this package. Undefined when none is built.
export function resolveDashboardDir(explicit?: string): string | undefined {
  const picked = explicit ?? process.env.BLINDSEAL_DASHBOARD_DIST;
  if (picked) return picked;
  const shipped = shippedDashboardDir();
  if (shipped) return shipped;
  const sibling = path.join(packageRoot(), '..', 'dashboard', 'dist');
  return existsSync(path.join(sibling, 'index.html')) ? sibling : undefined;
}

/// Returns a process exit code. In mock mode it resolves only on shutdown (SIGINT).
export async function runRun(argv: string[]): Promise<number> {
  let opts: RunOptions;
  try {
    opts = parseRunArgs(argv);
  } catch (e) {
    process.stderr.write(`blindseal run: ${(e as Error).message}\n`);
    return 1;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!opts.mock) {
    process.stderr.write(
      'blindseal run: the engine-backed local API is not available in this release.\n' +
      'Use `blindseal run --mock` for the dashboard over sample data, or `blindseal -- <server>` to wrap an MCP server.\n',
    );
    return 1;
  }

  let fixturesDir: string;
  try {
    fixturesDir = resolveFixturesDir(opts.fixturesDir);
  } catch (e) {
    process.stderr.write(`blindseal run: ${(e as Error).message}\n`);
    return 1;
  }
  const dashboardDist = resolveDashboardDir(opts.dashboard);
  if (dashboardDist && !existsSync(path.join(dashboardDist, 'index.html'))) {
    process.stderr.write(`blindseal run: dashboard directory ${dashboardDist} has no index.html\n`);
    return 1;
  }
  const handle = await startMockApi({ port: opts.port, host: opts.host, fixturesDir, dashboardDist });
  const base = handle.url.replace(/\/api$/, '');
  process.stdout.write(
    `blindseal (MOCK): local API on ${handle.url}\n` +
    `  token: ${handle.token}\n` +
    (dashboardDist
      ? `  dashboard: ${base}/#token=${handle.token}  (served from ${dashboardDist})\n`
      : `  dashboard: NOT SERVED — this install has no ${path.join(packageRoot(), 'dashboard')}; pass --dashboard <dir> or set BLINDSEAL_DASHBOARD_DIST\n`) +
    `  sample data: ${fixturesDir}\n` +
    `  WS: ${base.replace(/^http/, 'ws')}/api/events?token=${handle.token}\n` +
    'Ctrl-C to stop.\n',
  );
  return new Promise<number>((resolve) => {
    const shutdown = () => {
      void handle.close().then(() => resolve(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}
