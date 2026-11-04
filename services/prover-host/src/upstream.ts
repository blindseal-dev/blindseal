/// Everything this service borrows from the proxy, imported from its source in one place.
///
/// The `blindseal` package publishes binaries only (no `exports`), so the proven layers and the
/// payload/action binding cannot be imported by package name. They are imported here by path from
/// packages/proxy/src so the host runs the very same code `blindseal attest` runs — a copy would have to
/// be kept byte-for-byte in step with the Rust guest (see the parity gate in CI). If the proxy ever
/// exports these, this is the only file to change.
export { runLayer0, makeLayer0Result } from '../../../packages/proxy/src/detection/layer0-decoder.js';
export { runLayer1 } from '../../../packages/proxy/src/detection/layer1-heuristics.js';
export type { DetectionResult, Verdict } from '../../../packages/proxy/src/detection/types.js';
export {
  BindError, GATED_TRANSFER_DISC, TRANSFER_GATE_ID, actionFromPayload, checkActionBinding,
  type BindErrorCode, type BoundAction,
} from '../../../packages/proxy/src/chain/action-binding.js';
export { ProverUnavailableError, resolveProver } from '../../../packages/proxy/src/prover/resolve.js';
