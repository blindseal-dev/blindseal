#!/usr/bin/env node
// Copies the product into the package before publishing (`pnpm build` / `prepack`):
//   ../dashboard/dist  → packages/proxy/dashboard/   (served by `blindseal run` at /)
//   <repo>/fixtures/*.json → packages/proxy/fixtures/ (served by `blindseal run --mock`)
// Both target dirs are gitignored and listed in package.json "files".
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const dashboardDist = join(pkg, '..', 'dashboard', 'dist');
const repoFixtures = join(pkg, '..', '..', 'fixtures');

if (!existsSync(join(dashboardDist, 'index.html'))) {
  console.error(`bundle-assets: ${dashboardDist} is missing — run \`pnpm -C packages/dashboard build\` first`);
  process.exit(1);
}
if (!existsSync(join(repoFixtures, 'decisions.json'))) {
  console.error(`bundle-assets: ${repoFixtures} is missing (expected the repo's fixtures/)`);
  process.exit(1);
}

rmSync(join(pkg, 'dashboard'), { recursive: true, force: true });
cpSync(dashboardDist, join(pkg, 'dashboard'), { recursive: true });

rmSync(join(pkg, 'fixtures'), { recursive: true, force: true });
mkdirSync(join(pkg, 'fixtures'));
let n = 0;
for (const f of readdirSync(repoFixtures)) {
  if (!f.endsWith('.json')) continue; // never the generator script
  copyFileSync(join(repoFixtures, f), join(pkg, 'fixtures', f));
  n++;
}
console.log(`✓ dashboard copied to dashboard/ · ${n} fixture files copied to fixtures/`);
