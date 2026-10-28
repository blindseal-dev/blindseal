// Decisions component: renders rows from the §5 contract, filters by verdict, and shows the
// onboarding (empty) and token (unauthorized) states. fetch is mocked — no network, no kit JS.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Decisions } from '../src/pages/Decisions';
import type { Decision } from '../src/api/types';

function dec(id: string, verdict: Decision['verdict']): Decision {
  return {
    id, ts: '2026-10-20T09:00:04.105Z', server: 'slack', tool: 'list_channels', direction: 'response', verdict,
    layers: [{ layer: 'L0', ran: true, verdict: 'pass', latencyMs: 0.5 }, { layer: 'L1', ran: true, verdict, latencyMs: 0.1 }],
    payloadHash: '0x880dcefa96c5ac45dcb65880cf9f83b244d5e5e034c39675b6741ef16e5d3fe7',
    redactedHash: '0x880d', redactions: [], policyRoot: '0x36a9e9', detectorVersion: '0x726faa', auditIndex: 0, auditHash: '0xaed0', latencyMs: 12,
  };
}
const STATUS = { version: '0.0.0-mock', connection: 'live', upstreams: [{ name: 'slack', transport: 'stdio', healthy: true }], policyRoot: '0x36a9e9', detectorVersion: '0x726faa', audit: { index: 199, hash: '0x1', ts: '' }, prover: { available: true }, l3: { mode: 'local' }, mock: true };

function mockFetch(handler: (url: string) => { status: number; body: unknown }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const { status, body } = handler(String(url));
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }));
}
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => { /* each test sets its own mock */ });

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><Decisions /></MemoryRouter></QueryClientProvider>);
}

it('renders decision rows from the contract', async () => {
  mockFetch((u) => u.includes('/status') ? { status: 200, body: STATUS } : { status: 200, body: { items: [dec('a1', 'block'), dec('a2', 'pass')] } });
  const { container } = renderPage();
  await waitFor(() => expect(within(container).getAllByText('list_channels').length).toBe(2));
  const verdicts = Array.from(container.querySelectorAll('.verdict')).map((c) => c.textContent);
  expect(verdicts).toContain('block');
  expect(verdicts).toContain('pass');
});

it('shows onboarding when empty + audit head -1', async () => {
  mockFetch((u) => u.includes('/status') ? { status: 200, body: { ...STATUS, audit: { index: -1, hash: '0x0', ts: '' } } } : { status: 200, body: { items: [] } });
  renderPage();
  await waitFor(() => expect(screen.getByText('No decisions yet.')).toBeTruthy());
});

it('shows the token screen on 401', async () => {
  mockFetch(() => ({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'no token' } } }));
  renderPage();
  await waitFor(() => expect(screen.getByText('Dashboard token required')).toBeTruthy());
});

it('shows a degraded badge on decisions made without layer 2', async () => {
  mockFetch((u) => u.includes('/status') ? { status: 200, body: STATUS } : { status: 200, body: { items: [{ ...dec('d1', 'pass'), degraded: true }, dec('d2', 'pass')] } });
  const { container } = renderPage();
  await waitFor(() => expect(within(container).getAllByText('list_channels').length).toBe(2));
  const rows = Array.from(container.querySelectorAll('tr.d01-row'));
  const badge = (id: string) => rows.find((r) => r.getAttribute('data-id') === id)!.querySelector('.d01-degraded');
  expect(badge('d1')?.textContent).toBe('degraded');
  expect(badge('d2')).toBeNull();
});
