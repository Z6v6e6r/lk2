import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { PadlHubApiClient, ApiClientError } from '@phub/api-sdk';
import { loadConfig } from '@phub/config';
import {
  createIdentityAuthRepository,
  createSubscriptionRuntimeActorContextRepository,
  withTenantTransaction,
} from '@phub/database';
import { createLogger } from '@phub/observability';
import { decodeJwt } from 'jose';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { AuthService } from '../auth/auth-service.js';
import { MemoryAuthChallengeStore } from '../auth/challenge-store.js';
import { PostgresAuthRepository } from '../auth/postgres-auth-repository.js';

const task = 'b1-booked-operation-admission-20261006';
function disposableDatabase(): string | undefined {
  const local = process.env.B1_AUTH_TEST_PG_URL;
  if (local) {
    const url = new URL(local);
    if (
      process.env.B1_AUTH_TEST_ACK !== task ||
      url.hostname !== '127.0.0.1' ||
      url.port !== '55439' ||
      url.pathname !== '/b1_admission' ||
      url.username !== 'b1_fixture'
    )
      throw new Error('B1_AUTH_DISPOSABLE_DATABASE_REQUIRED');
    const owned = z
      .array(
        z.object({
          Config: z.object({ Labels: z.record(z.string(), z.string()) }),
          State: z.object({ Running: z.boolean() }),
          Image: z.string(),
          Mounts: z.array(z.object({ Type: z.string(), Name: z.string() })),
          HostConfig: z.object({
            PortBindings: z.record(
              z.string(),
              z.array(z.object({ HostIp: z.string(), HostPort: z.string() })),
            ),
          }),
        }),
      )
      .parse(
        JSON.parse(
          execFileSync('docker', ['inspect', 'b1-admission-pg-20261006'], {
            encoding: 'utf8',
          }),
        ),
      )[0];
    if (
      owned?.Config?.Labels?.['padlhub.task'] !== task ||
      !owned?.State?.Running ||
      owned?.Image !== 'sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea' ||
      owned?.Mounts?.length !== 1 ||
      owned.Mounts[0]?.Type !== 'volume' ||
      owned.Mounts[0]?.Name !== 'b1-admission-pg-20261006-data' ||
      owned.HostConfig.PortBindings?.['5432/tcp']?.[0]?.HostIp !== '127.0.0.1' ||
      owned.HostConfig.PortBindings?.['5432/tcp']?.[0]?.HostPort !== '55439'
    )
      throw new Error('B1_AUTH_OWNED_POSTGRES_REQUIRED');
    return local;
  }
  if (
    process.env.GITHUB_ACTIONS === 'true' &&
    process.env.APP_ENV === 'ci' &&
    process.env.DATABASE_URL
  ) {
    const url = new URL(process.env.DATABASE_URL);
    if (
      !['localhost', '127.0.0.1'].includes(url.hostname) ||
      url.username !== 'phub' ||
      url.pathname !== '/phub' ||
      url.port !== '5432'
    )
      throw new Error('B1_AUTH_CI_DATABASE_REQUIRED');
    return url.toString();
  }
  if (process.env.B1_AUTH_TEST_REQUIRED === '1')
    throw new Error('B1_AUTH_PHYSICAL_FIXTURE_UNAVAILABLE');
  return undefined;
}

const connectionString = disposableDatabase();
const suite = connectionString ? describe : describe.skip;
suite('B1 real AuthService and PostgreSQL authority; admission remains disabled', () => {
  const admin = new Pool({ connectionString, max: 3 });
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const tenantKey = `b1-auth-${tenantId}`;
  const foreignTenantKey = `b1-auth-${foreignTenantId}`;
  const userId = randomUUID();
  const foreignUserId = randomUUID();
  const mappingId = randomUUID();
  const providerClientId = `synthetic-${randomUUID()}`;
  const role = `b1_auth_${randomUUID().replaceAll('-', '')}`;
  let runtime: Pool;
  let auth: AuthService;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let baseUrl: string;
  let accessToken: string;
  let sessionId: string;
  let refreshToken: string;
  let sdk: PadlHubApiClient;
  let contexts: ReturnType<typeof createSubscriptionRuntimeActorContextRepository>;
  const config = loadConfig({
    APP_ENV: 'ci',
    DATABASE_URL: 'postgresql://127.0.0.1:55439/b1_admission',
    REDIS_URL: 'redis://127.0.0.1:6379',
    RABBITMQ_URL: 'amqp://127.0.0.1:5672',
    JWT_ACCESS_SECRET: randomUUID() + randomUUID(),
    JWT_REFRESH_SECRET: randomUUID() + randomUUID(),
    JWT_ISSUER: 'b1-synthetic-auth',
    JWT_AUDIENCE: 'b1-synthetic-api',
    BETA_FULL_CLIENT_ACCESS_ENABLED: 'false',
  });

  beforeAll(async () => {
    const password = randomUUID();
    await admin.query(
      `create role ${role} login password '${password}' nosuperuser nobypassrls noinherit nocreatedb nocreaterole`,
    );
    await admin.query(`grant usage on schema identity, profile, integration, audit to ${role}`);
    await admin.query(
      `grant select on identity.tenants, identity.user_access_profiles, profile.user_summaries,
       integration.identity_provider_bindings, integration.external_entity_map to ${role}`,
    );
    await admin.query(`grant select, update on identity.users to ${role}`);
    await admin.query(`grant select, insert, update on identity.refresh_sessions to ${role}`);
    await admin.query(`grant insert on audit.audit_log to ${role}`);
    const runtimeUrl = new URL(connectionString!);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 3 });
    await admin.query(
      `insert into identity.tenants (id, tenant_key, display_name) values
       ($1, $2, 'Synthetic B1 auth'), ($3, $4, 'Synthetic foreign auth')`,
      [tenantId, tenantKey, foreignTenantId, foreignTenantKey],
    );
    for (const [tenant, user] of [
      [tenantId, userId],
      [foreignTenantId, foreignUserId],
    ]) {
      await withTenantTransaction(admin, tenant!, async (client) => {
        await client.query('insert into identity.users (tenant_id,id) values ($1,$2)', [
          tenant,
          user,
        ]);
        await client.query(
          `insert into profile.user_summaries (tenant_id,user_id,display_name)
           values ($1,$2,'Synthetic principal')`,
          [tenant, user],
        );
        await client.query(
          `insert into identity.user_access_profiles (tenant_id,user_id,roles,permissions)
           values ($1,$2,array['client'],array['games.play','profile.read'])`,
          [tenant, user],
        );
        await client.query(
          `insert into integration.identity_provider_bindings (tenant_id,provider,provider_tenant_key)
           values ($1,'LOCAL',null)`,
          [tenant],
        );
      });
    }
    await withTenantTransaction(admin, tenantId, (client) =>
      client.query(
        `insert into integration.external_entity_map
         (id,tenant_id,external_system,entity_type,internal_id,external_id,sync_status,last_synced_at)
         values ($1,$2,'VIVA','viva_profile',$3,$4,'synced',now())`,
        [mappingId, tenantId, userId, providerClientId],
      ),
    );
    const initialRefresh = randomUUID() + randomUUID();
    await createIdentityAuthRepository(admin).createRefreshSession({
      tenantId,
      userId,
      tokenHash: createHmac('sha256', config.JWT_REFRESH_SECRET)
        .update(initialRefresh)
        .digest('hex'),
      expiresAt: new Date(Date.now() + 3600000),
      correlationId: 'b1-auth-synthetic-bootstrap',
    });
    auth = new AuthService({
      config,
      repository: new PostgresAuthRepository(runtime),
      challengeStore: new MemoryAuthChallengeStore(),
      providers: new Map(),
    });
    contexts = createSubscriptionRuntimeActorContextRepository(runtime);
    app = await buildApp({
      config,
      authService: auth,
      pool: runtime,
      logger: createLogger('b1-auth', 'silent'),
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('B1_AUTH_LOCAL_HTTP_REQUIRED');
    baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/user/api/v1/${tenantKey}/auth/session/refresh`, {
      method: 'POST',
      headers: {
        Cookie: `phub_refresh=${encodeURIComponent(initialRefresh)}`,
        'X-Session-Intent': 'refresh',
        'Idempotency-Key': randomUUID(),
        'X-Correlation-ID': 'b1-auth-synthetic-refresh',
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accessToken: string };
    accessToken = body.accessToken;
    const claims = decodeJwt(accessToken);
    expect(claims.sub).toBe(userId);
    sessionId = String(claims.sid);
    const cookie = response.headers.get('set-cookie')?.match(/phub_refresh=([^;]+)/)?.[1];
    if (!cookie) throw new Error('B1_AUTH_REFRESH_COOKIE_REQUIRED');
    refreshToken = decodeURIComponent(cookie);
    sdk = new PadlHubApiClient({
      baseUrl,
      tenantKey,
      platform: 'web',
      appVersion: 'b1-auth-synthetic',
      initialAccessToken: accessToken,
    });
  }, 15000);

  afterAll(async () => {
    if (app) await app.close();
    if (runtime) await runtime.end();
    for (const tenant of [tenantId, foreignTenantId]) {
      await withTenantTransaction(admin, tenant, async (client) => {
        await client.query('delete from audit.audit_log where tenant_id=$1', [tenant]);
        await client.query(
          `update identity.refresh_sessions set rotated_at=null,replaced_by_session_id=null,parent_session_id=null where tenant_id=$1`,
          [tenant],
        );
        await client.query('delete from identity.refresh_sessions where tenant_id=$1', [tenant]);
        await client.query('delete from integration.external_entity_map where tenant_id=$1', [
          tenant,
        ]);
        await client.query(
          'delete from integration.identity_provider_bindings where tenant_id=$1',
          [tenant],
        );
        await client.query('delete from identity.user_access_profiles where tenant_id=$1', [
          tenant,
        ]);
        await client.query('delete from profile.user_summaries where tenant_id=$1', [tenant]);
        await client.query('delete from identity.users where tenant_id=$1', [tenant]);
      });
    }
    await admin.query('delete from identity.tenants where id=any($1::uuid[])', [
      [tenantId, foreignTenantId],
    ]);
    await admin.query(`drop owned by ${role}`);
    await admin.query(`drop role if exists ${role}`);
    await admin.end();
  });

  it('refreshes through real AuthService and resolves the physical active-session mapping', async () => {
    expect(await auth.isAccessSessionActive({ tenantId, userId, sessionId })).toBe(true);
    expect(await contexts.resolve({ tenantId, userId, sessionId })).toEqual({
      outcome: 'ok',
      providerClientId,
      providerMappingId: mappingId,
    });
    await expect(sdk.getBookedOperation(randomUUID())).rejects.toMatchObject({
      status: 503,
      code: 'BOOKED_OPERATION_READ_DISABLED',
    });
  });
  it('runs under a non-owner NOBYPASSRLS role and cannot read foreign tenant/user authority', async () => {
    const privileges = await runtime.query(
      'select rolsuper,rolbypassrls from pg_roles where rolname=current_user',
    );
    expect(privileges.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    expect(await contexts.resolve({ tenantId: foreignTenantId, userId, sessionId })).toEqual({
      outcome: 'session_inactive',
    });
    expect(await contexts.resolve({ tenantId, userId: foreignUserId, sessionId })).toEqual({
      outcome: 'session_inactive',
    });
    const foreignRows = await withTenantTransaction(runtime, foreignTenantId, (client) =>
      client.query('select id from integration.external_entity_map'),
    );
    expect(foreignRows.rows).toEqual([]);
    const response = await fetch(
      `${baseUrl}/user/api/v1/${foreignTenantKey}/booked-operations/${randomUUID()}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    expect(response.status).toBe(403);
  });
  it('fails closed when the physical provider mapping is unsynced or missing', async () => {
    await withTenantTransaction(admin, tenantId, (client) =>
      client.query("update integration.external_entity_map set sync_status='pending' where id=$1", [
        mappingId,
      ]),
    );
    expect(await contexts.resolve({ tenantId, userId, sessionId })).toEqual({
      outcome: 'provider_mapping_unavailable',
    });
    await withTenantTransaction(admin, tenantId, (client) =>
      client.query('delete from integration.external_entity_map where id=$1', [mappingId]),
    );
    expect(await contexts.resolve({ tenantId, userId, sessionId })).toEqual({
      outcome: 'provider_mapping_unavailable',
    });
  });
  it('rejects forged JWTs and anonymous callers before the owner boundary', async () => {
    const anonymous = await fetch(
      `${baseUrl}/user/api/v1/${tenantKey}/booked-operations/${randomUUID()}`,
    );
    expect(anonymous.status).toBe(401);
    const parts = accessToken.split('.');
    parts[2] = 'invalid-signature';
    const forged = await fetch(
      `${baseUrl}/user/api/v1/${tenantKey}/booked-operations/${randomUUID()}`,
      { headers: { Authorization: `Bearer ${parts.join('.')}` } },
    );
    expect(forged.status).toBe(401);
  });
  it('revokes through the real repository and rejects the previously signed access token', async () => {
    await auth.revokeSession(tenantKey, refreshToken, 'b1-auth-synthetic-revoke', false);
    expect(await auth.isAccessSessionActive({ tenantId, userId, sessionId })).toBe(false);
    await expect(sdk.getBookedOperation(randomUUID())).rejects.toBeInstanceOf(ApiClientError);
    await expect(sdk.getBookedOperation(randomUUID())).rejects.toMatchObject({ status: 401 });
    expect(await contexts.resolve({ tenantId, userId, sessionId })).toEqual({
      outcome: 'session_inactive',
    });
  });
});
