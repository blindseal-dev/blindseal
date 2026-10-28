import { startProxy } from './transports/stdio.js';
import { startHttpProxy } from './transports/http.js';
import { startScanHttp } from './transports/scan-http.js';
import { runDemo } from './cli/demo.js';
import { runHistoryCli } from './cli/history.js';
import { packageVersion } from './paths.js';
import { loadConfig } from './config.js';
import { preflightLayer2 } from './detection/layer2-preflight.js';
import { layer3StartupLine } from './detection/clients/factory.js';

const HELP = `blindseal — a local MCP proxy that screens every tool call, keeps a hash-chained audit
log, and produces zero-knowledge attestations verifiable on Solana.

Usage
  blindseal init                                    set up ~/.blindseal (identity key, default policy, dashboard token)
  blindseal init --wrap [--yes --dry-run --config <path>]
                                                    route the MCP servers in your Claude configs through blindseal
  blindseal init --unwrap                           restore those configs from their backups
  blindseal run                                     local API + dashboard over the decisions recorded on this machine
  blindseal run --mock                              the same over bundled sample data (dashboard shows "Sample data")
  blindseal dashboard                               open the dashboard (starts \`run\` if nothing is listening)
  blindseal -- <command> [args...]                  wrap a stdio MCP server
  blindseal --transport http --upstream <url>       proxy a remote MCP server over HTTP
  blindseal --transport scan-http [--port <n>]      stand-alone POST /scan endpoint
  blindseal attest <toolcall.json> --target-program <id> [--out <file>] [--expiry <slot> | --no-expiry]
  blindseal submit <attestation.json> --wallet <kp> perform the gated transfer on Solana mainnet (verify + consume + transfer)
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
  --allow-degraded                    start even if the layer-2 embedding model fails to load (block
                                      mode otherwise refuses to start, exit code 4); decisions made
                                      without layer 2 are marked degraded
  --version, -v                       print version
  --help, -h                          this help

Detection (env)
  BLINDSEAL_MODE                 block (default) | warn | log
  BLINDSEAL_LAYER2_THRESHOLD     cosine distance cutoff for L2 (default 0.35)
  BLINDSEAL_LAYER3_PROVIDER      ollama | anthropic | openai | custom  (default: off — L3 runs only when set;
                                 provider API keys in the environment never enable it)
  BLINDSEAL_LAYER3_MODEL         model id override
  BLINDSEAL_LAYER3_BASE_URL      base URL override (ollama or custom endpoint)
  BLINDSEAL_LAYER3_TIMEOUT_MS    judge call hard timeout (default 15000)
  BLINDSEAL_L3_FP_SAFE           1 = demote suspicious→clean when L3 unavailable
  BLINDSEAL_LAYER3_API_KEY       key for the chosen provider (anthropic/openai also read ANTHROPIC_API_KEY /
                                 OPENAI_API_KEY, but only once the provider is chosen explicitly)
  OLLAMA_HOST                    Ollama base URL when BLINDSEAL_LAYER3_PROVIDER=ollama (default http://localhost:11434)
  BLINDSEAL_MODEL_DIR            cache directory for the layer-2 embedding model
  BLINDSEAL_MODEL_HOST           mirror to download the layer-2 model from (default: Hugging Face Hub)
  BLINDSEAL_MODEL_OFFLINE        1 = never download the layer-2 model (it must already be cached)
  The active judge is printed at startup: layer-3 judge: local | remote:<provider> | off

Capability firewall (env, default off)
  BLINDSEAL_CAPABILITY                 1 to enable taint-tracking + gate
  BLINDSEAL_CAPABILITY_MODE            block (default) | warn
  BLINDSEAL_TAINT_MIN_OVERLAP          chars of overlap to gate (default 32)
  BLINDSEAL_TAINT_WINDOW_SIZE          recent responses tracked (default 10)
  BLINDSEAL_SENSITIVE_TOOL_PATTERNS    comma-separated regexes added to defaults

Manifest verification (env)
  BLINDSEAL_MANIFEST_CHECK             on (default) | off | strict
  BLINDSEAL_MANIFEST_CACHE_DIR         override \$XDG_CACHE_HOME/blindseal/manifests

Audit (env) — every decision is appended to the content-free hash chain (always on)
  BLINDSEAL_AUDIT_DIR                  chain + encrypted content store dir (default ~/.blindseal)
  BLINDSEAL_AUDIT_LOG                  optional plaintext JSONL of decision metadata (no args/content)

Local scan history (env, default off)
  BLINDSEAL_PERSIST                    1 to record scan METADATA to ~/.blindseal/scans.db (no text; the
                                       redacted text stays in the encrypted audit store)
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
const PROXY_FLAGS = new Set(['--', '--transport', '--upstream', '--port', '--listen-port', '--host', '--server-url', '--allow-degraded']);

interface ParsedArgs {
  transport: 'stdio' | 'http' | 'scan-http';
  upstream?: string;
  port?: number;
  host?: string;
  serverUrl?: string;
  allowDegraded?: boolean;
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
  let allowDegraded = false;

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
    } else if (a === '--allow-degraded') {
      allowDegraded = true;
    } else if (a && a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    } else if (a) {
      throw new Error(`unexpected argument "${a}" — to wrap an MCP server use: blindseal -- ${a} ...`);
    }
  }

  if (transport === 'http') {
    if (!upstream) throw new Error('--transport http requires --upstream <url>');
    return { transport, upstream, port: port ?? 8800, host: host ?? '127.0.0.1', allowDegraded };
  }

  if (transport === 'scan-http') {
    return { transport, port: port ?? 9787, host: host ?? '127.0.0.1', serverUrl, allowDegraded };
  }

  // stdio: the target command must come after `--`
  if (sepIdx < 0) throw new Error('wrapping an MCP server requires "--": blindseal -- <command> [args...]');
  const cmd = afterSep[0];
  if (!cmd) throw new Error('no command after "--": blindseal -- <command> [args...]');
  return { transport: 'stdio', allowDegraded, stdioTarget: { cmd, args: afterSep.slice(1) } };
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
        return; // may keep a `run` alive
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

  // The layer-3 selection is printed first; the layer-2 preflight (which prints its own
  // DEGRADED / refusal line on failure) runs before any server is spawned or port opened.
  process.stderr.write(layer3StartupLine());
  void preflightLayer2({ mode: loadConfig().mode, allowDegraded: parsed.allowDegraded === true }).then((pre) => {
    if (pre.exitCode !== undefined) process.exit(pre.exitCode);
    startTransport(parsed);
  });
}

function startTransport(parsed: ParsedArgs): void {
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
