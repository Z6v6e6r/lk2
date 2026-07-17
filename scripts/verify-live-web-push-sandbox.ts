import { randomUUID } from 'node:crypto';

import { loadConfig } from '@phub/config';
import { createDatabasePool, withTenantTransaction } from '@phub/database';
import { SignJWT } from 'jose';

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .slice(2)
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

const config = loadConfig();
const baseUrl = new URL(argument('base-url') ?? 'http://127.0.0.1:3000');
if (baseUrl.hostname !== '127.0.0.1' && baseUrl.hostname !== 'localhost') {
  throw new Error('Live Web Push smoke is restricted to a loopback API');
}
const tenantKey = argument('tenant-key') ?? 'local-padel';
const tenantId = argument('tenant-id');
const userId = argument('user-id');
if (!tenantId || !userId) throw new Error('--tenant-id and --user-id are required');

const token = await new SignJWT({
  tenants: [tenantId],
  roles: ['client'],
  permissions: ['notifications.write'],
  sid: randomUUID(),
})
  .setProtectedHeader({ alg: 'HS256' })
  .setIssuer(config.JWT_ISSUER)
  .setAudience(config.JWT_AUDIENCE)
  .setSubject(userId)
  .setExpirationTime('5m')
  .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));

const apiRoot = new URL(`/user/api/v1/${encodeURIComponent(tenantKey)}/`, baseUrl);
const installationId = randomUUID();
const endpoint = `https://push.example.test/subscriptions/${randomUUID()}`;
const subscription = {
  endpoint,
  expirationTime: null,
  keys: {
    p256dh: 'B'.repeat(65),
    auth: 'a'.repeat(22),
  },
};
const registrationKey = `web-push-live-register-${randomUUID()}`;
const revocationKey = `web-push-live-revoke-${randomUUID()}`;

function headers(idempotencyKey?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'X-Correlation-ID': randomUUID(),
    'X-App-Platform': 'web',
    'X-App-Version': 'web-push-live-smoke',
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  };
}

async function jsonResponse<T>(response: Response, expectedStatus = 200): Promise<T> {
  const body = (await response.json().catch(() => undefined)) as T | undefined;
  if (response.status !== expectedStatus || body === undefined) {
    throw new Error(`Unexpected ${response.status} from ${response.url}: ${JSON.stringify(body)}`);
  }
  return body;
}

const capabilityResponse = await fetch(new URL('notification-endpoints/web/config', apiRoot), {
  headers: headers(),
  signal: AbortSignal.timeout(5_000),
});
const capability = await jsonResponse<{ enabled: boolean; publicKey?: string }>(capabilityResponse);
if (!capability.enabled || !capability.publicKey) {
  throw new Error('Live Web Push capability is not enabled');
}
if (capabilityResponse.headers.get('cache-control') !== 'no-store') {
  throw new Error('Web Push capability response must not be cached');
}

const inboxResponse = await fetch(new URL('notifications', apiRoot), {
  headers: headers(),
  signal: AbortSignal.timeout(5_000),
});
const inbox = await jsonResponse<{ items: readonly unknown[]; unreadCount: number }>(inboxResponse);
if (!Array.isArray(inbox.items) || !Number.isInteger(inbox.unreadCount)) {
  throw new Error('Notification inbox response is invalid');
}
if (inboxResponse.headers.get('cache-control') !== 'no-store') {
  throw new Error('Notification inbox response must not be cached');
}

const registrationUrl = new URL('notification-endpoints/web', apiRoot);
const registrationResponse = await fetch(registrationUrl, {
  method: 'POST',
  headers: { ...headers(registrationKey), 'Content-Type': 'application/json' },
  body: JSON.stringify({ installationId, subscription }),
  signal: AbortSignal.timeout(5_000),
});
const registration = await jsonResponse<{
  endpointId: string;
  status: string;
  replayed: boolean;
}>(registrationResponse);
if (registration.status !== 'ACTIVE' || registration.replayed) {
  throw new Error('Initial Web Push registration was not active');
}

const replayResponse = await fetch(registrationUrl, {
  method: 'POST',
  headers: { ...headers(registrationKey), 'Content-Type': 'application/json' },
  body: JSON.stringify({ installationId, subscription }),
  signal: AbortSignal.timeout(5_000),
});
const replay = await jsonResponse<{ endpointId: string; replayed: boolean }>(replayResponse);
if (!replay.replayed || replay.endpointId !== registration.endpointId) {
  throw new Error('Web Push registration replay changed the endpoint');
}

const revocationResponse = await fetch(
  new URL(`notification-endpoints/web/${installationId}`, apiRoot),
  {
    method: 'DELETE',
    headers: headers(revocationKey),
    signal: AbortSignal.timeout(5_000),
  },
);
const revocation = await jsonResponse<{ endpointId: string; status: string; replayed: boolean }>(
  revocationResponse,
);
if (
  revocation.status !== 'REVOKED' ||
  revocation.replayed ||
  revocation.endpointId !== registration.endpointId
) {
  throw new Error('Web Push revocation did not preserve endpoint identity');
}

const pool = createDatabasePool(config.DATABASE_URL);
try {
  const databaseState = await withTenantTransaction(pool, tenantId, async (client) => {
    const endpointState = await client.query<{
      status: string;
      address_ciphertext: Buffer;
      encryption_key_id: string;
    }>(
      `select status, address_ciphertext, encryption_key_id
         from integration.notification_endpoints
        where tenant_id = $1 and id = $2`,
      [tenantId, registration.endpointId],
    );
    const runtimeState = await client.query<{
      web_push_enabled: boolean;
      provider_active: boolean;
    }>(
      `select runtime.web_push_enabled,
              exists (
                select 1
                  from integration.notification_provider_accounts provider
                 where provider.tenant_id = runtime.tenant_id
                   and provider.channel = 'PUSH'
                   and provider.platform = 'WEB'
                   and provider.provider = 'WEB_PUSH'
                   and provider.app_id = 'padlhub-web'
                   and provider.environment = 'SANDBOX'
                   and provider.status = 'ACTIVE'
              ) as provider_active
         from notifications.tenant_runtime_settings runtime
        where runtime.tenant_id = $1`,
      [tenantId],
    );
    const commandState = await client.query<{ result_status: string }>(
      `select result_status
         from integration.notification_endpoint_commands
        where tenant_id = $1 and user_id = $2 and installation_id = $3
        order by created_at`,
      [tenantId, userId, installationId],
    );
    return {
      endpoint: endpointState.rows[0],
      runtime: runtimeState.rows[0],
      commands: commandState.rows.map((row) => row.result_status),
    };
  });
  if (
    databaseState.endpoint?.status !== 'REVOKED' ||
    databaseState.endpoint.encryption_key_id !== 'v1' ||
    databaseState.endpoint.address_ciphertext.includes(Buffer.from(endpoint))
  ) {
    throw new Error('Stored Web Push endpoint state is invalid or contains plaintext');
  }
  if (!databaseState.runtime?.web_push_enabled || !databaseState.runtime.provider_active) {
    throw new Error('Tenant or provider Web Push gate is not active');
  }
  if (databaseState.commands.join(',') !== 'ACTIVE,REVOKED') {
    throw new Error('Durable endpoint command states are incorrect');
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'ok',
        tenantKey,
        tenantId,
        userId,
        capabilityEnabled: capability.enabled,
        inboxReadable: true,
        inboxItems: inbox.items.length,
        unreadCount: inbox.unreadCount,
        publicKeyLength: capability.publicKey.length,
        registrationReplayed: replay.replayed,
        endpointStatus: databaseState.endpoint.status,
        endpointKeyId: databaseState.endpoint.encryption_key_id,
        plaintextStored: false,
        commandStates: databaseState.commands,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await pool.end();
}
