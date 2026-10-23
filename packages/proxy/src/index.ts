import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProxy } from './transports/stdio.js';
import { startHttpProxy } from './transports/http.js';
import { startScanHttp } from './transports/scan-http.js';
import { runDemo } from './cli/demo.js';
import { runHistoryCli } from './cli/history.js';
import { runDashboardCli } from './cli/dashboard.js';
import { runRun } from './cli/run.js';

function readVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // dist/index.js → ../package.json; src/index.ts → ../../package.json
    for (const rel of ['../package.json', '../../package.json']) {
      const p = path.resolve(here, rel);
      try {
        const pkg = JSON.parse(readFileSync(p, 'utf8'));
        if (pkg.name && pkg.version) return String(pkg.version);
      } catch {
        /* keep trying */
      }
    }
  } catch {
    /* ignore */
  }
  return '0.0.0';
}

const HELP = `blindseal — scans MCP tool responses for prompt injection

Usage
  npx @blindseal/proxy demo                                         # interactive demo (30s first-run experience)
  BLINDSEAL_MOCK=1 blindseal run --mock                                 # local API + WS over fixtures (FRONTEND.md §5)
  npx @blindseal/proxy -- <command> [args...]                      # stdio (wrap a local MCP server)
  npx @blindseal/proxy --transport http --upstream <url> [--port]  # http (proxy a remote MCP server)
  npx @blindseal/proxy history [flags]                              # show local scan history (requires BLINDSEAL_PERSIST=1)
  npx @blindseal/proxy dashboard [flags]                            # localhost dashboard for scan history

Examples
  npx @blindseal/proxy -- npx -y @modelcontextprotocol/server-filesystem /tmp
  npx @blindseal/proxy --transport http --upstream https://mcp.example.com/v1 --port 8800

Flags
  --transport <stdio|http|scan-http>  default: stdio
  --upstream <url>                    required when --transport http
  --port, --listen-port <n>           default: 8800 (http) / 9787 (scan-http)
  --host <addr>                       default: 127.0.0.1
  --server-url <url>                  logical server identifier for scan-http (default: scan-http:blindseal)
  --version, -v              print version
  --help, -h                 this help

Detection (env)
  BLINDSEAL_MODE                 block (default) | warn | log
  BLINDSEAL_LAYER2_THRESHOLD     cosine distance cutoff for L2 (default 0.35)
  BLINDSEAL_LAYER3_PROVIDER      anthropic | openai | ollama | custom  (default: auto-detect from key)
  BLINDSEAL_LAYER3_MODEL         model id override
  BLINDSEAL_LAYER3_BASE_URL      base URL override (ollama or custom endpoint)
  BLINDSEAL_LAYER3_TIMEOUT_MS    judge call hard timeout (default 15000)
  BLINDSEAL_L3_FP_SAFE           1 = demote suspicious→clean when L3 unavailable (old behaviour)
  ANTHROPIC_API_KEY          BYO key for Layer 3 (Anthropic)  ← strongly recommended
  OPENAI_API_KEY             BYO key for Layer 3 (OpenAI / compat)
  OLLAMA_HOST                Ollama base URL (default: http://localhost:11434); set to enable offline L3

Capability firewall (env, default off)
  BLINDSEAL_CAPABILITY                 1 to enable taint-tracking + gate
  BLINDSEAL_CAPABILITY_MODE            block (default) | warn
  BLINDSEAL_TAINT_MIN_OVERLAP          chars of overlap to gate (default 32)
  BLINDSEAL_TAINT_WINDOW_SIZE          recent responses tracked (default 10)
  BLINDSEAL_SENSITIVE_TOOL_PATTERNS    comma-separated regexes added to defaults

Manifest verification (env)
  BLINDSEAL_MANIFEST_CHECK             on (default) | off | strict
  BLINDSEAL_MANIFEST_CACHE_DIR         override \$XDG_CACHE_HOME/blindseal/manifests

Telemetry (env, default on when URL configured)
  BLINDSEAL_TELEMETRY                  0 to disable
  BLINDSEAL_TELEMETRY_URL              collector ingest URL
  BLINDSEAL_TELEMETRY_SECRET           optional Bearer token
  BLINDSEAL_TELEMETRY_BATCH            batch size (default 100)
  BLINDSEAL_TELEMETRY_FLUSH_MS         flush interval (default 5000)
  BLINDSEAL_TELEMETRY_INSTALL_ID       stable install id (hashed before send)

Audit log (env, default off)
  BLINDSEAL_AUDIT_LOG                  path to append-only JSONL of every decision

Local scan history (env, default off — opt in for visibility)
  BLINDSEAL_PERSIST                    1 to record every scan to ~/.blindseal/scans.db
  BLINDSEAL_PERSIST_PATH               override DB path (default ~/.blindseal/scans.db)
  BLINDSEAL_RETENTION_DAYS             rolling retention (default 30, purged on open)

On-chain attestation (env, default off)
  BLINDSEAL_ATTEST                     1 to enable EAS attestations on Base
  BLINDSEAL_BASE_RPC_URL               default: https://mainnet.base.org
  BLINDSEAL_ATTESTER_PRIVATE_KEY       hot wallet (fund with ~0.05 ETH on Base)
Privacy: see PRIVACY.md. SHA-256 hashes only — raw content never leaves the proxy.
`;

interface ParsedArgs {
  transport: 'stdio' | 'http' | 'scan-http';
  upstream?: string;
  port?: number;
  host?: string;
  serverUrl?: string;
  stdioTarget?: { cmd: string; args: string[] };
  showHelp: boolean;
  noArgs: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) return { transport: 'stdio', showHelp: true, noArgs: true };
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stdout.write(`@blindseal/proxy ${readVersion()}\n`);
    process.exit(0);
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    return { transport: 'stdio', showHelp: true, noArgs: false };
  }

  const sepIdx = argv.indexOf('--');
  const flagArgs = sepIdx >= 0 ? argv.slice(0, sepIdx) : argv;
  const afterSep = sepIdx >= 0 ? argv.slice(sepIdx + 1) : [];

  let transport: 'stdio' | 'http' | 'scan-http' = 'stdio';
  let upstream: string | undefined;
  let port: number | undefined;
  let host: string | undefined;
  let serverUrl: string | undefined;

  for (let i = 0; i < flagArgs.length; i++) {
    const a = flagArgs[i];
    if (a === '--transport') {
      const v = flagArgs[++i];
      if (v === 'http') transport = 'http';
      else if (v === 'stdio') transport = 'stdio';
      else if (v === 'scan-http') transport = 'scan-http';
      else throw new Error(`unknown transport: ${v}`);
    } else if (a === '--upstream') {
      upstream = flagArgs[++i];
    } else if (a === '--port' || a === '--listen-port') {
      const v = flagArgs[++i];
      port = v ? Number.parseInt(v, 10) : undefined;
    } else if (a === '--host') {
      host = flagArgs[++i];
    } else if (a === '--server-url') {
      serverUrl = flagArgs[++i];
    } else if (a && a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    }
  }

  if (transport === 'http') {
    if (!upstream) throw new Error('--transport http requires --upstream <url>');
    return { transport, upstream, port: port ?? 8800, host: host ?? '127.0.0.1', showHelp: false, noArgs: false };
  }

  if (transport === 'scan-http') {
    return {
      transport,
      port: port ?? 9787,
      host: host ?? '127.0.0.1',
      serverUrl,
      showHelp: false,
      noArgs: false,
    };
  }

  // stdio
  const target = sepIdx >= 0 ? afterSep : flagArgs;
  const cmd = target[0];
  const args = target.slice(1);
  if (!cmd) throw new Error('no target command (use `--` to separate args)');
  return { transport: 'stdio', stdioTarget: { cmd, args }, showHelp: false, noArgs: false };
}

function main(): void {
  const argv = process.argv.slice(2);

  // demo subcommand — handle before generic flag parsing
  if (argv[0] === 'demo') {
    runDemo().then(() => process.exit(0)).catch((err) => {
      process.stderr.write(`blindseal demo: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
    return;
  }

  if (argv[0] === 'run') {
    runRun(argv.slice(1)).then((code) => { if (code !== 0) process.exit(code); }).catch((err) => {
      process.stderr.write(`blindseal run: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
    return; // mock server keeps the process alive
  }

  if (argv[0] === 'attest') {
    import('./cli/attest.js')
      .then(({ runAttestCli }) => runAttestCli(argv.slice(1)))
      .then((code) => process.exit(code))
      .catch((err) => {
        process.stderr.write(`blindseal attest: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      });
    return;
  }

  if (argv[0] === 'submit') {
    import('./cli/submit.js')
      .then(({ runSubmitCli }) => runSubmitCli(argv.slice(1)))
      .then((code) => process.exit(code))
      .catch((err) => {
        process.stderr.write(`blindseal submit: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      });
    return;
  }

  if (argv[0] === 'audit' || argv[0] === 'verify') {
    const which = argv[0];
    (which === 'audit' ? import('./cli/audit.js').then((m) => m.runAuditCli(argv.slice(1))) : import('./cli/verify.js').then((m) => m.runVerifyCli(argv.slice(1))))
      .then((code) => process.exit(code))
      .catch((err) => {
        process.stderr.write(`blindseal ${which}: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      });
    return;
  }

  if (argv[0] === 'history') {
    process.exit(runHistoryCli(argv.slice(1)));
  }

  if (argv[0] === 'dashboard') {
    const code = runDashboardCli(argv.slice(1));
    if (code !== 0) process.exit(code);
    return; // dashboard keeps server alive
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`blindseal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(HELP);
    process.exit(2);
  }

  if (parsed.showHelp) {
    process.stdout.write(HELP);
    process.exit(parsed.noArgs ? 2 : 0);
  }

  if (parsed.transport === 'http') {
    startHttpProxy({ upstream: parsed.upstream!, listenPort: parsed.port!, listenHost: parsed.host });
    return;
  }

  if (parsed.transport === 'scan-http') {
    startScanHttp({
      listenPort: parsed.port!,
      listenHost: parsed.host,
      defaultServerUrl: parsed.serverUrl,
    });
    return;
  }

  const { cmd, args } = parsed.stdioTarget!;
  startProxy(cmd, args);
}

main();
