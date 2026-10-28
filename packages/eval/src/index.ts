/// Blindseal Red Team CLI — runs the scoreboard against every available competitor.
///
/// Usage:
///   pnpm --filter @blindseal/eval score                     # all available competitors
///   BLINDSEAL_LAYER3_PROVIDER=anthropic ANTHROPIC_API_KEY=... pnpm eval score
///
/// blindseal-full includes layer 3 only when BLINDSEAL_LAYER3_PROVIDER is set (the same rule as
/// the proxy: a provider key alone never enables it); the active judge is printed first.
///
/// Writes the scoreboard to stdout and to packages/eval/scoreboard.md.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blindsealFull, blindsealL1, blindsealL2 } from './competitors/blindseal.js';
import { openaiModeration } from './competitors/openai-moderation.js';
import { anthropicJudge } from './competitors/anthropic-judge.js';
import { scoreCompetitor } from './runner.js';
import { renderMarkdown } from './scoreboard.js';
import { evalLayer3 } from './l3-env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'scoreboard.md');

const COMPETITORS = [blindsealFull, blindsealL1, blindsealL2, openaiModeration, anthropicJudge];

async function main(): Promise<void> {
  process.stderr.write(`blindseal-eval: running ${COMPETITORS.length} competitors against corpus...\n`);
  process.stderr.write(`blindseal-eval: blindseal-full ${evalLayer3().line}\n`);
  const scores = [];
  for (const c of COMPETITORS) {
    process.stderr.write(`  ${c.name}... `);
    const s = await scoreCompetitor(c);
    process.stderr.write(s.ok ? `ok (F1=${(s.f1 * 100).toFixed(1)}%)\n` : `skipped (${s.reason})\n`);
    scores.push(s);
  }
  const md = renderMarkdown(scores);
  process.stdout.write(md);
  writeFileSync(OUT, md);
  process.stderr.write(`blindseal-eval: wrote ${OUT}\n`);
}

main().catch((err) => {
  process.stderr.write(`blindseal-eval failed: ${err}\n`);
  process.exit(1);
});
