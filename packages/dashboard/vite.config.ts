import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static bundle served by the proxy (FRONTEND.md §3). No SSR. In dev, /api and /events proxy to
// the local mock API so the dashboard talks to the real contract (mock-server.ts) with no CORS.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', sourcemap: true },
  server: {
    port: 5319,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4831', changeOrigin: true },
      '/events': { target: 'ws://127.0.0.1:4831', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: [],
    // Unit tests live in test/; e2e/ holds Playwright specs (run via `pnpm e2e`, not vitest).
    include: ['test/**/*.{test,spec}.{ts,tsx}'],
  },
});
