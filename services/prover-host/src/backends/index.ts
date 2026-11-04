/// The backend registry: the config key `backend: 'local' | 'vast' | 'network'` selects one.
import type { HostConfig } from '../config.js';
import { LocalBackend } from './local.js';
import { NetworkBackend } from './network.js';
import type { BackendName, ProofBackend } from './types.js';
import { VastBackend } from './vast.js';

export type BackendFactory = (config: HostConfig, log: (line: string) => void) => ProofBackend;

export const BACKENDS: Record<BackendName, BackendFactory> = {
  local: (config, log) => new LocalBackend({ proverPath: config.proverPath, log }),
  vast: (config) => new VastBackend(config.vast),
  network: (config) => new NetworkBackend(config.network),
};

export function createBackend(config: HostConfig, log: (line: string) => void): ProofBackend {
  return BACKENDS[config.backend](config, log);
}

export * from './types.js';
