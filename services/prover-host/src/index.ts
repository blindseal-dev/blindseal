/// The entry point: `pnpm -C services/prover-host start -- --config <file>`   (or $BLINDSEAL_PROVER_HOST_CONFIG)
import { createBackend } from './backends/index.js';
import { createBilling } from './billing/x402.js';
import { CONFIG_ENV, ConfigError, loadConfig } from './config.js';
import { ProofQueue } from './jobs/queue.js';
import { JobStore } from './jobs/store.js';
import { createServer, VERSION } from './server.js';

const HELP = `blindseal-prover-host ${VERSION} — a hosted Blindseal prover with per-proof x402 billing

Usage:
  blindseal-prover-host --config <file>     (or set ${CONFIG_ENV})

The config is one JSON file; see services/prover-host/README.md for every field.
`;

const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); return 0; }
  const config = loadConfig(argv);
  const store = JobStore.open(config.dataDir);
  const backend = createBackend(config, log);
  const publicUrl = config.publicUrl ?? `http://${config.host}:${config.port}`;
  const billing = await createBilling(config, { publicUrl, log });
  const queue = new ProofQueue({ store, backend, concurrency: config.concurrency, log });
  const recovered = queue.recover();
  if (recovered.requeued || recovered.failed) log(`recovered ${recovered.requeued} unfinished job(s); ${recovered.failed} lost`);
  const server = createServer({ config, store, queue, billing, log });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  log(`listening on ${publicUrl} (backend ${backend.name}, concurrency ${config.concurrency}, billing ${billing ? `${config.priceUsdc} USDC` : 'off'})`);

  let stopping = false;
  const stop = (sig: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: stopping (unfinished jobs are queued again at the next start)`);
    server.close();
    queue.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return 0;
}

main(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write(`blindseal-prover-host: ${e instanceof ConfigError ? e.message : (e as Error).stack ?? String(e)}\n`);
  process.exit(e instanceof ConfigError ? 2 : 1);
});
