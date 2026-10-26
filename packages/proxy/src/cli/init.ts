/// `blindseal init` — scaffold ~/.blindseal so every other command has what it needs:
///   identity.key     the proxy's ed25519 identity (signs audit disclosures)
///   policy.json      the committed default policy (the 22 L1 rules the detector ships)
///   dashboard.token  the bearer token `blindseal run` and the dashboard share
/// Idempotent: existing files are kept, never rewritten.
///
/// `blindseal init --wrap` / `--unwrap` is the MCP-config wrapper (see wrap.ts).
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadIdentity } from '@blindseal/audit';
import { blindsealHome, nearestFixturesDir, shippedFixturesDir } from '../paths.js';
import { runWrap } from './wrap.js';

const HELP = `blindseal init — set up ~/.blindseal (identity key, default policy, dashboard token)

Usage:
  blindseal init                       create ~/.blindseal and its defaults (safe to re-run)
  blindseal init --wrap [flags]        wrap the MCP servers in your Claude configs with blindseal
  blindseal init --unwrap              restore those configs from their .blindseal-backup files
  blindseal init --help, -h            this help

--wrap flags: --yes (skip confirmation), --dry-run (preview only), --config <path> (one file)

Next steps after init:
  blindseal run --mock                 local API + dashboard over sample data
  blindseal -- <server command>        wrap a stdio MCP server
`;

export interface InitReport {
  home: string;
  created: string[];
  kept: string[];
  pubkeyHex: string;
  policySource?: string;
}

/// Scaffold ~/.blindseal (or `home`). Returns what was created vs. already present.
export function scaffoldHome(home: string = blindsealHome()): InitReport {
  const created: string[] = [];
  const kept: string[] = [];

  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    created.push(home + path.sep);
  } else {
    kept.push(home + path.sep);
  }
  try {
    if ((statSync(home).mode & 0o777) !== 0o700) chmodSync(home, 0o700);
  } catch { /* best effort */ }

  const keyPath = path.join(home, 'identity.key');
  const hadKey = existsSync(keyPath);
  const { pubkeyHex } = loadIdentity(keyPath); // generates at 0600 when absent
  (hadKey ? kept : created).push(keyPath);

  const policyPath = path.join(home, 'policy.json');
  let policySource: string | undefined;
  if (existsSync(policyPath)) {
    kept.push(policyPath);
  } else {
    const fixtures = shippedFixturesDir() ?? nearestFixturesDir();
    const src = fixtures ? path.join(fixtures, 'policy.json') : undefined;
    if (src && existsSync(src)) {
      copyFileSync(src, policyPath);
      chmodSync(policyPath, 0o600);
      policySource = src;
      created.push(policyPath);
    }
  }

  const tokenPath = path.join(home, 'dashboard.token');
  if (existsSync(tokenPath)) {
    kept.push(tokenPath);
  } else {
    writeFileSync(tokenPath, randomBytes(24).toString('base64url') + '\n', { mode: 0o600 });
    created.push(tokenPath);
  }

  return { home, created, kept, pubkeyHex, policySource };
}

export async function runInit(argv: string[]): Promise<number> {
  if (argv.some((a) => a === '--wrap' || a === '--unwrap' || a === 'wrap' || a === 'unwrap')) {
    return runWrap(argv);
  }
  for (const a of argv) {
    if (a === '--help' || a === '-h') { process.stdout.write(HELP); return 0; }
    process.stderr.write(`blindseal init: unknown argument "${a}"\n${HELP}`);
    return 2;
  }

  let report: InitReport;
  try {
    report = scaffoldHome();
  } catch (e) {
    process.stderr.write(`blindseal init: ${(e as Error).message}\n`);
    return 1;
  }

  const lines: string[] = [`blindseal init: ${report.home}`];
  for (const f of report.created) lines.push(`  created  ${f}`);
  for (const f of report.kept) lines.push(`  kept     ${f}`);
  lines.push(`  identity ${report.pubkeyHex.slice(0, 16)}… (ed25519, signs audit disclosures)`);
  if (!report.created.includes(path.join(report.home, 'policy.json')) && !report.kept.includes(path.join(report.home, 'policy.json'))) {
    lines.push('  warning  default policy not written: fixtures/policy.json not found in this install');
  }
  lines.push('');
  lines.push('Next:');
  lines.push('  blindseal run --mock             local API + dashboard over sample data');
  lines.push('  blindseal -- <server command>    wrap a stdio MCP server (e.g. blindseal -- npx -y @modelcontextprotocol/server-filesystem /tmp)');
  lines.push('  blindseal init --wrap            rewrite your Claude MCP configs to go through blindseal');
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
