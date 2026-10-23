// GET /explorer/snapshot — the explorer's read as JSON, for the offline state's Retry (the ready
// page needs no client fetch: the server component passes the first snapshot as props). Same
// 60 s module cache as the page; failures are not cached, so a Retry really re-reads.
import { NextResponse } from 'next/server';
import { getExplorerSnapshot } from '@blindseal/chain-reads';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const snap = await getExplorerSnapshot();
  return NextResponse.json(snap, { headers: { 'cache-control': 'no-store' } });
}
