import { PageHydrated } from '../page-hydrated';
// S05 · Explorer (/explorer) — the mainnet reader. A server component: the read happens here via
// @blindseal/chain-reads (BLINDSEAL_RPC_URL, else the public mainnet RPC; cached 60 s in module
// memory), so the visitor's browser never contacts an RPC. The first snapshot travels as props; the
// server HTML is the mockup's loading state (skeletons, odometers at "0") and never depends on the
// clock, so hydration is deterministic. The page.js port (explorer-view.tsx) paints the data once
// the kit has mounted; Retry (offline) re-reads through /explorer/snapshot.
import type { Metadata } from 'next';
import { getExplorerSnapshot } from '@blindseal/chain-reads';
import { ExplorerView } from './explorer-view';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'Explorer · Blindseal',
  description: 'Attestations consumed on mainnet. Counts and hashes only: no content, no agents, no operators.',
};

export default async function Explorer() {
  const snapshot = await getExplorerSnapshot();
  return (<><ExplorerView snapshot={snapshot} /><PageHydrated /></>);
}
