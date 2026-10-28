// Blindseal local API types. The authoritative
// shapes the proxy serves in mock mode (mock-server.ts) and, later, the real engine.

export type Verdict = 'pass' | 'flag' | 'block';
export type LayerName = 'L0' | 'L1' | 'L2' | 'L3';
export type LayerVerdict = Verdict | 'skip';

export interface Layer {
  layer: LayerName;
  ran: boolean;
  verdict: LayerVerdict;
  ruleIds?: string[];
  score?: number;
  latencyMs: number;
  mode?: 'local' | 'remote';
}

export interface Redaction {
  kind: string;
  count: number;
}

export interface SolanaAction {
  chain: string;
  targetProgram: string;
  instruction: string;
  recipient: string;
  amount: string;
  mint: string;
  sourceAuthority?: string;
  chainId?: number;
}

export interface Decision {
  id: string;
  ts: string;
  server: string;
  tool: string;
  direction: 'request' | 'response';
  verdict: Verdict;
  layers: Layer[];
  payloadHash: string;
  redactedHash: string;
  redactions: Redaction[];
  action?: SolanaAction;
  policyRoot: string;
  detectorVersion: string;
  auditIndex: number;
  auditHash: string;
  latencyMs: number;
  attestationId?: string;
  /** Layer 2 (embeddings) was unavailable for this decision: judged by L3 if configured, else L0/L1. */
  degraded?: boolean;
}

export interface DecisionPage {
  items: Decision[];
  nextCursor?: string;
}

export interface PolicyRule {
  id: string;
  layer: LayerName;
  kind: string;
  name: string;
  severity: 'Malicious' | 'Suspicious';
  verdict: Verdict;
  enabled: boolean;
}

export interface Policy {
  root: string;
  version: number;
  updatedAt: string;
  detectorVersion: string;
  leafCount: number;
  parameters: Record<string, unknown>;
  l0Decoders: string[];
  rules: PolicyRule[];
}

export type AttestationStatus =
  | 'generating'
  | 'generated'
  | 'submitted'
  | 'consumed'
  | 'expired'
  | 'rejected';

export interface Attestation {
  version: number;
  id: string;
  decisionId: string;
  actionHash: string;
  policyRoot: string;
  detectorVersion: string;
  expirySlot: number;
  nullifier: string;
  nonce: string;
  publicInputs: string[];
  proof: { protocol: string; curve: string; bytes: string };
  tee: { mode: string };
  status: AttestationStatus;
  progressPct?: number;
  txSig?: string;
  createdAt: string;
}

export interface AuditHead {
  index: number;
  hash: string;
  ts: string;
}

export interface AuditEntry {
  index: number;
  hash: string;
  prevHash: string;
  ts: string;
  verdict: Verdict;
  decisionId: string;
  payloadHash: string;
}

export interface VerifyResult {
  ok: boolean;
  checkedFrom: number;
  checkedTo: number;
  brokenAt?: number;
}

export interface Disclosure {
  from: number;
  to: number;
  head: AuditHead;
  entries: AuditEntry[];
  signerPubkey: string;
  signature: string;
}

// Matches mock-server.ts `status()` exactly.
export interface Status {
  version: string;
  connection?: 'live' | 'reconnecting' | 'offline';
  uptimeSec: number;
  upstreams: { name: string; transport: string; healthy: boolean }[];
  policyRoot: string;
  detectorVersion: string;
  audit: AuditHead;
  prover: { available: boolean };
  l3: { mode: 'local' | 'tee' | 'off' };
  mock: boolean;
}

// WebSocket /events frames: mock-server broadcasts `{ type, data }`.
export type EventFrame =
  | { type: 'decision'; data: Decision }
  | { type: 'status'; data: Status }
  | { type: 'policy'; data: Policy }
  | { type: 'attestation'; data: Partial<Attestation> & { id: string } };
