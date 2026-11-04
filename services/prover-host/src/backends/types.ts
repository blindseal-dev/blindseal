/// The one interface every proof backend of the hosted prover implements. A job is a screened payload
/// (a file, so the backend decides how it travels) plus the action the proof binds, exactly the
/// prover's command line (crates/prover/src/main.rs). The result is the attestation the prover wrote.

export interface ProofAction {
  chainId: number;
  targetProgram: string;
  sourceAuthority: string;
  /// instruction discriminator, 16 hex digits (0x-prefixed or not)
  instruction: string;
  recipient: string;
  /// '' for native SOL
  mint: string;
  /// u64 as a decimal string
  amount: string;
}

export interface ProofJob {
  id: string;
  payloadPath: string;
  /// where the attestation is written on this host
  out: string;
  action: ProofAction;
  expirySlot: number;
  /// 64 hex digits; the prover draws one when absent
  nonce?: string;
  decisionId?: string;
}

/// attestation.json as crates/prover writes it (every field the verifier reads, plus `prover`).
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
  prover?: { mode: 'cpu' | 'cuda' | 'network'; host: 'local' | 'vast' | 'network'; version: string };
  [extra: string]: unknown;
}

export interface ProofBackend {
  readonly name: 'local' | 'vast' | 'network';
  prove(job: ProofJob, signal: AbortSignal): Promise<AttestationJson>;
}
