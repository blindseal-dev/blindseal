// Shared state for the degraded-mode warning.
// Both pipeline.ts and streaming.ts import from here to avoid a circular dependency.

let _missCount = 0;
const REPEAT_EVERY = 100; // re-emit every N L3 misses so the warning stays visible in long-running proxies

const DEGRADED_MSG =
  `blindseal WARNING: Layer 3 (LLM judge) is unavailable — Blindseal is running in DEGRADED MODE.\n` +
  `  Detection rate drops significantly without L3. Set BLINDSEAL_LAYER3_PROVIDER (ollama for a\n` +
  `  local judge; anthropic | openai | custom send redacted text to that provider) to enable it.\n` +
  `  Provider API keys in the environment never enable L3 on their own.\n` +
  `  Suspicious verdicts are kept as-is (not demoted to clean).\n` +
  `  Set BLINDSEAL_L3_FP_SAFE=1 to revert to the old FP-safe behaviour (demote suspicious→clean).\n`;

export function emitDegradedWarningOnce(): void {
  _missCount++;
  if (_missCount === 1 || _missCount % REPEAT_EVERY === 0) {
    process.stderr.write(DEGRADED_MSG);
  }
}

/** Emit at proxy startup when no L3 key is found, before any requests are processed. */
export function emitDegradedWarningAtStartup(): void {
  process.stderr.write(DEGRADED_MSG);
}

/** Test hook — reset so each test starts with a fresh warning state. */
export function _resetDegradedWarningForTesting(): void {
  _missCount = 0;
}
