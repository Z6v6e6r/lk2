import { randomUUID } from 'node:crypto';

const CONFIRMATION = 'I_ACKNOWLEDGE_LOCAL_SYNTHETIC_COMMUNITY_WRITES';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const OPERATION_PATTERN = /^[a-z0-9][a-z0-9-]{7,39}$/;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function operationHeaders(idempotencyKey: string, authorization?: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
    'X-Correlation-ID': randomUUID(),
    'X-App-Platform': 'web',
    'X-App-Version': 'communities-functional-e2e',
    ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
  };
}

async function responseJson<T>(response: Response, expectedStatus: number): Promise<T> {
  const body = (await response.json().catch(() => undefined)) as T | undefined;
  if (response.status !== expectedStatus || body === undefined) {
    const safeCode =
      typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string'
        ? body.code
        : 'UNEXPECTED_RESPONSE';
    throw new Error(`${response.status}:${safeCode}`);
  }
  return body;
}

if (process.env.COMMUNITIES_FUNCTIONAL_E2E_CONFIRM !== CONFIRMATION) {
  throw new Error(`COMMUNITIES_FUNCTIONAL_E2E_CONFIRM must equal ${CONFIRMATION}`);
}
if (process.env.APP_ENV !== 'local') {
  throw new Error('Communities functional E2E provisioning is restricted to APP_ENV=local');
}

const baseUrl = new URL(required('COMMUNITIES_FUNCTIONAL_E2E_API_BASE_URL'));
if (baseUrl.protocol !== 'http:' || !LOOPBACK_HOSTS.has(baseUrl.hostname)) {
  throw new Error('Communities functional E2E API must be a loopback HTTP endpoint');
}
baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '');
baseUrl.search = '';
baseUrl.hash = '';
const tenantKey = required('COMMUNITIES_FUNCTIONAL_E2E_TENANT_KEY');
const phone =
  process.env.COMMUNITIES_FUNCTIONAL_E2E_PHONE?.trim() || required('AUTH_DEV_PHONE_E164');
const code =
  process.env.COMMUNITIES_FUNCTIONAL_E2E_OTP_CODE?.trim() || required('AUTH_DEV_OTP_CODE');
const operation = required('COMMUNITIES_FUNCTIONAL_E2E_OPERATION');
if (!OPERATION_PATTERN.test(operation)) {
  throw new Error('COMMUNITIES_FUNCTIONAL_E2E_OPERATION must be 8-40 lowercase safe characters');
}
const apiRoot = new URL(`/user/api/v1/${encodeURIComponent(tenantKey)}`, baseUrl)
  .toString()
  .replace(/\/$/, '');

const challengeResponse = await fetch(`${apiRoot}/auth/challenges`, {
  method: 'POST',
  headers: operationHeaders(`communities-e2e-challenge-${operation}`),
  body: JSON.stringify({ method: 'phone_otp', phone }),
});
const challenge = await responseJson<{ readonly challengeId: string }>(challengeResponse, 202);

const verifyResponse = await fetch(`${apiRoot}/auth/challenges/${challenge.challengeId}/verify`, {
  method: 'POST',
  headers: operationHeaders(`communities-e2e-verify-${operation}`),
  body: JSON.stringify({
    code,
    acceptance: { publicOfferAccepted: true, personalDataPolicyAccepted: true },
  }),
});
const session = await responseJson<{
  readonly accessToken: string;
  readonly user: { readonly id: string };
  readonly context: { readonly userId: string; readonly permissions: readonly string[] };
}>(verifyResponse, 200);
if (session.user.id !== session.context.userId) throw new Error('AUTH_CONTEXT_INCONSISTENT');
if (!session.context.permissions.includes('communities.create')) {
  process.stdout.write(
    `${JSON.stringify({
      status: 'capability_required',
      tenantKey,
      userId: session.user.id,
      requiredCapability: 'communities.create',
    })}\n`,
  );
  process.exitCode = 2;
} else {
  const createResponse = await fetch(`${apiRoot}/communities`, {
    method: 'POST',
    headers: operationHeaders(`communities-e2e-create-${operation}`, session.accessToken),
    body: JSON.stringify({
      title: `Realtime E2E ${operation}`,
      description: 'Guarded local functional realtime verification',
      visibility: 'PUBLIC',
      joinPolicy: 'INSTANT',
      publishingPreset: 'OPEN_COMMUNITY',
    }),
  });
  const community = await responseJson<{
    readonly id: string;
    readonly revision: number;
    readonly status: string;
  }>(createResponse, 201);
  process.stdout.write(
    `${JSON.stringify({
      status: 'ready',
      tenantKey,
      userId: session.user.id,
      communityId: community.id,
      communityRevision: community.revision,
      communityStatus: community.status,
      replayed: createResponse.headers.get('x-idempotent-replayed') === 'true',
    })}\n`,
  );
}
