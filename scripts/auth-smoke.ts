import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.PHUB_API_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const tenantKey = process.env.PHUB_TENANT_KEY ?? 'local-padel';
const phone = process.env.AUTH_SMOKE_PHONE ?? '+79990000001';
const code = process.env.AUTH_SMOKE_CODE ?? '0000';
const apiRoot = `${baseUrl}/user/api/v1/${encodeURIComponent(tenantKey)}`;

function operationHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'X-Correlation-ID': randomUUID(),
    'Idempotency-Key': randomUUID(),
    'X-App-Platform': 'web',
    'X-App-Version': 'auth-smoke',
    ...extra,
  };
}

async function jsonResponse<T>(response: Response, expectedStatus: number): Promise<T> {
  const body = (await response.json().catch(() => undefined)) as T | undefined;
  if (response.status !== expectedStatus) {
    throw new Error(`Unexpected ${response.status}: ${JSON.stringify(body)}`);
  }
  if (body === undefined) throw new Error(`Expected JSON for ${response.url}`);
  return body;
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  const cookie = setCookie?.split(';', 1)[0];
  if (!cookie?.startsWith('phub_refresh=')) throw new Error('Refresh cookie was not issued');
  return cookie;
}

const challengeResponse = await fetch(`${apiRoot}/auth/challenges`, {
  method: 'POST',
  headers: operationHeaders({ 'Content-Type': 'application/json' }),
  body: JSON.stringify({ method: 'phone_otp', phone }),
});
const challenge = await jsonResponse<{ challengeId: string }>(challengeResponse, 202);

const verifyHeaders = operationHeaders({
  'Content-Type': 'application/json',
  'Idempotency-Key': randomUUID(),
});
const verifyResponse = await fetch(`${apiRoot}/auth/challenges/${challenge.challengeId}/verify`, {
  method: 'POST',
  headers: verifyHeaders,
  body: JSON.stringify({ code }),
});
const verified = await jsonResponse<{
  accessToken: string;
  user: { id: string };
  context: { userId: string; displayName: string };
}>(verifyResponse, 200);
const verifyBody = JSON.stringify(verified);
if (/refreshToken|issuer|subject|viva/i.test(verifyBody)) {
  throw new Error('Authentication response crossed the provider/session boundary');
}
if (verified.user.id !== verified.context.userId) throw new Error('User context is inconsistent');
const firstCookie = cookieFrom(verifyResponse);

const replayedVerifyResponse = await fetch(
  `${apiRoot}/auth/challenges/${challenge.challengeId}/verify`,
  {
    method: 'POST',
    headers: verifyHeaders,
    body: JSON.stringify({ code }),
  },
);
const replayedVerification = await jsonResponse<{ user: { id: string } }>(
  replayedVerifyResponse,
  200,
);
if (
  replayedVerification.user.id !== verified.user.id ||
  cookieFrom(replayedVerifyResponse) !== firstCookie
) {
  throw new Error('Idempotent verification replay changed the created session');
}

const contextResponse = await fetch(`${apiRoot}/context`, {
  headers: operationHeaders({ Authorization: `Bearer ${verified.accessToken}` }),
});
await jsonResponse(contextResponse, 200);

const refreshIdempotencyKey = randomUUID();
const refreshHeaders = operationHeaders({
  Cookie: firstCookie,
  'X-Session-Intent': 'refresh',
  'Content-Type': 'application/json',
  'Idempotency-Key': refreshIdempotencyKey,
});
const refreshResponse = await fetch(`${apiRoot}/auth/session/refresh`, {
  method: 'POST',
  headers: refreshHeaders,
  body: JSON.stringify({}),
});
const refreshed = await jsonResponse<{ accessToken: string; context: { userId: string } }>(
  refreshResponse,
  200,
);
const nextCookie = cookieFrom(refreshResponse);
if (nextCookie === firstCookie) throw new Error('Refresh credential was not rotated');

// Simulate a lost first response: the same old cookie and idempotency key must
// replay the already-created successor instead of revoking the token family.
const replayedRefreshResponse = await fetch(`${apiRoot}/auth/session/refresh`, {
  method: 'POST',
  headers: refreshHeaders,
  body: JSON.stringify({}),
});
await jsonResponse(replayedRefreshResponse, 200);
if (cookieFrom(replayedRefreshResponse) !== nextCookie) {
  throw new Error('Idempotent refresh replay returned a different credential');
}

const refreshedContextResponse = await fetch(`${apiRoot}/context`, {
  headers: operationHeaders({ Authorization: `Bearer ${refreshed.accessToken}` }),
});
await jsonResponse(refreshedContextResponse, 200);

const logoutResponse = await fetch(`${apiRoot}/auth/session`, {
  method: 'DELETE',
  headers: operationHeaders({ Cookie: nextCookie, 'X-Session-Intent': 'logout' }),
});
if (logoutResponse.status !== 204) throw new Error(`Logout failed with ${logoutResponse.status}`);

const revokedRefreshResponse = await fetch(`${apiRoot}/auth/session/refresh`, {
  method: 'POST',
  headers: operationHeaders({
    Cookie: nextCookie,
    'X-Session-Intent': 'refresh',
    'Content-Type': 'application/json',
  }),
  body: JSON.stringify({}),
});
if (revokedRefreshResponse.status !== 401) {
  throw new Error(`Revoked refresh unexpectedly returned ${revokedRefreshResponse.status}`);
}

process.stdout.write(
  JSON.stringify({
    status: 'ok',
    scenario: 'challenge_verify_context_refresh_context_logout',
    tenantKey,
    userId: verified.user.id,
  }) + '\n',
);
