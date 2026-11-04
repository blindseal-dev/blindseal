/// Which prover `blindseal attest` runs. The CLI resolves a CPU prover on its own (--prover, $BLINDSEAL_PROVER,
/// ~/.blindseal/bin, a source checkout, the GitHub release pinned in packages/proxy/src/prover/manifest.json).
/// This module adds one thing on top: when an NVIDIA GPU is present (nvidia-smi answers) and the manifest
/// carries the `linux-x64-cuda` asset, that asset is installed and passed as --prover, using the same
/// download + sha256 check as the CLI. A manifest without the asset (older release) means CPU — quietly.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

export const CUDA_ASSET = 'linux-x64-cuda';

export interface ProverManifest { version: string; release: string; assets: Record<string, { name: string; sha256: string }> }

export interface ProverChoice {
  /// Passed to `blindseal attest --prover`; undefined = let the CLI resolve the CPU prover.
  path?: string;
  kind: 'explicit' | 'cuda' | 'cpu';
  note: string;
}

export function hasNvidiaSmi(run: typeof spawnSync = spawnSync): boolean {
  try {
    const r = run('nvidia-smi', ['-L'], { stdio: 'ignore', timeout: 10_000 });
    return r.status === 0;
  } catch { return false; }
}

/// packages/proxy/src/prover/manifest.json from the installed `blindseal` package; undefined if absent.
export function readProverManifest(): ProverManifest | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkgDir = path.dirname(require.resolve('blindseal/package.json'));
    const file = path.join(pkgDir, 'src', 'prover', 'manifest.json');
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8')) as ProverManifest;
  } catch { return undefined; }
}

export interface ChooseProverOptions {
  explicit?: string;
  cuda: 'auto' | 'never' | 'always';
  manifest?: ProverManifest | undefined;
  gpuPresent?: boolean;
  home?: string;
  fetchImpl?: typeof fetch;
  platform?: string;
}

export async function chooseProver(opts: ChooseProverOptions): Promise<ProverChoice> {
  if (opts.explicit) {
    if (!existsSync(opts.explicit)) throw new Error(`prover.path ${opts.explicit}: no such file`);
    return { path: opts.explicit, kind: 'explicit', note: `prover.path ${opts.explicit}` };
  }
  if (opts.cuda === 'never') return { kind: 'cpu', note: 'prover.cuda = never: the CLI resolves the CPU prover' };
  const platform = opts.platform ?? process.platform;
  const gpu = opts.gpuPresent ?? hasNvidiaSmi();
  if (opts.cuda === 'auto' && !gpu) return { kind: 'cpu', note: 'no nvidia-smi: the CLI resolves the CPU prover' };
  if (platform !== 'linux') return { kind: 'cpu', note: `CUDA prover is linux-x64 only (this is ${platform}): the CLI resolves the CPU prover` };
  const manifest = opts.manifest === undefined ? readProverManifest() : opts.manifest;
  const asset = manifest?.assets[CUDA_ASSET];
  if (!manifest || !asset || !/^[0-9a-f]{64}$/i.test(asset.sha256)) {
    const why = `prover manifest has no ${CUDA_ASSET} asset`;
    if (opts.cuda === 'always') throw new Error(`${why}; prover.cuda = always`);
    return { kind: 'cpu', note: `${why}: the CLI resolves the CPU prover` };
  }
  const home = opts.home ?? path.join(os.homedir(), '.blindseal');
  const binDir = path.join(home, 'bin');
  const installed = path.join(binDir, `blindseal-prover-${manifest.version}-${CUDA_ASSET}`);
  if (existsSync(installed)) return { path: installed, kind: 'cuda', note: `CUDA prover ${manifest.version} at ${installed}` };
  const url = `${manifest.release.replace(/\/$/, '')}/${asset.name}`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`CUDA prover download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== asset.sha256.toLowerCase()) throw new Error(`CUDA prover sha256 mismatch (got ${digest.slice(0, 16)}…, manifest ${asset.sha256.slice(0, 16)}…)`);
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const tmp = path.join(binDir, `.${asset.name}.${randomBytes(4).toString('hex')}.part`);
  try {
    writeFileSync(tmp, bytes, { mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, installed);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
  return { path: installed, kind: 'cuda', note: `downloaded CUDA prover ${manifest.version} → ${installed}` };
}
