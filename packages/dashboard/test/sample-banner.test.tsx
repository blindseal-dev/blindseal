// `blindseal run --mock` serves bundled sample data; the dashboard must say so on every page
// (0.7.0, audit #9). Live data (`blindseal run`) shows no banner, and the live policy is read-only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { SampleDataBanner } from '../src/components/SampleDataBanner';
import { Policy } from '../src/pages/Policy';

const STATUS = { version: '0.7.0', connection: 'live', upstreams: [], policyRoot: '0x1', detectorVersion: '0x2', audit: { index: 3, hash: '0x1', ts: '' }, prover: { available: false }, l3: { mode: 'off' } };
const POLICY = { root: '0x36a9', version: 2, updatedAt: '', detectorVersion: '0x72', leafCount: 1, parameters: {}, l0Decoders: [], rules: [{ id: 'r1', layer: 'L1', kind: 'regex', name: 'instruction_override', severity: 'Malicious', verdict: 'block', enabled: true }] };

function mockFetch(handler: (url: string) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(handler(String(url))), { status: 200, headers: { 'Content-Type': 'application/json' } })));
}
afterEach(() => vi.unstubAllGlobals());

function renderWith(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
}

it('--mock: a visible "Sample data" banner', async () => {
  mockFetch(() => ({ ...STATUS, mock: true }));
  renderWith(<SampleDataBanner />);
  await waitFor(() => expect(screen.getByTestId('sample-data-banner').textContent).toMatch(/Sample data/));
});

it('live: no banner', async () => {
  const f = vi.fn(async () => new Response(JSON.stringify({ ...STATUS, mock: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', f);
  renderWith(<SampleDataBanner />);
  await waitFor(() => expect(f).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByTestId('sample-data-banner')).toBeNull();
});

it('live policy: labelled read-only, no Save, toggles disabled', async () => {
  mockFetch((u) => (u.includes('/policy') ? { ...POLICY, readOnly: true, source: '/home/x/.blindseal/policy.json' } : STATUS));
  renderWith(<Policy />);
  await waitFor(() => expect(screen.getByTestId('policy-readonly').textContent).toMatch(/Read-only/));
  expect(screen.queryByText(/Save — recompute root/)).toBeNull();
  expect((screen.getByLabelText('toggle instruction_override') as HTMLInputElement).disabled).toBe(true);
});
