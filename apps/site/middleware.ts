import { NextResponse, type NextRequest } from 'next/server';

// One canonical host: the App Runner subdomain and www.blindseal.tech answer only with a permanent redirect
// to https://blindseal.tech, same path and query (the health check excepted).
const CANONICAL_HOST = 'blindseal.tech';
export function middleware(req: NextRequest) {
  const host = (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '').toLowerCase();
  if ((host.endsWith('.awsapprunner.com') || host === `www.${CANONICAL_HOST}`) && req.nextUrl.pathname !== '/healthz') {
    const url = new URL(req.nextUrl.pathname + req.nextUrl.search, `https://${CANONICAL_HOST}`);
    return NextResponse.redirect(url, 301);
  }
  return NextResponse.next();
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
