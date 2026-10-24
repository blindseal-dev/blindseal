// RFC 9116 security.txt for the site (the programs carry a neodyme security.txt on chain).
export const dynamic = 'force-static';
export function GET() {
  const body = [
    'Contact: mailto:blindseal@proton.me',
    'Policy: https://github.com/blindseal-dev/blindseal/blob/main/SECURITY.md',
    'Canonical: https://blindseal.tech/.well-known/security.txt',
    'Preferred-Languages: en',
    'Expires: 2027-10-24T00:00:00.000Z',
    '',
  ].join('\n');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
}
