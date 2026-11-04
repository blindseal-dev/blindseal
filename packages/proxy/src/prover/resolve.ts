/// Where `blindseal attest` finds the prover binary (crates/prover), in order:
///   1. --prover <path>
///   2. $BLINDSEAL_PROVER
///   3. ~/.blindseal/bin/blindseal-prover-<version>   (version from manifest.json)
///   4. a source checkout's crates/prover/target/release/blindseal-prover above cwd
///   5. download from the GitHub release named in manifest.json, verify sha256, install at (3)
/// Anything else is one actionable error (ProverUnavailableError).
///
/// Variants: on linux-x64 with a working `nvidia-smi` the `linux-x64-cuda` asset (the prover built with
/// the cuda feature, run with `--mode cuda`) is preferred when the manifest has a real sha256 for it; a
/// `TBD` sha means "not released yet" and the CPU asset is used with one log line. Only the download
/// step picks a variant: an explicit binary (--prover, $BLINDSEAL_PROVER) runs in its own default mode.
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { blindsealHome } from '../paths.js';
import manifestJson from './manifest.json' with { type: 'json' };

export interface ProverAsset { name: string; sha256: string }
export interface ProverManifest {
  version: string;
  release: string;
  /// The guest ELF the released prover embeds (scripts/check-prover-asset.sh reads it).
  guestElf?: { sha256: string; bytes: number };
  assets: Record<string, ProverAsset>;
}

/// How `blindseal attest` runs the binary it resolved: `cuda` only for the cuda asset.
export type ProverMode = 'cpu' | 'cuda';
export interface ResolvedProver { path: string; mode: ProverMode }

/// A sha256 of 64 hex digits; the manifest writes `TBD` for an asset whose release does not exist yet.
export function assetAvailable(asset: ProverAsset | undefined): asset is ProverAsset {
  return !!asset && /^[0-9a-f]{64}$/i.test(asset.sha256);
}

/// Is there an NVIDIA GPU the cuda prover could use? `nvidia-smi -L` exits 0 when the driver sees one.
export function nvidiaSmiProbe(): boolean {
  try {
    return spawnSync('nvidia-smi', ['-L'], { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

/// The manifest asset to download for `platform`: `<platform>-cuda` when that asset is released and the
/// GPU probe succeeds, else `platform`. `log` gets one line when a cuda asset exists but is not released.
export function selectProverAsset(
  platform: string,
  manifest: ProverManifest,
  gpuProbe: () => boolean,
  log: (line: string) => void = () => {},
): { key: string; mode: ProverMode } {
  const cudaKey = `${platform}-cuda`;
  const cuda = manifest.assets[cudaKey];
  if (!cuda || platform !== 'linux-x64') return { key: platform, mode: 'cpu' };
  if (!gpuProbe()) return { key: platform, mode: 'cpu' };
  if (!assetAvailable(cuda)) {
    log(`blindseal attest: an NVIDIA GPU is present but the cuda prover ${manifest.version} is not released yet (manifest sha256 TBD); using the CPU prover`);
    return { key: platform, mode: 'cpu' };
  }
  return { key: cudaKey, mode: 'cuda' };
}

export const PROVER_MANIFEST: ProverManifest = manifestJson as ProverManifest;

export class ProverUnavailableError extends Error {
  constructor(platform: string) {
    super(proverUnavailableMessage(platform));
    this.name = 'ProverUnavailableError';
  }
}

export function proverUnavailableMessage(platform: string): string {
  return (
    `blindseal attest: no prover binary for ${platform}. Build it: ` +
    'git clone https://github.com/blindseal-dev/blindseal && cd blindseal && cargo build --release --manifest-path crates/prover/Cargo.toml, ' +
    'then pass --prover crates/prover/target/release/blindseal-prover or set BLINDSEAL_PROVER.'
  );
}

/// "<platform>-<arch>" as the manifest keys it: darwin-arm64, linux-x64, …
export function proverPlatform(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export interface ResolveProverOptions {
  explicit?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  manifest?: ProverManifest;
  platform?: string;
  cwd?: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /// GPU probe for the cuda variant (default: `nvidia-smi -L`). Tests inject it.
  gpuProbe?: () => boolean;
}

function findRepoProver(from: string): string | undefined {
  let dir = from;
  for (let i = 0; i < 7; i++) {
    const c = path.join(dir, 'crates', 'prover', 'target', 'release', 'blindseal-prover');
    if (existsSync(c)) return c;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export async function resolveProver(opts: ResolveProverOptions = {}): Promise<string> {
  return (await resolveProverBinary(opts)).path;
}

/// resolveProver plus the mode to run the binary in. The cuda asset installs beside the CPU one as
/// `blindseal-prover-<version>-cuda`, so a box with both keeps both.
export async function resolveProverBinary(opts: ResolveProverOptions = {}): Promise<ResolvedProver> {
  const env = opts.env ?? process.env;
  const manifest = opts.manifest ?? PROVER_MANIFEST;
  const platform = opts.platform ?? proverPlatform();
  const home = opts.home ?? blindsealHome();
  const log = opts.log ?? ((line: string) => process.stdout.write(line + '\n'));

  if (opts.explicit) {
    if (!existsSync(opts.explicit)) throw new Error(`--prover ${opts.explicit}: no such file`);
    return { path: opts.explicit, mode: 'cpu' };
  }
  if (env.BLINDSEAL_PROVER) {
    if (!existsSync(env.BLINDSEAL_PROVER)) throw new Error(`BLINDSEAL_PROVER=${env.BLINDSEAL_PROVER}: no such file`);
    return { path: env.BLINDSEAL_PROVER, mode: 'cpu' };
  }

  const binDir = path.join(home, 'bin');
  const chosen = selectProverAsset(platform, manifest, opts.gpuProbe ?? nvidiaSmiProbe, log);
  const installed = path.join(binDir, `blindseal-prover-${manifest.version}${chosen.mode === 'cuda' ? '-cuda' : ''}`);
  if (existsSync(installed)) return { path: installed, mode: chosen.mode };

  const repo = findRepoProver(opts.cwd ?? process.cwd());
  if (repo) return { path: repo, mode: 'cpu' };

  // download on first use
  const asset = manifest.assets[chosen.key];
  if (!assetAvailable(asset)) throw new ProverUnavailableError(platform);
  const url = `${manifest.release.replace(/\/$/, '')}/${asset.name}`;
  const fetchImpl = opts.fetchImpl ?? fetch;
  let bytes: Buffer;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch {
    throw new ProverUnavailableError(platform);
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== asset.sha256.toLowerCase()) throw new ProverUnavailableError(platform);

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
  log(`blindseal attest: downloaded prover ${manifest.version} for ${chosen.key} → ${installed}`);
  return { path: installed, mode: chosen.mode };
}
