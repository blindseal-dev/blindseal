// Serves the standalone production build locally the way the Docker image does: copies .next/static and
// public beside the standalone server, then runs it. Usage: PORT=3004 node scripts/serve-standalone.mjs
import { cpSync, existsSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
const sa = path.join(root, '.next/standalone/apps/site');
if (!existsSync(path.join(sa, 'server.js'))) { console.error('no standalone build — run `next build` first'); process.exit(1); }
for (const [from, to] of [['.next/static', '.next/static'], ['public', 'public']]) {
  rmSync(path.join(sa, to), { recursive: true, force: true });
  cpSync(path.join(root, from), path.join(sa, to), { recursive: true });
}
const child = spawn(process.execPath, [path.join(sa, 'server.js')], { stdio: 'inherit', env: { ...process.env, HOSTNAME: process.env.HOSTNAME || '127.0.0.1' } });
child.on('exit', (c) => process.exit(c ?? 0));
