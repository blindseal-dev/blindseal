export {
  computeFingerprint,
  diffFingerprints,
  fingerprintTools,
  serverKey,
  stableStringify,
  type InitializeResult,
  type ManifestFingerprint,
  type ToolEntry,
  type ToolsListResult,
  type ToolSummary,
} from './fingerprint.js';

export { ManifestStore, defaultCacheDir, migrateCacheDir, type MigrationReport, type StoredManifest } from './store.js';
import { ManifestChecker, type ManifestConfig } from './checker.js';
import { defaultCacheDir, migrateCacheDir } from './store.js';

/// The transports' entry point: a checker when the manifest check is on. When it is off the
/// cache is still migrated, so records an older version wrote (raw command lines) do not stay
/// on disk just because the check was turned off.
export function openManifestChecker(cmd: string, args: string[], config: ManifestConfig): ManifestChecker | null {
  if (config.mode !== 'off') return new ManifestChecker(cmd, args, config);
  migrateCacheDir(config.cacheDir && config.cacheDir.length > 0 ? config.cacheDir : defaultCacheDir());
  return null;
}

export {
  ManifestChecker,
  type ManifestConfig,
  type ManifestMode,
  type ManifestStatus,
  type ManifestVerdict,
} from './checker.js';
