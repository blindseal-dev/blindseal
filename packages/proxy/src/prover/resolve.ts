/// Where `blindseal attest` finds the prover binary (crates/prover), in order:
///   1. --prover <path>
///   2. $BLINDSEAL_PROVER
///   3. ~/.blindseal/bin/blindseal-prover-<version>   (version from manifest.json)
///   4. a source checkout's crates/prover/target/release/blindseal-prover above cwd
///   5. download from the GitHub release named in manifest.json, verify sha256, install at (3)
/// Anything else is one actionable error (ProverUnavailableError).
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { blindsealHome } from '../paths.js';
import manifestJson from './manifest.json' with { type: 'json' };

export interface ProverAsset { name: string; sha256: string }
export interface ProverManifest {
  version: string;
  release: string;
  assets: Record<string, ProverAsset>;
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
    'git clone https://github.com/blindseal-dev/blindseal && cd blindseal && cargo build --release -p blindseal-prover, ' +
    'then pass --prover <path> or set BLINDSEAL_PROVER.'
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
  const env = opts.env ?? process.env;
  const manifest = opts.manifest ?? PROVER_MANIFEST;
  const platform = opts.platform ?? proverPlatform();
  const home = opts.home ?? blindsealHome();
  const log = opts.log ?? ((line: string) => process.stdout.write(line + '\n'));

  if (opts.explicit) {
    if (!existsSync(opts.explicit)) throw new Error(`--prover ${opts.explicit}: no such file`);
    return opts.explicit;
  }
  if (env.BLINDSEAL_PROVER) {
    if (!existsSync(env.BLINDSEAL_PROVER)) throw new Error(`BLINDSEAL_PROVER=${env.BLINDSEAL_PROVER}: no such file`);
    return env.BLINDSEAL_PROVER;
  }

  const binDir = path.join(home, 'bin');
  const installed = path.join(binDir, `blindseal-prover-${manifest.version}`);
  if (existsSync(installed)) return installed;

  const repo = findRepoProver(opts.cwd ?? process.cwd());
  if (repo) return repo;

  // download on first use
  const asset = manifest.assets[platform];
  if (!asset || !/^[0-9a-f]{64}$/i.test(asset.sha256)) throw new ProverUnavailableError(platform);
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
  log(`blindseal attest: downloaded prover ${manifest.version} for ${platform} → ${installed}`);
  return installed;
}
