// Catch rate of the proven deterministic layers (L0 decode-then-L1, then L1) over every attack and
// clean corpus in the repo, exactly as the zk guest evaluates them: runLayer0 then runLayer1 from
// packages/proxy/src/detection, any non-clean verdict (suspicious included) counts as caught on an
// attack corpus and as a false positive on a clean one. Prints a markdown table and per-pattern hit
// counts. Run:  pnpm -C packages/proxy exec tsx ../../evals/deterministic-rate.ts
// Save the output as evals/results/deterministic-rate-<before|after>.md when changing the rules.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLayer0 } from '../packages/proxy/src/detection/layer0-decoder.js';
import { runLayer1 } from '../packages/proxy/src/detection/layer1-heuristics.js';
import { ATTACKS, CLEAN } from '../packages/eval/src/corpus.js';
import { ATTEMPTS } from '../packages/eval/red-team/run-bypasses.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

interface Sample { id: string; text: string }
interface Dataset { name: string; kind: 'attack' | 'clean'; samples: Sample[] }

function readJsonSamples(file: string): Sample[] {
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const arr = Array.isArray(data) ? data : Object.values(data as object).find(Array.isArray);
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((e): e is { id?: string; text: string } => !!e && typeof e.text === 'string')
    .map((e, i) => ({ id: String(e.id ?? i), text: e.text }));
}

function readDir(dir: string): Sample[] {
  const out: Sample[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory() || !name.endsWith('.json')) continue;
    for (const s of readJsonSamples(p)) out.push({ id: `${name}:${s.id}`, text: s.text });
  }
  return out;
}

const D = (rel: string) => path.join(ROOT, 'packages/eval/datasets', rel);

const DATASETS: Dataset[] = [
  { name: 'red-team scoreboard (attacks)', kind: 'attack', samples: ATTACKS.map((s) => ({ id: s.id, text: s.text })) },
  { name: 'red-team self bypass attempts', kind: 'attack', samples: ATTEMPTS.map((a) => ({ id: a.id, text: a.payload })) },
  { name: 'corpus/injection-patterns', kind: 'attack', samples: readJsonSamples(path.join(ROOT, 'packages/corpus/injection-patterns.json')) },
  { name: 'holdout-attacks-burned-v1 (design)', kind: 'attack', samples: readDir(D('holdout-attacks-burned-v1')) },
  { name: 'holdout-v2-novel (held out)', kind: 'attack', samples: readDir(D('holdout-v2-novel')) },
  { name: 'holdout-v2-paraphrase (held out)', kind: 'attack', samples: readDir(D('holdout-v2-paraphrase')) },
  { name: 'benign', kind: 'clean', samples: readDir(D('benign')) },
  { name: 'benign-v2', kind: 'clean', samples: readDir(D('benign-v2')) },
  { name: 'red-team scoreboard (clean)', kind: 'clean', samples: CLEAN.map((s) => ({ id: s.id, text: s.text })) },
];

/// The proven layers in guest order: L0 (every decoder, then L1 on each candidate), then L1 on the
/// text as received. Returns the pattern ids that fired (L0 hits carry the decoder as a prefix).
function proven(text: string): string[] {
  const hits: string[] = [];
  const l0 = runLayer0(text);
  if (l0.fired && l0.l1Match) for (const p of l0.l1Match.detectedPatterns) hits.push(`l0-${l0.decoder}->${p}`);
  const l1 = runLayer1(text);
  if (l1.verdict !== 'clean') for (const p of l1.detectedPatterns) hits.push(p);
  return hits;
}

const pct = (n: number, d: number) => (d === 0 ? '-' : `${((100 * n) / d).toFixed(1)} %`);

const lines: string[] = [];
const out = (s = '') => lines.push(s);
const verbose = process.argv.includes('--misses') || process.argv.includes('--flagged');

out('# Deterministic (proven) layer catch rate');
out();
out('Layers: `runLayer0` (decode-then-L1) then `runLayer1`, as the guest runs them. Any non-clean');
out('verdict, suspicious included, counts as caught on an attack set and as flagged on a clean set.');
out();
out('| dataset | samples | caught | catch rate |');
out('|---|---:|---:|---:|');
const patternHits = new Map<string, number>();
const cleanRows: string[] = [];
const misses: string[] = [];
const flagged: string[] = [];
let holdoutSamples = 0;
let holdoutCaught = 0;
let cleanSamples = 0;
let cleanFlagged = 0;
for (const ds of DATASETS) {
  let caught = 0;
  for (const s of ds.samples) {
    const hits = proven(s.text);
    // One count per pattern per sample (L0 and L1 may report the same rule).
    for (const p of new Set(hits.map((h) => h.replace(/^l0-[^>]*->/, '')))) patternHits.set(p, (patternHits.get(p) ?? 0) + 1);
    if (hits.length > 0) caught++;
    if (ds.kind === 'attack' && hits.length === 0) misses.push(`${ds.name} / ${s.id}: ${JSON.stringify(s.text.slice(0, 160))}`);
    if (ds.kind === 'clean' && hits.length > 0) flagged.push(`${ds.name} / ${s.id}: ${hits.join(', ')} ${JSON.stringify(s.text.slice(0, 120))}`);
  }
  if (ds.kind === 'attack') {
    out(`| ${ds.name} | ${ds.samples.length} | ${caught} | ${pct(caught, ds.samples.length)} |`);
    if (ds.name.startsWith('holdout-v2')) { holdoutSamples += ds.samples.length; holdoutCaught += caught; }
  } else {
    cleanRows.push(`| ${ds.name} | ${ds.samples.length} | ${caught} | ${pct(caught, ds.samples.length)} |`);
    if (ds.name.startsWith('benign')) { cleanSamples += ds.samples.length; cleanFlagged += caught; }
  }
}
out(`| **true holdout (v2 novel + paraphrase)** | ${holdoutSamples} | ${holdoutCaught} | **${pct(holdoutCaught, holdoutSamples)}** |`);
out();
out('| clean dataset | samples | flagged | false-positive rate |');
out('|---|---:|---:|---:|');
for (const r of cleanRows) out(r);
out(`| **benign + benign-v2** | ${cleanSamples} | ${cleanFlagged} | **${pct(cleanFlagged, cleanSamples)}** |`);
out();
out('## Per-pattern hits (samples, all datasets, L0 and L1 combined)');
out();
out('| pattern | samples |');
out('|---|---:|');
for (const [p, n] of [...patternHits.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) out(`| ${p} | ${n} |`);
if (flagged.length > 0) {
  out();
  out('## Flagged clean samples');
  out();
  for (const f of flagged) out(`- ${f}`);
}
if (verbose) {
  out();
  out('## Missed attack samples');
  out();
  for (const m of misses) out(`- ${m}`);
}
process.stdout.write(lines.join('\n') + '\n');
