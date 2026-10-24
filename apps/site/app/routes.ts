// Route map + dashboard URL, shared by the server-rendered chrome (site-chrome.tsx) and the client
// KitProvider. A plain module on purpose: a server component may not dot into a 'use client' module.
export const ROUTES = { home: '/', how: '/how-it-works', verify: '/verify', docs: '/docs', explorer: '/explorer', changelog: '/changelog' };
// the dashboard is served only by the local proxy (127.0.0.1:7777); the site links nowhere near it
