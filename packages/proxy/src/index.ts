import { startProxy } from './transports/stdio.js';
import { startHttpProxy } from './transports/http.js';
import { startScanHttp } from './transports/scan-http.js';
import { runDemo } from './cli/demo.js';
import { runHistoryCli } from './cli/history.js';
import { packageVersion } from './paths.js';

const HELP = `blindseal — a local MCP proxy that screens every tool call, keeps a hash-chained audit
log, and produces zero-knowledge attestations verifiable on Solana.

Usage
  blindseal init                                    set up ~/.blindseal (identity key, default policy, dashboard token)
  blindseal init --wrap [--yes --dry-run --config <path>]
                                                    route the MCP servers in your Claude configs through blindseal
  blindseal init --unwrap                           restore those configs from their backups
  blindseal run --mock                              local API + dashboard over bundled sample data
  blindseal dashboard                               open the dashboard (starts run --mock if nothing is listening)
  blindseal -- <command> [args...]                  wrap a stdio MCP server
  blindseal --transport http --upstream <url>       proxy a remote MCP server over HTTP
  blindseal --transport scan-http [--port <n>]      stand-alone POST /scan endpoint
  blindseal attest <toolcall.json> --target-program <id> [--out <file>] [--expiry <slot> | --no-expiry]
  blindseal submit <attestation.json>               verify on Solana mainnet and consume the nullifier
  blindseal verify <attestation.json | disclosure.json>
  blindseal audit verify | disclose --from <i> --to <j>
  blindseal history [flags]                         local scan history (needs BLINDSEAL_PERSIST=1)
  blindseal demo                                    interactive detection demo
  blindseal <command> --help                        help for any command

Examples
  blindseal -- npx -y @modelcontextprotocol/server-filesystem /tmp
  blindseal --transport http --upstream https://mcp.example.com/v1 --port 8800

Proxy flags
  --transport <stdio|http|scan-http>  default: stdio (requires \`-- <command>\`)
  --upstream <url>                    required when --transport http
  --port, --listen-port <n>           default: 8800 (http) / 9787 (scan-http)
  --host <addr>                       default: 127.0.0.1
  --server-url <url>                  logical server identifier for scan-http (default: scan-http:blindseal)
  --version, -v                       print version
  --help, -h                          this help

Detection (env)
  BLINDSEAL_MODE                 block (default) | warn | log
  BLINDSEAL_LAYER2_THRESHOLD     cosine distance cutoff for L2 (default 0.35)
  BLINDSEAL_LAYER3_PROVIDER      anthropic | openai | ollama | custom  (default: auto-detect from key)
  BLINDSEAL_LAYER3_MODEL         model id override
  BLINDSEAL_LAYER3_BASE_URL      base URL override (ollama or custom endpoint)
  BLINDSEAL_LAYER3_TIMEOUT_MS    judge call hard timeout (default 15000)
  BLINDSEAL_L3_FP_SAFE           1 = demote suspicious→clean when L3 unavailable
  ANTHROPIC_API_KEY              BYO key for Layer 3 (Anthropic)  ← strongly recommended
  OPENAI_API_KEY                 BYO key for Layer 3 (OpenAI / compat)
  OLLAMA_HOST                    Ollama base URL (default: http://localhost:11434); set to enable offline L3

Capability firewall (env, default off)
  BLINDSEAL_CAPABILITY                 1 to enable taint-tracking + gate
  BLINDSEAL_CAPABILITY_MODE            block (default) | warn
  BLINDSEAL_TAINT_MIN_OVERLAP          chars of overlap to gate (default 32)
  BLINDSEAL_TAINT_WINDOW_SIZE          recent responses tracked (default 10)
  BLINDSEAL_SENSITIVE_TOOL_PATTERNS    comma-separated regexes added to defaults

Manifest verification (env)
  BLINDSEAL_MANIFEST_CHECK             on (default) | off | strict
  BLINDSEAL_MANIFEST_CACHE_DIR         override \$XDG_CACHE_HOME/blindseal/manifests

Audit log (env, default off)
  BLINDSEAL_AUDIT_LOG                  path to append-only JSONL of every decision

Local scan history (env, default off)
  BLINDSEAL_PERSIST                    1 to record every scan to ~/.blindseal/scans.db
  BLINDSEAL_PERSIST_PATH               override DB path (default ~/.blindseal/scans.db)
  BLINDSEAL_RETENTION_DAYS             rolling retention (default 30, purged on open)

Chain + prover (env)
  BLINDSEAL_RPC_URL                    Solana RPC (default: the public mainnet endpoint)
  BLINDSEAL_PROVER                     path to a prover binary (otherwise ~/.blindseal/bin or a release download)
  BLINDSEAL_DASHBOARD_DIST             override the dashboard directory served by \`blindseal run\`
  BLINDSEAL_FIXTURES                   override the sample data directory for \`run --mock\`

Nothing leaves this machine except the RPC calls you ask for (attest/submit/verify on chain).
`;

const SUBCOMMANDS = new Set(['init', 'run', 'dashboard', 'demo', 'attest', 'submit', 'verify', 'audit', 'history']);
const PROXY_FLAGS = new Set(['--', '--transport', '--upstream', '--port', '--listen-port', '--host', '--server-url']);

interface ParsedArgs {
  transport: 'stdio' | 'http' | 'scan-http';
  upstream?: string;
  port?: number;
  host?: string;
  serverUrl?: string;
  stdioTarget?: { cmd: string; args: string[] };
}

export function parseArgs(argv: string[]): ParsedArgs {
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
    } else if (a) {
      throw new Error(`unexpected argument "${a}" — to wrap an MCP server use: blindseal -- ${a} ...`);
    }
  }

  if (transport === 'http') {
    if (!upstream) throw new Error('--transport http requires --upstream <url>');
    return { transport, upstream, port: port ?? 8800, host: host ?? '127.0.0.1' };
  }

  if (transport === 'scan-http') {
    return { transport, port: port ?? 9787, host: host ?? '127.0.0.1', serverUrl };
  }

  // stdio: the target command must come after `--`
  if (sepIdx < 0) throw new Error('wrapping an MCP server requires "--": blindseal -- <command> [args...]');
  const cmd = afterSep[0];
  if (!cmd) throw new Error('no command after "--": blindseal -- <command> [args...]');
  return { transport: 'stdio', stdioTarget: { cmd, args: afterSep.slice(1) } };
}

function fail(prefix: string, err: unknown): never {
  process.stderr.write(`${prefix}: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first === undefined) {
    process.stdout.write(HELP);
    process.exit(2);
  }
  if (first === '--help' || first === '-h') {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (first === '--version' || first === '-v') {
    process.stdout.write(`blindseal ${packageVersion()}\n`);
    process.exit(0);
  }

  if (SUBCOMMANDS.has(first)) {
    const rest = argv.slice(1);
    switch (first) {
      case 'init':
        import('./cli/init.js').then((m) => m.runInit(rest)).then((code) => process.exit(code)).catch((e) => fail('blindseal init', e));
        return;
      case 'run':
        import('./cli/run.js').then((m) => m.runRun(rest)).then((code) => { if (code !== 0) process.exit(code); }).catch((e) => fail('blindseal run', e));
        return; // the server keeps the process alive
      case 'dashboard':
        import('./cli/dashboard.js').then((m) => m.runDashboardCli(rest)).then((code) => { if (code !== 0) process.exit(code); }).catch((e) => fail('blindseal dashboard', e));
        return; // may keep a `run --mock` alive
      case 'demo':
        runDemo().then(() => process.exit(0)).catch((e) => fail('blindseal demo', e));
        return;
      case 'attest':
        import('./cli/attest.js').then((m) => m.runAttestCli(rest)).then((code) => process.exit(code)).catch((e) => fail('blindseal attest', e));
        return;
      case 'submit':
        import('./cli/submit.js').then((m) => m.runSubmitCli(rest)).then((code) => process.exit(code)).catch((e) => fail('blindseal submit', e));
        return;
      case 'verify':
        import('./cli/verify.js').then((m) => m.runVerifyCli(rest)).then((code) => process.exit(code)).catch((e) => fail('blindseal verify', e));
        return;
      case 'audit':
        import('./cli/audit.js').then((m) => m.runAuditCli(rest)).then((code) => process.exit(code)).catch((e) => fail('blindseal audit', e));
        return;
      case 'history':
        process.exit(runHistoryCli(rest));
    }
  }

  // Proxy mode: `blindseal -- <cmd>` or `blindseal --transport http|scan-http ...`. Any other
  // first token is a typo, not a server to spawn.
  if (!PROXY_FLAGS.has(first) && !(first.startsWith('-') && argv.includes('--'))) {
    process.stderr.write(
      first.startsWith('-')
        ? `blindseal: unknown flag "${first}"\n`
        : `blindseal: unknown command "${first}"\n`,
    );
    process.stderr.write(HELP);
    process.exit(2);
  }

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`blindseal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(HELP);
    process.exit(2);
  }

  if (parsed.transport === 'http') {
    startHttpProxy({ upstream: parsed.upstream!, listenPort: parsed.port!, listenHost: parsed.host });
    return;
  }
  if (parsed.transport === 'scan-http') {
    startScanHttp({ listenPort: parsed.port!, listenHost: parsed.host, defaultServerUrl: parsed.serverUrl });
    return;
  }
  const { cmd, args } = parsed.stdioTarget!;
  startProxy(cmd, args);
}

main();
