// Concatenate the kit modules (mockups' load order) into public/kit/kit.js so ONE script loads
// after hydration with guaranteed order (next/script afterInteractive scripts are async).
// Runs on predev/prebuild; the bundle is gitignored — the modules are the source.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'kit');
const ORDER = ['constants', 'icons', 'motion', 'reveal', 'glass', 'diagrams', 'ui', 'sheet', 'space', 'crt', 'site-templates', 'site'];
const SRC = (n) => (n === 'site-templates' ? join(dir, '..', '..', 'kit', 'site-templates.cjs') : join(dir, `${n}.js`));
const out = ORDER.map((n) => `/* ---- ${n}.js ---- */\n` + readFileSync(SRC(n), 'utf8')).join('\n;\n');
writeFileSync(join(dir, 'kit.js'), out);
console.log(`bundle-kit: ${ORDER.length} modules → public/kit/kit.js (${(out.length / 1024).toFixed(0)} KB)`);
