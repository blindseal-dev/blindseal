import { NextResponse, type NextRequest } from 'next/server';

// The App Runner subdomain stays reachable only as a redirect: anything requested on it (except the
// health check) is sent to https://blindseal.tech with the same path and query, permanently.
const CANONICAL_HOST = 'blindseal.tech';
export function middleware(req: NextRequest) {
  const host = (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '').toLowerCase();
  if (host.endsWith('.awsapprunner.com') && req.nextUrl.pathname !== '/healthz') {
    const url = new URL(req.nextUrl.pathname + req.nextUrl.search, `https://${CANONICAL_HOST}`);
    return NextResponse.redirect(url, 301);
  }
  return NextResponse.next();
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
