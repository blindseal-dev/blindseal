// Route map + dashboard URL, shared by the server-rendered chrome (site-chrome.tsx) and the client
// KitProvider. A plain module on purpose: a server component may not dot into a 'use client' module.
export const ROUTES = { home: '/', how: '/how-it-works', verify: '/verify', docs: '/docs', explorer: '/explorer', changelog: '/changelog' };
export const DASHBOARD_URL = 'http://127.0.0.1:7777';
