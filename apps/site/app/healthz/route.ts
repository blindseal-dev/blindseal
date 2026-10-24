// App Runner health check target: answers on any host (the middleware 301s everything else off the App Runner host).
export const dynamic = 'force-static';
export function GET() { return new Response('ok', { headers: { 'content-type': 'text/plain' } }); }
