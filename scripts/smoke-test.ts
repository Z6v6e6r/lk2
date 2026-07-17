import { requestJson, requireJsonField } from './smoke-http.js';

const baseUrl = (process.env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

export {};

const livePath = '/health/live';
const live = await requestJson(baseUrl, livePath, 200);
requireJsonField(livePath, live, 'status', 'ok');
process.stdout.write(`${livePath}: ok\n`);

const readyPath = '/health/ready';
const ready = await requestJson(baseUrl, readyPath, 200);
requireJsonField(readyPath, ready, 'status', 'ready');
process.stdout.write(`${readyPath}: ok\n`);

// These requests are deliberately read-only. Public fails before tenant lookup;
// Admin fails at authentication before tenant resolution. Their stable API
// errors prove that Nginx did not serve the SPA fallback for either boundary.
for (const boundary of [
  {
    path: '/public/api/v1/__smoke_invalid__/games',
    status: 400,
    code: 'TENANT_KEY_INVALID',
  },
  {
    path: '/admin/api/v1/__smoke_invalid__/notifications/capabilities',
    status: 401,
    code: 'AUTH_REQUIRED',
  },
] as const) {
  const body = await requestJson(baseUrl, boundary.path, boundary.status);
  requireJsonField(boundary.path, body, 'code', boundary.code);
  process.stdout.write(`${boundary.path}: ${boundary.code}\n`);
}
