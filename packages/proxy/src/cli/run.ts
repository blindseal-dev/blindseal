/// `blindseal run [--mock]` — start the local API + WS (FRONTEND.md §5).
/// M0 ships the MOCK path only: `BLINDSEAL_MOCK=1 blindseal run` (or `run --mock`)
/// serves fixtures/ so the dashboard/site can be built before the engine exists.
/// The real (engine-backed) API lands in M1.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { startMockApi } from '../api/mock-server.js';

export interface RunOptions {
  mock: boolean;
  port?: number;
  host?: string;
  fixturesDir?: string;
  help?: boolean;
}

const HELP = `blindseal run — start the local API + WS (FRONTEND.md §5)

Usage:
  BLINDSEAL_MOCK=1 blindseal run [--mock] [flags]

Flags
  --mock              serve fixtures/ with a fake event stream (M0)
  --port <n>          listen port (default 7777)
  --host <addr>       listen host (default 127.0.0.1)
  --fixtures <dir>    fixtures directory (default: nearest fixtures/)
  --help, -h          this help

M0 supports --mock only. The engine-backed API lands in M1.
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
    else if (a && a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

function resolveFixturesDir(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.BLINDSEAL_FIXTURES) return process.env.BLINDSEAL_FIXTURES;
  let dir = process.cwd();
  for (let i = 0; i < 7; i++) {
    const candidate = path.join(dir, 'fixtures');
    if (existsSync(path.join(candidate, 'decisions.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('fixtures/ not found; pass --fixtures <dir> or set BLINDSEAL_FIXTURES');
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
      'blindseal run: the engine-backed API is not built yet (M1).\n' +
      'For now: BLINDSEAL_MOCK=1 blindseal run --mock\n',
    );
    return 1;
  }

  const fixturesDir = resolveFixturesDir(opts.fixturesDir);
  const handle = await startMockApi({ port: opts.port, host: opts.host, fixturesDir });
  process.stdout.write(
    `blindseal (MOCK): local API on ${handle.url}\n` +
    `  token: ${handle.token}\n` +
    `  dashboard: open with #token=${handle.token}\n` +
    `  fixtures: ${fixturesDir}\n` +
    `  WS: ${handle.url.replace(/^http/, 'ws')}/events?token=${handle.token}\n` +
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
