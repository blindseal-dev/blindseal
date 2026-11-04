/// The contract between the prover host and a proof backend.
///
/// Self-contained on purpose: it imports nothing from the rest of the service, so a backend can be
/// written and tested against this file alone. A job is a screened payload (a file, so the backend
/// decides how it travels) plus the action the proof binds, exactly the prover's command line
/// (crates/prover/src/main.rs). The result is the attestation the prover wrote. Proving is local to the
/// operator's hardware in every backend: `local` on this host, `vast` on a GPU instance the host rents
/// for one job and destroys.

export type BackendName = 'local' | 'vast';

/// The on-chain action the proof binds, in the form the prover CLI takes it: pubkeys base58, `mint` ''
/// for native SOL, `amount` a decimal u64 string, `instruction` 0x + 16 hex.
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
  /// The slot the attestation expires after, as attestation.json carries it (a number); 2000000000 is
  /// the no-expiry sentinel.
  expirySlot: number;
  /// 0x + 64 hex. When absent the prover draws one.
  nonce?: string;
  decisionId?: string;
}

/// attestation.json as crates/prover writes it (every field the verifier reads, plus `prover`). Parsed,
/// not validated here: `blindseal verify` is the judge.
export interface AttestationJson {
  version: number;
  decisionId: string | null;
  chainId: number;
  payloadHash: string;
  policyRoot: string;
  detectorVersion: string;
  actionHash: string;
  nullifier: string;
  expirySlot: number;
  nonce: string;
  action: { targetProgram: string; sourceAuthority: string; instruction: string; recipient: string; mint: string; amount: string };
  publicInputs: string[];
  proof: { protocol: string; curve: string; bytes: string };
  proveMs: number;
  prover?: { mode: 'cpu' | 'cuda'; host: 'local' | 'vast'; version: string };
  [extra: string]: unknown;
}

export interface ProofBackend {
  readonly name: BackendName;
  /// Produce the attestation for `job`. Must reject promptly when `signal` aborts (host shutdown) and
  /// must not copy the payload anywhere outside the directory holding `job.payloadPath` (the vast backend
  /// copies it to the rented instance it destroys after the job).
  prove(job: ProofJob, signal: AbortSignal): Promise<AttestationJson>;
}

/// Thrown by a backend that is selected in the config but has nothing to run with.
export class BackendNotConfigured extends Error {
  constructor(public readonly backend: BackendName, detail?: string) {
    super(`prover backend "${backend}" is not configured${detail ? `: ${detail}` : ''}`);
    this.name = 'BackendNotConfigured';
  }
}
