/// `network` backend: a remote proving network. Implemented on a separate branch against ./types.ts;
/// this stub keeps the registry complete and fails with a clear error until then.
import { BackendNotConfigured, type AttestationJson, type ProofBackend, type ProofJob } from './types.js';

export interface NetworkBackendConfig {
  enabled: boolean;
}

export class NetworkBackend implements ProofBackend {
  readonly name = 'network' as const;
  constructor(private readonly config: NetworkBackendConfig) {}
  prove(_job: ProofJob, _signal: AbortSignal): Promise<AttestationJson> {
    return Promise.reject(new BackendNotConfigured('network', this.config.enabled ? 'not implemented in this build' : 'network.enabled is false'));
  }
}
