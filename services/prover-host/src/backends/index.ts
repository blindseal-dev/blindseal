/// The backend registry: the config key `backend: 'local' | 'vast'` selects one.
import type { HostConfig } from '../config.js';
import { LocalBackend } from './local.js';
import { BackendNotConfigured, type BackendName, type ProofBackend } from './types.js';
import { VastBackend, type VastConfig } from './vast.js';

const VAST_REQUIRED = ['apiKeyFile', 'gpu', 'maxPriceUsdPerHour', 'maxInstanceAgeMinutes', 'image', 'diskGb', 'proverBinary'] as const;
/// The vast section must name every required field before the backend can run.
function vastConfig(v: Partial<VastConfig>): VastConfig {
  const missing = VAST_REQUIRED.filter((k) => v[k] === undefined);
  if (missing.length) throw new BackendNotConfigured('vast', `the config's vast section needs ${missing.join(', ')}`);
  return v as VastConfig;
}

export type BackendFactory = (config: HostConfig, log: (line: string) => void) => ProofBackend;

export const BACKENDS: Record<BackendName, BackendFactory> = {
  local: (config, log) => new LocalBackend({ proverPath: config.proverPath, log }),
  vast: (config) => new VastBackend(vastConfig(config.vast)),
};

export function createBackend(config: HostConfig, log: (line: string) => void): ProofBackend {
  return BACKENDS[config.backend](config, log);
}

export * from './types.js';
