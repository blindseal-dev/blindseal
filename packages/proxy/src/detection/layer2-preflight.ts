/// Startup check for Layer 2 (embeddings). Runs before any MCP server is spawned or any port is
/// opened, so a refused start never leaves an orphaned child behind.
///
///   block mode, L2 loads           → start normally (stderr: `layer-2 embeddings: ready`)
///   block mode, L2 fails           → refuse to start (exit code LAYER2_PREFLIGHT_EXIT) unless
///                                    --allow-degraded was passed
///   warn/log mode, L2 fails        → start, with a stderr notice (decisions marked degraded)
import type { BlindsealMode } from '../config.js';
import { warmupLayer2 } from './layer2-embeddings.js';

export const LAYER2_PREFLIGHT_EXIT = 4;

export interface Layer2PreflightResult {
  ok: boolean;
  /// Set when the caller must exit with this code (block mode, no --allow-degraded).
  exitCode?: number;
  error?: string;
}

export async function preflightLayer2(opts: {
  mode: BlindsealMode;
  allowDegraded: boolean;
  warmup?: () => Promise<void>;
  write?: (s: string) => void;
}): Promise<Layer2PreflightResult> {
  const write = opts.write ?? ((s: string) => process.stderr.write(s));
  try {
    await (opts.warmup ?? warmupLayer2)();
    write('blindseal: layer-2 embeddings: ready\n');
    return { ok: true };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300).replace(/\.+$/, '');
    if (opts.mode === 'block' && !opts.allowDegraded) {
      write(
        `blindseal: refusing to start — layer 2 (embedding model) failed to load: ${msg}\n` +
          `blindseal: block mode needs layer 2. Fix the model (network access for the first download, ` +
          `BLINDSEAL_MODEL_DIR / BLINDSEAL_MODEL_HOST for an offline cache or a mirror), or pass ` +
          `--allow-degraded to run with layers 0, 1 and 3 only (decisions are marked degraded).\n`,
      );
      return { ok: false, exitCode: LAYER2_PREFLIGHT_EXIT, error: msg };
    }
    write(
      `blindseal: DEGRADED — layer 2 (embedding model) failed to load: ${msg}. ` +
        `Running with layers 0, 1 and 3 (if configured); decisions are marked degraded.\n`,
    );
    return { ok: false, error: msg };
  }
}
