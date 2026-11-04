import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, type DogfoodConfig } from '../src/config.js';

export function tempDir(label: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), `bs-dogfood-${label}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/// A dry-run config whose state lives under `dir`; no wallet file exists anywhere.
export function dryRunConfig(dir: string, over: Partial<DogfoodConfig> = {}): DogfoodConfig {
  return {
    ...DEFAULT_CONFIG,
    dryRun: true,
    dataDir: path.join(dir, 'data'),
    walletPath: path.join(dir, 'no-such-wallet.json'),
    ...over,
  };
}
