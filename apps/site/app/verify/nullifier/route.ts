// Step 4 of the checklist, the one step that touches the network: the nullifier PDA is read on the
// SERVER via @blindseal/chain-reads (BLINDSEAL_RPC_URL), same-origin for the visitor's browser, so
// the site stays zero-egress exactly like the explorer. BLINDSEAL_RPC_URL=off → 503 (the page shows
// "RPC unavailable · try again"). Nothing is logged or stored; the nullifier is already public.
import { NextResponse } from 'next/server';
import { getNullifierStatus, rpcUrl } from '@blindseal/chain-reads';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  const n = new URL(req.url).searchParams.get('n') ?? '';
  if (!/^0x[0-9a-f]{64}$/i.test(n)) return NextResponse.json({ error: 'nullifier must be 0x + 64 hex' }, { status: 400 });
  if (!rpcUrl()) return NextResponse.json({ error: 'reads disabled' }, { status: 503 });
  try {
    return NextResponse.json(await getNullifierStatus(n), { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
