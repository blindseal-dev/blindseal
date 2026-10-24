// Copy the generated verifier wasm into public/ so the verify page fetches it from our own origin.
// Runs on predev/prebuild; the copy is gitignored (the source of truth is blindseal-verifier-wasm).
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const pkgJson = require.resolve('blindseal-verifier-wasm/package.json');
const src = join(dirname(pkgJson), 'pkg', 'blindseal_verifier_bg.wasm');
const outDir = join(dirname(new URL(import.meta.url).pathname), '..', 'public');
mkdirSync(outDir, { recursive: true });
copyFileSync(src, join(outDir, 'blindseal_verifier_bg.wasm'));
console.log('sync-wasm: copied blindseal_verifier_bg.wasm → public/');
