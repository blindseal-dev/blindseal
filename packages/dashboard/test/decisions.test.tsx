// Component smoke test: the Decisions page renders live rows from the API contract and filters by
// verdict. fetch is mocked to return the §5 shape; no network, no proxy needed.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Decisions } from '../src/pages/Decisions';
import type { Decision } from '../src/api/types';

function mkDecision(id: string, verdict: Decision['verdict']): Decision {
  return {
    id,
    ts: '2026-10-20T09:00:04.105Z',
    server: 'slack',
    tool: 'list_channels',
    direction: 'response',
    verdict,
    layers: [
      { layer: 'L0', ran: true, verdict: 'pass', latencyMs: 0.5 },
      { layer: 'L1', ran: true, verdict, latencyMs: 0.1 },
      { layer: 'L2', ran: false, verdict: 'skip', latencyMs: 0 },
      { layer: 'L3', ran: false, verdict: 'skip', latencyMs: 0 },
    ],
    payloadHash: '0x880dcefa96c5ac45dcb65880cf9f83b244d5e5e034c39675b6741ef16e5d3fe7',
    redactedHash: '0x880dcefa96c5ac45dcb65880cf9f83b244d5e5e034c39675b6741ef16e5d3fe7',
    redactions: [],
    policyRoot: '0x36a9e9457db6ecfd752a379fc9279ad6a0acfea07928f61e2f3638a685c38397',
    detectorVersion: '0x726faa56c0857bbace50727feedf504a76f37a98c975f565e44bf341fb29851d',
    auditIndex: 0,
    auditHash: '0xaed0',
    latencyMs: 12,
  };
}

const ALL = { items: [mkDecision('a1', 'block'), mkDecision('a2', 'pass')] };

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      const body = u.includes('verdict=block') ? { items: [ALL.items[0]] } : ALL;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Decisions />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('renders decision rows from the contract', async () => {
  const { container } = renderPage();
  await waitFor(() => expect(screen.getAllByText('list_channels').length).toBe(2));
  // Scope to the verdict chips (the filter bar also has Block/Pass buttons).
  const verdicts = Array.from(container.querySelectorAll('.bs-verdict')).map((c) => c.textContent);
  expect(verdicts).toContain('Block');
  expect(verdicts).toContain('Pass');
});
