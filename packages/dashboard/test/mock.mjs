// Playwright webServer launcher for the mock API. PORT, TOKEN, BLINDSEAL_MOCK_STATE from env.
import { startMockApi } from '../../proxy/src/api/mock-server.ts';
const port = Number(process.env.PORT || 4831);
const token = process.env.TOKEN || 'e2e0000000000000000000000000000000000000000000e2e';
const dashboardDist = process.env.BLINDSEAL_DASHBOARD_DIST || undefined; // served-mode e2e (application/wasm + CSP)
const h = await startMockApi({ port, host: '127.0.0.1', token, fixturesDir: new URL('../../../fixtures', import.meta.url).pathname, emitIntervalMs: 100000, dashboardDist });
console.log('MOCK READY', h.url, 'token=', h.token);
