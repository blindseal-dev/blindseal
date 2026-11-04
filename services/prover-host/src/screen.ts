/// What runs before anyone is charged: the payload/action binding and the proven layers (L0 decode →
/// L1, then L1), exactly as `blindseal attest` runs them, so a payload the guest would refuse is refused
/// here in milliseconds. The guest asserts both, so a proof for anything refused here cannot exist.
import { createHash } from 'node:crypto';
import {
  BindError, GATED_TRANSFER_DISC, TRANSFER_GATE_ID, actionFromPayload, checkActionBinding,
  makeLayer0Result, runLayer0, runLayer1, type BoundAction,
} from './upstream.js';
import { NATIVE_MINT_B58 } from './backends/local.js';

export type RefusalCode = 'unparseable' | 'not-an-action' | 'binding-mismatch' | 'unconsumable' | 'verdict';

export interface Refusal { ok: false; code: RefusalCode; reason: string; verdict?: string; patterns?: string[] }
export interface Screened { ok: true; action: BoundAction; payloadHash: string }
export type ScreenOutcome = Screened | Refusal;

/// `payload` is the exact JSON text the proof commits to (`{"tool":…,"args":…}`).
export function screenPayload(payload: string, overrides: { targetProgram?: string; instruction?: string } = {}): ScreenOutcome {
  let derived: BoundAction;
  let action: BoundAction;
  try {
    derived = actionFromPayload(payload);
    action = checkActionBinding(payload, {
      ...derived,
      targetProgram: overrides.targetProgram ?? derived.targetProgram,
      instruction: overrides.instruction ?? derived.instruction,
    });
  } catch (e) {
    if (!(e instanceof BindError)) throw e;
    if (e.code === 'unparseable') return { ok: false, code: 'unparseable', reason: 'the payload is not a {"tool","args"} JSON object the guest can parse' };
    if (e.code === 'not-an-action') return { ok: false, code: 'not-an-action', reason: 'the call is not a recognizable on-chain action' };
    if (e.code === 'target-program-mismatch' || e.code === 'instruction-mismatch') {
      return { ok: false, code: 'binding-mismatch', reason: `${e.code}: the ${e.code === 'target-program-mismatch' ? 'targetProgram' : 'instruction'} given is not what the call describes` };
    }
    return { ok: false, code: 'not-an-action', reason: `${e.code}: the call does not describe an on-chain action the proof could bind` };
  }
  // transfer-gate executes exactly one thing — gated_transfer of native SOL. Anything else that targets
  // it would bind, but the gate could never consume the proof: refuse before anyone pays for it.
  if (action.targetProgram === TRANSFER_GATE_ID && (action.instruction !== GATED_TRANSFER_DISC || action.mint !== NATIVE_MINT_B58)) {
    return { ok: false, code: 'unconsumable', reason: `transfer-gate only executes gated_transfer (${GATED_TRANSFER_DISC}) of native SOL; this call names instruction ${action.instruction}${action.mint !== NATIVE_MINT_B58 ? ` and mint ${action.mint}` : ''}` };
  }
  const l0 = runLayer0(payload);
  const result = l0.fired ? makeLayer0Result(l0) : runLayer1(payload);
  if (result.verdict !== 'clean') {
    return { ok: false, code: 'verdict', reason: `the proven layers flag this call (${result.detectedPatterns.join(', ')}); the guest would refuse it`, verdict: result.verdict, patterns: result.detectedPatterns };
  }
  return { ok: true, action, payloadHash: '0x' + createHash('sha256').update(payload).digest('hex') };
}
