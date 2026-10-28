/// Which layer-3 judge an eval run uses. The proxy's rule applies here too: L3 runs ONLY when
/// BLINDSEAL_LAYER3_PROVIDER is set (anthropic | openai | ollama | custom). A provider key in
/// the environment (ANTHROPIC_API_KEY, OPENAI_API_KEY) is used as that provider's credential
/// once the provider is chosen, but never enables L3 on its own.
import { describeLayer3, type Layer3Selection } from '../../proxy/src/detection/clients/factory.js';

type Env = Record<string, string | undefined>;

export interface EvalLayer3 {
  selection: Layer3Selection;
  /// One line for the run header / report: "layer-3 judge: remote:anthropic" or "… off (why)".
  line: string;
}

export function evalLayer3(env: Env = process.env): EvalLayer3 {
  const selection = describeLayer3(env);
  const line = selection.mode === 'off'
    ? `layer-3 judge: off (${selection.reason})`
    : `layer-3 judge: ${selection.label}`;
  return { selection, line };
}

/// The preflight message when L3 is required but off; null when L3 is configured.
export function layer3RequiredMessage(env: Env = process.env): string | null {
  const { selection } = evalLayer3(env);
  if (selection.mode !== 'off') return null;
  const ambient = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'].filter((k) => env[k]);
  return (
    `ERROR: layer 3 is off (${selection.reason}).\n` +
    `       Set BLINDSEAL_LAYER3_PROVIDER=anthropic|openai|ollama|custom (with its key, e.g.\n` +
    `       BLINDSEAL_LAYER3_PROVIDER=anthropic ANTHROPIC_API_KEY=…) to evaluate the full pipeline.\n` +
    (ambient.length > 0
      ? `       ${ambient.join(' / ')} is set, but a provider key alone never enables layer 3.\n`
      : '') +
    `       Pass --allow-degraded to run L1+L2 only (results are labeled [DEGRADED]).\n`
  );
}
