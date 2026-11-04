// GET /explorer/treasury — the Treasury tab's read as JSON, for the offline state's Retry (the page
// itself gets the first snapshot as props from the server component). Same 60 s module cache as the
// page; failures are not cached, so a Retry really re-reads. docs/TREASURY-MEMO.md describes the rows.
import { NextResponse } from 'next/server';
import { getTreasurySnapshot } from '@blindseal/chain-reads';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const snap = await getTreasurySnapshot();
  return NextResponse.json(snap, { headers: { 'cache-control': 'no-store' } });
}
