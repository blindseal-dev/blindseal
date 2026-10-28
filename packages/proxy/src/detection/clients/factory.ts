import { AnthropicJudge } from './anthropic.js';
import { OpenAICompatibleJudge } from './openai-compatible.js';
import { OllamaJudge } from './ollama-client.js';
import type { JudgeClient } from './types.js';

const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';
const DEFAULT_OLLAMA_MODEL = 'llama3.2:3b';
const DEFAULT_OLLAMA_BASE = 'http://localhost:11434';

export const LAYER3_PROVIDERS = ['anthropic', 'openai', 'ollama', 'custom'] as const;
export type Layer3Provider = (typeof LAYER3_PROVIDERS)[number];

/// Which L3 judge is active. `local` = the judge's endpoint is on this machine (loopback);
/// `remote:<provider>` = redacted text leaves the machine for that provider; `off` = no judge.
export interface Layer3Selection {
  mode: 'off' | 'local' | 'remote';
  provider: Layer3Provider | null;
  /// `off` | `local` | `remote:<provider>` — the string printed at startup.
  label: string;
  /// Why L3 is off (missing config), when it is.
  reason?: string;
}

function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^127\./.test(h);
  } catch {
    return false;
  }
}

type Env = Record<string, string | undefined>;

/// L3 is selected ONLY by an explicit BLINDSEAL_LAYER3_PROVIDER. Ambient provider credentials
/// (ANTHROPIC_API_KEY, OPENAI_API_KEY, any *_API_KEY) and OLLAMA_HOST never enable it on their
/// own: an MCP proxy must not start sending tool output to a remote model because a key
/// happens to be in the environment. Once a provider is chosen explicitly, its usual key
/// variable is accepted as the credential.
function resolve(env: Env): { sel: Layer3Selection; client: JudgeClient | null } {
  const off = (reason: string) => ({ sel: { mode: 'off' as const, provider: null, label: 'off', reason }, client: null });
  const provider = env.BLINDSEAL_LAYER3_PROVIDER?.trim().toLowerCase();
  if (!provider || provider === 'off' || provider === 'none') {
    return off('BLINDSEAL_LAYER3_PROVIDER is not set');
  }
  const explicitModel = env.BLINDSEAL_LAYER3_MODEL;
  const explicitBaseUrl = env.BLINDSEAL_LAYER3_BASE_URL;
  const explicitApiKey = env.BLINDSEAL_LAYER3_API_KEY;
  const pick = (p: Layer3Provider, baseUrl: string, client: JudgeClient) => {
    const local = isLoopback(baseUrl);
    return {
      sel: { mode: local ? ('local' as const) : ('remote' as const), provider: p, label: local ? 'local' : `remote:${p}` },
      client,
    };
  };

  if (provider === 'anthropic') {
    const apiKey = explicitApiKey ?? env.ANTHROPIC_API_KEY;
    if (!apiKey) return off('BLINDSEAL_LAYER3_PROVIDER=anthropic but no BLINDSEAL_LAYER3_API_KEY / ANTHROPIC_API_KEY');
    // The Anthropic client always calls the hosted API.
    return {
      sel: { mode: 'remote', provider: 'anthropic', label: 'remote:anthropic' },
      client: new AnthropicJudge({ apiKey, model: explicitModel ?? DEFAULT_ANTHROPIC_MODEL }),
    };
  }

  if (provider === 'openai') {
    const apiKey = explicitApiKey ?? env.OPENAI_API_KEY;
    if (!apiKey) return off('BLINDSEAL_LAYER3_PROVIDER=openai but no BLINDSEAL_LAYER3_API_KEY / OPENAI_API_KEY');
    const baseUrl = explicitBaseUrl ?? DEFAULT_OPENAI_BASE;
    return pick('openai', baseUrl, new OpenAICompatibleJudge({ apiKey, model: explicitModel ?? DEFAULT_OPENAI_MODEL, baseUrl, providerName: 'openai' }));
  }

  if (provider === 'custom') {
    if (!explicitApiKey || !explicitBaseUrl || !explicitModel) {
      return off('BLINDSEAL_LAYER3_PROVIDER=custom needs BLINDSEAL_LAYER3_API_KEY, _BASE_URL and _MODEL');
    }
    return pick('custom', explicitBaseUrl, new OpenAICompatibleJudge({ apiKey: explicitApiKey, model: explicitModel, baseUrl: explicitBaseUrl, providerName: 'custom' }));
  }

  if (provider === 'ollama') {
    const baseUrl = explicitBaseUrl ?? env.OLLAMA_HOST ?? DEFAULT_OLLAMA_BASE;
    return pick('ollama', baseUrl, new OllamaJudge({ model: explicitModel ?? DEFAULT_OLLAMA_MODEL, baseUrl }));
  }

  return off(`unknown BLINDSEAL_LAYER3_PROVIDER "${provider}" (expected ${LAYER3_PROVIDERS.join(' | ')})`);
}

export function createClientFromEnv(env: Env = process.env): JudgeClient | null {
  return resolve(env).client;
}

/// The active L3 selection, without building a client.
export function describeLayer3(env: Env = process.env): Layer3Selection {
  return resolve(env).sel;
}

/// The one line printed to stderr at proxy startup.
export function layer3StartupLine(env: Env = process.env): string {
  const sel = describeLayer3(env);
  if (sel.mode === 'off') return `blindseal: layer-3 judge: off (${sel.reason}; set BLINDSEAL_LAYER3_PROVIDER to enable)\n`;
  if (sel.mode === 'local') return `blindseal: layer-3 judge: local (${sel.provider})\n`;
  return `blindseal: layer-3 judge: ${sel.label} (redacted tool output is sent to this provider)\n`;
}
