/// The contract between the prover host and a proof backend.
///
/// Self-contained on purpose: the `vast` and `network` backends are implemented on another branch
/// against this file, so it imports nothing from the rest of the service and its shapes stay stable.

export type BackendName = 'local' | 'vast' | 'network';

/// The on-chain action the proof binds, in the form the prover CLI takes it (crates/prover/src/main.rs):
/// pubkeys base58, `mint` '' for native SOL, `amount` a decimal u64 string, `instruction` 0x + 16 hex.
export interface ProofAction {
  chainId: number;
  targetProgram: string;
  sourceAuthority: string;
  instruction: string;
  recipient: string;
  mint: string;
  amount: string;
}

export interface ProofJob {
  id: string;
  /// The screened payload bytes, written 0600 inside a 0700 directory the host removes after the job.
  payloadPath: string;
  /// Where the backend must leave attestation.json (inside the same directory as payloadPath).
  out: string;
  action: ProofAction;
  /// Decimal slot string as `--expiry` takes it; '2000000000' is the no-expiry sentinel.
  expirySlot: string;
  /// 0x + 64 hex. When absent the prover draws one.
  nonce?: string;
  decisionId?: string;
}

/// attestation.json as the prover writes it. Parsed, not validated here: `blindseal verify` is the judge.
export type AttestationJson = Record<string, unknown>;

export interface ProofBackend {
  readonly name: BackendName;
  /// Produce the attestation for `job`. Must reject promptly when `signal` aborts (host shutdown) and
  /// must not copy the payload anywhere outside the directory holding `job.payloadPath`.
  prove(job: ProofJob, signal: AbortSignal): Promise<AttestationJson>;
}

/// Thrown by a backend that is selected in the config but has nothing to run with.
export class BackendNotConfigured extends Error {
  constructor(public readonly backend: BackendName, detail?: string) {
    super(`prover backend "${backend}" is not configured${detail ? `: ${detail}` : ''}`);
    this.name = 'BackendNotConfigured';
  }
}
