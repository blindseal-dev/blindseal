// Catch rate of what the proof asserts (release 0.8.0) — the one method Blindseal quotes.
//
// Method: each sample is placed in a tool-call argument — the `memo` of the mainnet sample's transfer call
// (tests/fixtures/mainnet-toolcall-demo.json) — serialized exactly as `blindseal attest` serializes it
// (JSON.stringify({ tool, args })), and screened by screenPayload (packages/proxy/src/detection/proven.ts):
// L1 and L0 on the raw payload and on every JSON string leaf, which is what the 0.8.0 guest asserts
// (detector-core screen.rs; the parity gate holds the two equal). A sample counts as caught when the
// screen is not clean (suspicious included): no proof can be made for that call. On a clean set the same
// test counts a false positive. Only the proven layers count; L2/L3 (model-based, attested) are excluded.
//
// Sets, reported separately with their sizes:
//   - true holdout: packages/eval/datasets/holdout-v2-novel + holdout-v2-paraphrase (never used to design rules)
//   - red-team set: the 31 attack samples of packages/eval/src/corpus.ts (the scoreboard set; the rules were
//     not tuned on it in this release, but it is not a holdout either)
//   - benign: packages/eval/datasets/benign + benign-v2, and the scoreboard's 32 clean samples
//
//   pnpm -C packages/proxy exec tsx ../../evals/catch-rate.ts > evals/results/catch-rate-0.8.0.md
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLayer1 } from '../packages/proxy/src/detection/layer1-heuristics.js';
import { screenPayload } from '../packages/proxy/src/detection/proven.js';
import { ATTACKS, CLEAN } from '../packages/eval/src/corpus.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
interface Sample { id: string; text: string }

function readDir(dir: string): Sample[] {
  const out: Sample[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory() || !name.endsWith('.json')) continue;
    const data: unknown = JSON.parse(readFileSync(p, 'utf8'));
    const arr = Array.isArray(data) ? data : Object.values(data as object).find(Array.isArray);
    if (!Array.isArray(arr)) continue;
    arr.forEach((e: { id?: string; text?: unknown }, i: number) => { if (typeof e?.text === 'string') out.push({ id: `${name}:${e.id ?? i}`, text: e.text }); });
  }
  return out;
}
const D = (rel: string) => readDir(path.join(ROOT, 'packages/eval/datasets', rel));

const base = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/mainnet-toolcall-demo.json'), 'utf8')) as { toolName: string; args: Record<string, unknown> };
const asToolCall = (memo: string) => JSON.stringify({ tool: base.toolName, args: { ...base.args, memo } });
const caughtByProof = (text: string) => !screenPayload(asToolCall(text)).clean;
const caughtRawL1 = (text: string) => runLayer1(text).verdict !== 'clean';

const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(1)} %`;
const row = (name: string, samples: Sample[], f: (t: string) => boolean) => {
  const n = samples.filter((s) => f(s.text)).length;
  return { name, size: samples.length, n, line: `| ${name} | ${samples.length} | ${n} | ${pct(n, samples.length)} |` };
};

const holdout = [...D('holdout-v2-novel'), ...D('holdout-v2-paraphrase')];
const lines: string[] = [];
const out = (s = '') => lines.push(s);
out('# Catch rate of the proven layers, as the proof sees it (release 0.8.0)');
out();
out('Each sample is the `memo` of the mainnet sample transfer call, serialized as `blindseal attest` serializes it,');
out('and screened the way the 0.8.0 guest asserts it: L1 and L0 on the raw payload and on every JSON string leaf.');
out('Caught = the screen is not clean (suspicious included), so no proof can be made. L2/L3 are not counted.');
out();
out('| attack set | samples | caught | catch rate |');
out('|---|---:|---:|---:|');
const h = row('**true holdout** (holdout-v2 novel + paraphrase)', holdout, caughtByProof);
out(h.line);
out(row('— novel', D('holdout-v2-novel'), caughtByProof).line);
out(row('— paraphrase', D('holdout-v2-paraphrase'), caughtByProof).line);
const rt = row('**red-team set** (scoreboard attacks)', ATTACKS, caughtByProof);
out(rt.line);
out();
out('| clean set | samples | flagged | false-positive rate |');
out('|---|---:|---:|---:|');
const benign = [...D('benign'), ...D('benign-v2')];
const fp = row('**benign + benign-v2**', benign, caughtByProof);
out(fp.line);
out(row('scoreboard clean samples', CLEAN, caughtByProof).line);
out();
out('## Reconciling the red-team number');
out();
out('The scoreboard (packages/eval/scoreboard.md) still shows 32.3 % (10 of 31) for L1. That table came with the');
out('repository when it was created from its base project and was never regenerated here. Run on the same 31 samples:');
out();
out('| method | caught of 31 |');
out('|---|---:|');
out(`| L1 alone on the raw sample text (the scoreboard's method, today's rules) | ${ATTACKS.filter((s) => caughtRawL1(s.text)).length} |`);
out(`| the proof's method above | ${rt.n} |`);
out();
out('The rules in the first commit of this repository give the same 9 of 31 as today, so 29.0 % is the reproducible');
out('figure and 32.3 % is withdrawn. Placing a sample inside a tool call does not change any result on these sets.');
process.stdout.write(lines.join('\n') + '\n');
process.stderr.write(`true holdout ${h.n}/${h.size} = ${pct(h.n, h.size)}; red-team ${rt.n}/${rt.size} = ${pct(rt.n, rt.size)}; benign FP ${fp.n}/${fp.size} = ${pct(fp.n, fp.size)}\n`);
