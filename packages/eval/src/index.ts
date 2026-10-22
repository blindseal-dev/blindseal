/// Blindseal Red Team CLI — runs the scoreboard against every available competitor.
///
/// Usage:
///   pnpm --filter @blindseal/eval score                     # all available competitors
///   ANTHROPIC_API_KEY=... a third-party detector_API_KEY=... pnpm eval score
///
/// Writes the scoreboard to stdout and to packages/eval/scoreboard.md.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blindsealFull, blindsealL1, blindsealL2 } from './competitors/blindseal.js';
import { a third-party detector } from './competitors/a third-party detector.js';
import { openaiModeration } from './competitors/openai-moderation.js';
import { anthropicJudge } from './competitors/anthropic-judge.js';
import { scoreCompetitor } from './runner.js';
import { renderMarkdown } from './scoreboard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'scoreboard.md');

const COMPETITORS = [blindsealFull, blindsealL1, blindsealL2, a third-party detector, openaiModeration, anthropicJudge];

async function main(): Promise<void> {
  process.stderr.write(`blindseal-eval: running ${COMPETITORS.length} competitors against corpus...\n`);
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
