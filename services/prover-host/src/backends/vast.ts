/// `vast` backend: a rented GPU instance runs the prover. Implemented on a separate branch against
/// ./types.ts; this stub keeps the registry complete and fails with a clear error until then.
import { BackendNotConfigured, type AttestationJson, type ProofBackend, type ProofJob } from './types.js';

export interface VastConfig {
  apiKeyFile?: string;
  gpu?: string;
  maxPriceUsdPerHour?: number;
  maxInstanceAgeMinutes?: number;
  image?: string;
}

export class VastBackend implements ProofBackend {
  readonly name = 'vast' as const;
  constructor(private readonly config: VastConfig) {}
  prove(_job: ProofJob, _signal: AbortSignal): Promise<AttestationJson> {
    void this.config;
    return Promise.reject(new BackendNotConfigured('vast', 'not implemented in this build'));
  }
}
