/// `blindseal audit verify` — recompute the hash chain from genesis.
/// `blindseal audit disclose --from <i> --to <j> [--out <file>]` — signed, content-free disclosure
/// of a window (BLINDSEAL.md §3.6). Both work offline on ~/.blindseal (or --dir).
import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openAudit } from '@blindseal/audit';

const HELP = `blindseal audit — the hash-chained decision log

Usage:
  blindseal audit verify [--dir <dir>]
  blindseal audit disclose --from <index> --to <index> [--out <file>] [--dir <dir>]

Flags
  --dir <dir>     audit base dir (default ~/.blindseal)
  --out <file>    write the disclosure here (default disclosure-<from>-<to>.json)
  --help, -h      this help
`;

export async function runAuditCli(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') { process.stdout.write(HELP); return sub ? 0 : 2; }
  let dir = path.join(os.homedir(), '.blindseal'), from: number | undefined, to: number | undefined, out: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dir') dir = argv[++i]!;
    else if (a === '--from') from = Number.parseInt(argv[++i]!, 10);
    else if (a === '--to') to = Number.parseInt(argv[++i]!, 10);
    else if (a === '--out') out = argv[++i];
    else { process.stderr.write(`blindseal audit: unknown flag ${a}\n${HELP}`); return 2; }
  }
  const audit = openAudit(dir);
  if (sub === 'verify') {
    const head = audit.chain.head();
    if (!head) { process.stdout.write('audit: empty chain (nothing recorded yet)\n'); return 0; }
    const r = audit.chain.verify();
    process.stdout.write(`audit: ${r.ok ? 'INTACT' : 'BROKEN'} — ${r.checkedTo - r.checkedFrom + 1} entries, head #${head.index} ${head.hash}${r.ok ? '' : ` (broken at #${r.brokenAt})`}\n`);
    return r.ok ? 0 : 1;
  }
  if (sub === 'disclose') {
    if (from === undefined || to === undefined || Number.isNaN(from) || Number.isNaN(to) || from > to) {
      process.stderr.write('blindseal audit disclose: --from and --to (indices, from ≤ to) are required\n'); return 2;
    }
    const d = audit.disclose(from, to);
    const file = out ?? `disclosure-${from}-${to}.json`;
    writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
    process.stdout.write(`disclosure written: ${file} (${d.entries.length} entries, signer ${d.signerPubkey.slice(0, 16)}…)\n`);
    return 0;
  }
  process.stderr.write(`blindseal audit: unknown subcommand ${sub}\n${HELP}`);
  return 2;
}
