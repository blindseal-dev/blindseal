/// Where things live at runtime. The CLI runs either from the tsup bundle (dist/index.js inside
/// the installed `blindseal` package) or from source under tsx (src/**.ts). Both resolve the
/// package root by walking up from import.meta.url to the package.json named `blindseal`, so
/// shipped assets (dashboard/, fixtures/) are found without caring which layout is in play.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | undefined;

/// Absolute path of the installed package (the directory holding package.json).
export function packageRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const name = (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name;
        if (name === 'blindseal') { cachedRoot = dir; return dir; }
      } catch { /* keep walking */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: dist/ or src/ is one level under the package.
  cachedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return cachedRoot;
}

/// The package version (package.json), '0.0.0' if unreadable.
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ? String(pkg.version) : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/// ~/.blindseal — identity key, audit log, policy, dashboard token, downloaded prover.
export function blindsealHome(): string {
  return path.join(os.homedir(), '.blindseal');
}

/// The built dashboard shipped inside the package (<package>/dashboard), or undefined if it
/// was not bundled (a source checkout that has not run `pnpm build`).
export function shippedDashboardDir(): string | undefined {
  const dir = path.join(packageRoot(), 'dashboard');
  return existsSync(path.join(dir, 'index.html')) ? dir : undefined;
}

/// The mock fixtures shipped inside the package (<package>/fixtures), or undefined.
export function shippedFixturesDir(): string | undefined {
  const dir = path.join(packageRoot(), 'fixtures');
  return existsSync(path.join(dir, 'decisions.json')) ? dir : undefined;
}

/// Dev-time fallback: the nearest fixtures/ walking up from cwd (the repo's fixtures/).
export function nearestFixturesDir(from: string = process.cwd()): string | undefined {
  let dir = from;
  for (let i = 0; i < 7; i++) {
    const candidate = path.join(dir, 'fixtures');
    if (existsSync(path.join(candidate, 'decisions.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/// ~/.blindseal/dashboard.token — the bearer token the local API and the dashboard share.
export function dashboardTokenPath(): string {
  return path.join(blindsealHome(), 'dashboard.token');
}

/// Read the dashboard token, creating it (0600) on first use. Falls back to an ephemeral token
/// when the home directory is unwritable (CI sandboxes).
export function resolveDashboardToken(explicit?: string): string {
  if (explicit) return explicit;
  const file = dashboardTokenPath();
  try {
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tok = randomBytes(24).toString('base64url');
    writeFileSync(file, tok + '\n', { mode: 0o600 });
    return tok;
  } catch {
    return randomBytes(24).toString('base64url');
  }
}
