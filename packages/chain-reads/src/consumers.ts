/// Consumer-program bookkeeping, browser-safe (no node: imports) so the site's client components can use it.
/// A Nullifier's consumer_program is the gated program on a CPI, or Pubkey::default() on a DIRECT submission.
/// MIRROR of the same definitions in ./index.ts (see the note there); test/direct.test.ts keeps them in step.

/// Pubkey::default() (32 zero bytes, base58): the verifier's consumer_program on a DIRECT submission —
/// the attestation was consumed by calling the verifier itself (SDK submit / CLI), no gated program.
/// It is a marker, not a program: the explorer must never count or list it as a consumer program.
export const DIRECT_CONSUMER = '11111111111111111111111111111111';
export const isDirectConsumer = (programId: string | undefined | null): boolean => programId === DIRECT_CONSUMER;

/// Public program names. A consumer program shows a name only where one is published; everything
/// else is "No public name" in the explorer. (Pubkey::default() is not a program — see DIRECT_CONSUMER.)
export const KNOWN_PROGRAM_NAMES: Record<string, string> = {
  '9fjiagKZvaJ1cW1zEiddZD6iBemEARKfFQ4dW1mV5FKa': 'transfer-gate (example)',
};

export type ConsumerEntry = { programId: string; count: number; name?: string; direct?: true };

/// consumer_program values (one per Nullifier) → entries, most-consumed first. The raw value is kept;
/// the default key is flagged `direct: true` (a direct submission, no gated program) and carries no name.
export function aggregateConsumers(consumers: Iterable<string>): ConsumerEntry[] {
  const m = new Map<string, number>();
  for (const c of consumers) m.set(c, (m.get(c) ?? 0) + 1);
  return [...m].map(([programId, count]): ConsumerEntry => isDirectConsumer(programId)
    ? { programId, count, direct: true }
    : { programId, count, ...(KNOWN_PROGRAM_NAMES[programId] ? { name: KNOWN_PROGRAM_NAMES[programId] } : {}) })
    .sort((a, b) => b.count - a.count);
}

/// The explorer's view of `consumerPrograms`: real gated programs only (the "Consumer programs" metric and
/// list), and the number of direct submissions shown on their own line.
export function splitConsumers(list: ConsumerEntry[]): { programs: ConsumerEntry[]; direct: number } {
  const programs = list.filter((p) => !p.direct && !isDirectConsumer(p.programId));
  const direct = list.filter((p) => p.direct || isDirectConsumer(p.programId)).reduce((a, p) => a + p.count, 0);
  return { programs, direct };
}

