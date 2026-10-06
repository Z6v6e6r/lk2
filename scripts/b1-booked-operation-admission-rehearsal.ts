import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { decodeJwt, importPKCS8, SignJWT } from 'jose';
import { PadlHubApiClient } from '@phub/api-sdk';
import { loadConfig } from '@phub/config';
import {
  createIdentityAuthRepository,
  createSubscriptionRuntimeActorContextRepository,
  createBookedOperationAdmissionTargetRepository,
  withTenantTransaction,
} from '@phub/database';
import { createLogger } from '@phub/observability';
import {
  BookedOperationReadClient,
  BookedOperationAdmissionClient,
  type BookedOperationAdmissionRequest,
} from '@phub/subscription-runtime-adapter';
import { buildApp } from '../apps/api/src/app.js';
import { AuthService } from '../apps/api/src/auth/auth-service.js';
import { MemoryAuthChallengeStore } from '../apps/api/src/auth/challenge-store.js';
import { PostgresAuthRepository } from '../apps/api/src/auth/postgres-auth-repository.js';
import { SubscriptionRuntimeActorDelegationIssuer } from '../apps/api/src/subscriptions/subscription-runtime-actor-delegation-issuer.js';

// Called by the owned physical Mongo test. Synthetic credentials enter through stdin,
// never argv, logs or Git. No AuthService/session repository stub is used.
let raw = '';
for await (const c of process.stdin) {
  raw += String(c);
  assert.ok(raw.length < 24000);
}
const f = z
  .strictObject({
    baseUrl: z.url(),
    pgUrl: z.string(),
    privateKeyPem: z.string(),
    issuer: z.string(),
    audience: z.string(),
    tenantId: z.uuid(),
    tenantKey: z.string(),
    userId: z.uuid(),
    providerClientId: z.string(),
    mappingId: z.uuid(),
    gameId: z.uuid(),
    providerExerciseId: z.string(),
    targetMappingId: z.uuid(),
    startsAt: z.string(),
    durationMinutes: z.number(),
    capacity: z.number(),
    targetVersion: z.string(),
    controlUrl: z.url(),
  })
  .parse(JSON.parse(raw));
const pg = new URL(f.pgUrl);
assert.ok(['127.0.0.1', 'localhost'].includes(pg.hostname));
assert.ok(
  (pg.port === '55439' && pg.pathname === '/b1_admission' && pg.username === 'b1_fixture') ||
    (process.env.GITHUB_ACTIONS === 'true' &&
      pg.port === '5432' &&
      pg.pathname === '/phub' &&
      pg.username === 'phub'),
);
assert.equal(new URL(f.baseUrl).hostname, '127.0.0.1');
assert.equal(new URL(f.controlUrl).hostname, '127.0.0.1');
const admin = new Pool({ connectionString: f.pgUrl, max: 2 });
const role = `b1_admit_${randomUUID().replaceAll('-', '')}`;
const rolePassword = randomUUID();
const runtimeUrl = new URL(f.pgUrl);
runtimeUrl.username = role;
runtimeUrl.password = rolePassword;
const runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 3 });
const foreignUserId = randomUUID();
const stationId = randomUUID();
const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://127.0.0.1:55439/b1_admission',
  REDIS_URL: 'redis://127.0.0.1:6379',
  RABBITMQ_URL: 'amqp://127.0.0.1:5672',
  JWT_ACCESS_SECRET: randomUUID() + randomUUID(),
  JWT_REFRESH_SECRET: randomUUID() + randomUUID(),
  JWT_ISSUER: 'b1-admission-auth',
  JWT_AUDIENCE: 'b1-admission-api',
  BETA_FULL_CLIENT_ACCESS_ENABLED: 'false',
});
const auth = new AuthService({
  config,
  repository: new PostgresAuthRepository(runtime),
  challengeStore: new MemoryAuthChallengeStore(),
  providers: new Map(),
});
const issuer = new SubscriptionRuntimeActorDelegationIssuer({
  privateKeyPem: f.privateKeyPem,
  keyId: 'b1-admission-key',
  issuer: f.issuer,
  audience: f.audience,
  ttlSeconds: 30,
});
const readClient = new BookedOperationReadClient({
  baseUrl: f.baseUrl,
  timeoutMs: 2000,
  environment: 'development',
});
const admissionClient = new BookedOperationAdmissionClient({
  baseUrl: f.baseUrl,
  timeoutMs: 4500,
  environment: 'development',
});
const app = await buildApp({
  config,
  pool: runtime,
  authService: auth,
  logger: createLogger('b1-admission', 'silent'),
  bookedOperationRead: {
    actorContextRepository: createSubscriptionRuntimeActorContextRepository(runtime),
    delegationIssuer: issuer,
    client: readClient,
  },
  bookedOperationAdmission: {
    actorContextRepository: createSubscriptionRuntimeActorContextRepository(runtime),
    targetRepository: createBookedOperationAdmissionTargetRepository(runtime),
    delegationIssuer: issuer,
    client: admissionClient,
  },
});
let roleCreated = false;
let tenantCreated = false;
let baseUrl = '';
const input: BookedOperationAdmissionRequest = {
  action: 'JOIN_GAME',
  target: { id: f.gameId, expectedRevision: 1 },
  paymentIntent: 'USE_SUBSCRIPTION',
};
const key = randomUUID();
const checkError = async (p: Promise<unknown>, status: number) =>
  assert.rejects(p, (e: unknown) =>
    Boolean(e && typeof e === 'object' && 'status' in e && e.status === status),
  );
const control = async (action: string) => {
  const r = await fetch(f.controlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  assert.equal(r.status, 204);
};
try {
  await admin.query(
    `create role ${role} login password '${rolePassword}' nosuperuser nobypassrls noinherit nocreatedb nocreaterole`,
  );
  roleCreated = true;
  await admin.query(`grant usage on schema identity,profile,integration,audit,games to ${role}`);
  await admin.query(
    `grant select on identity.tenants,identity.user_access_profiles,profile.user_summaries,integration.identity_provider_bindings,integration.external_entity_map,games.games to ${role}`,
  );
  await admin.query(`grant select,update on identity.users to ${role}`);
  await admin.query(`grant select,insert,update on identity.refresh_sessions to ${role}`);
  await admin.query(`grant insert on audit.audit_log to ${role}`);
  assert.deepEqual(
    (await runtime.query('select rolsuper,rolbypassrls from pg_roles where rolname=current_user'))
      .rows[0],
    { rolsuper: false, rolbypassrls: false },
  );
  await admin.query(
    `insert into identity.tenants(id,tenant_key,display_name) values($1,$2,'Synthetic admission')`,
    [f.tenantId, f.tenantKey],
  );
  tenantCreated = true;
  await withTenantTransaction(admin, f.tenantId, async (c) => {
    await c.query('insert into identity.users(tenant_id,id) values($1,$2),($1,$3)', [
      f.tenantId,
      f.userId,
      foreignUserId,
    ]);
    for (const user of [f.userId, foreignUserId]) {
      await c.query(
        "insert into profile.user_summaries(tenant_id,user_id,display_name) values($1,$2,'Synthetic principal')",
        [f.tenantId, user],
      );
      await c.query(
        "insert into identity.user_access_profiles(tenant_id,user_id,roles,permissions) values($1,$2,array['client'],array['games.play','profile.read'])",
        [f.tenantId, user],
      );
    }
    await c.query(
      "insert into integration.identity_provider_bindings(tenant_id,provider) values($1,'LOCAL')",
      [f.tenantId],
    );
    await c.query(
      `insert into integration.external_entity_map(id,tenant_id,external_system,entity_type,internal_id,external_id,sync_status,last_synced_at)
      values($1,$2,'VIVA','viva_profile',$3,$4,'synced',now()),($5,$2,'VIVA','viva_profile',$6,$7,'synced',now())`,
      [
        f.mappingId,
        f.tenantId,
        f.userId,
        f.providerClientId,
        randomUUID(),
        foreignUserId,
        `synthetic-${randomUUID()}`,
      ],
    );
    await c.query(
      `insert into games.games(tenant_id,id,organizer_user_id,title,kind,visibility,lifecycle_state,station_id,starts_at,ends_at,timezone,capacity,payment_mode)
      values($1,$2,$3,'Synthetic existing game','FRIENDLY','PUBLIC','SCHEDULED',$4,$5,$6,'Europe/Moscow',$7,'SUBSCRIPTION')`,
      [
        f.tenantId,
        f.gameId,
        f.userId,
        stationId,
        f.startsAt,
        new Date(Date.parse(f.startsAt) + f.durationMinutes * 60000),
        f.capacity,
      ],
    );
    await c.query(
      `insert into integration.external_entity_map(id,tenant_id,external_system,entity_type,internal_id,external_id,external_version,sync_status,last_synced_at)
      values($1,$2,'VIVA','exercise',$3,$4,$5,'synced',now())`,
      [f.targetMappingId, f.tenantId, f.gameId, f.providerExerciseId, f.targetVersion],
    );
  });
  const locker = await admin.connect();
  try {
    await locker.query('begin');
    await locker.query('lock table games.games in access exclusive mode');
    await assert.rejects(
      createBookedOperationAdmissionTargetRepository(runtime).resolve({
        tenantId: f.tenantId,
        targetId: f.gameId,
        expectedRevision: 1,
      }),
      (error: unknown) =>
        Boolean(error && typeof error === 'object' && 'code' in error && error.code === '57014'),
    );
  } finally {
    await locker.query('rollback');
    locker.release();
  }
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  const authenticate = async (userId: string) => {
    const refresh = randomUUID() + randomUUID();
    await createIdentityAuthRepository(admin).createRefreshSession({
      tenantId: f.tenantId,
      userId,
      tokenHash: createHmac('sha256', config.JWT_REFRESH_SECRET).update(refresh).digest('hex'),
      expiresAt: new Date(Date.now() + 3600000),
      correlationId: 'b1-admission-bootstrap',
    });
    const r = await fetch(`${baseUrl}/user/api/v1/${f.tenantKey}/auth/session/refresh`, {
      method: 'POST',
      headers: {
        Cookie: `phub_refresh=${refresh}`,
        'X-Session-Intent': 'refresh',
        'Idempotency-Key': randomUUID(),
        'X-Correlation-ID': randomUUID(),
      },
    });
    assert.equal(r.status, 200);
    const body = z.object({ accessToken: z.string() }).parse(await r.json());
    assert.equal(decodeJwt(body.accessToken).sub, userId);
    return {
      token: body.accessToken,
      sid: String(decodeJwt(body.accessToken).sid),
      sdk: new PadlHubApiClient({
        baseUrl,
        tenantKey: f.tenantKey,
        platform: 'web',
        appVersion: 'b1-admission',
        initialAccessToken: body.accessToken,
      }),
    };
  };
  const actor = await authenticate(f.userId);
  assert.equal(
    await auth.isAccessSessionActive({
      tenantId: f.tenantId,
      userId: f.userId,
      sessionId: actor.sid,
    }),
    true,
  );
  assert.ok(
    await createBookedOperationAdmissionTargetRepository(runtime).resolve({
      tenantId: f.tenantId,
      targetId: f.gameId,
      expectedRevision: 1,
    }),
    'physical canonical game mapping must resolve',
  );
  const first = await actor.sdk.admitBookedOperation(input, key);
  assert.equal(first.status, 'PENDING');
  const repeat = await actor.sdk.admitBookedOperation(input, key);
  assert.deepEqual(repeat, first);
  await control('checkpoint_get');
  assert.deepEqual(await actor.sdk.getBookedOperation(first.operationId), first);
  assert.deepEqual(await actor.sdk.getBookedOperation(first.operationId), first);
  await control('assert_get_unchanged');
  // Concurrent initial commands exercise the Mongo unique _id, not a precreated receipt.
  const raceKey = randomUUID();
  const race = await Promise.all([
    actor.sdk.admitBookedOperation(input, raceKey),
    actor.sdk.admitBookedOperation(input, raceKey),
  ]);
  assert.deepEqual(race[0], race[1]);
  const lostKey = randomUUID();
  await control('lose_next_insert_ack');
  const recovered = await actor.sdk.admitBookedOperation(input, lostKey);
  assert.equal(recovered.status, 'PENDING');
  assert.deepEqual(await actor.sdk.admitBookedOperation(input, lostKey), recovered);
  const responseLostKey = randomUUID();
  await control('lose_next_http_response');
  await assert.rejects(actor.sdk.admitBookedOperation(input, responseLostKey));
  const httpRecovered = await actor.sdk.admitBookedOperation(input, responseLostKey);
  assert.equal(httpRecovered.status, 'PENDING');
  assert.deepEqual(await actor.sdk.getBookedOperation(httpRecovered.operationId), httpRecovered);
  const rotated = await authenticate(f.userId);
  assert.notEqual(rotated.sid, actor.sid);
  assert.deepEqual(await rotated.sdk.admitBookedOperation(input, key), first);
  await withTenantTransaction(admin, f.tenantId, (c) =>
    c.query(
      "update games.games set revision=revision+1,lifecycle_state='CANCELLED',cancellation_reason_code='ORGANIZER_REQUEST',cancelled_by_user_id=organizer_user_id,cancelled_at=now() where id=$1",
      [f.gameId],
    ),
  );
  assert.deepEqual(await actor.sdk.admitBookedOperation(input, key), first);
  await checkError(actor.sdk.admitBookedOperation(input, randomUUID()), 409);
  await withTenantTransaction(admin, f.tenantId, (c) =>
    c.query(
      "update games.games set revision=1,lifecycle_state='SCHEDULED',cancellation_reason_code=null,cancelled_by_user_id=null,cancelled_at=null where id=$1",
      [f.gameId],
    ),
  );
  await control('provider_drift');
  assert.deepEqual(await actor.sdk.admitBookedOperation(input, key), first);
  await control('restore');
  await checkError(
    actor.sdk.admitBookedOperation(
      { ...input, target: { ...input.target, expectedRevision: 2 } },
      key,
    ),
    409,
  );
  await withTenantTransaction(admin, f.tenantId, (c) =>
    c.query(
      "update identity.user_access_profiles set permissions=array['profile.read'] where user_id=$1",
      [foreignUserId],
    ),
  );
  const noPermission = await authenticate(foreignUserId);
  await checkError(noPermission.sdk.admitBookedOperation(input, randomUUID()), 403);
  await withTenantTransaction(admin, f.tenantId, (c) =>
    c.query(
      "update identity.user_access_profiles set permissions=array['games.play','profile.read'] where user_id=$1",
      [foreignUserId],
    ),
  );
  const foreign = await authenticate(foreignUserId);
  await checkError(foreign.sdk.getBookedOperation(first.operationId), 404);
  await withTenantTransaction(admin, f.tenantId, (c) =>
    c.query('update integration.external_entity_map set external_id=$2 where id=$1', [
      f.mappingId,
      `changed-${randomUUID()}`,
    ]),
  );
  await checkError(actor.sdk.admitBookedOperation(input, key), 409);
  await checkError(actor.sdk.getBookedOperation(first.operationId), 404);
  await withTenantTransaction(admin, f.tenantId, (c) =>
    c.query('update integration.external_entity_map set external_id=$2 where id=$1', [
      f.mappingId,
      f.providerClientId,
    ]),
  );
  const direct = await issuer.issueBookedOperationAdmission({
    userId: f.userId,
    tenantId: f.tenantId,
    tenantKey: f.tenantKey,
    sessionId: actor.sid,
    providerClientId: f.providerClientId,
    providerMappingId: f.mappingId,
    providerExerciseId: f.providerExerciseId,
    targetMappingId: f.targetMappingId,
    targetVersion: f.targetVersion,
    startsAt: f.startsAt,
    durationMinutes: f.durationMinutes,
    capacity: f.capacity,
    admissible: true,
    operationId: first.operationId,
    request: input,
    idempotencyKey: key,
    correlationId: 'b1-admission-direct',
  });
  const post = async (token: string, body: unknown = input) =>
    fetch(f.baseUrl + '/lk/integrations/v1/booked-operation-admissions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-ID': 'b1-admission-direct',
        'X-Subscription-Actor-Delegation': token,
      },
      body: JSON.stringify(body),
    });
  const wrongCaller = await new SignJWT({ ...decodeJwt(direct), caller: 'foreign-service' })
    .setProtectedHeader({
      alg: 'RS256',
      typ: 'phub-subscription-runtime-actor-delegation+jwt',
      kid: 'b1-admission-key',
    })
    .sign(await importPKCS8(f.privateKeyPem, 'RS256'));
  assert.equal((await post(wrongCaller)).status, 401);
  const alteredMapping = await new SignJWT({
    ...decodeJwt(direct),
    provider_mapping_id: randomUUID(),
  })
    .setProtectedHeader({
      alg: 'RS256',
      typ: 'phub-subscription-runtime-actor-delegation+jwt',
      kid: 'b1-admission-key',
    })
    .sign(await importPKCS8(f.privateKeyPem, 'RS256'));
  assert.equal((await post(alteredMapping)).status, 409);
  assert.equal((await post(direct, { ...input, actorClientId: f.providerClientId })).status, 400);
  const readToken = await issuer.issueBookedOperationRead({
    userId: f.userId,
    tenantId: f.tenantId,
    tenantKey: f.tenantKey,
    sessionId: actor.sid,
    providerClientId: f.providerClientId,
    providerMappingId: f.mappingId,
    operationId: first.operationId,
    correlationId: 'b1-admission-direct',
  });
  assert.equal((await post(readToken)).status, 401);
  assert.equal(
    (
      await fetch(f.baseUrl + `/lk/integrations/v1/booked-operations/${first.operationId}`, {
        headers: {
          'X-Correlation-ID': 'b1-admission-direct',
          'X-Subscription-Actor-Delegation': direct,
        },
      })
    ).status,
    401,
  );
  await withTenantTransaction(admin, f.tenantId, (c) =>
    c.query("update integration.external_entity_map set sync_status='pending' where id=$1", [
      f.mappingId,
    ]),
  );
  await checkError(actor.sdk.admitBookedOperation(input, key), 503);
  await withTenantTransaction(admin, f.tenantId, (c) =>
    c.query("update integration.external_entity_map set sync_status='synced' where id=$1", [
      f.mappingId,
    ]),
  );
  await withTenantTransaction(admin, f.tenantId, (c) =>
    c.query('update identity.refresh_sessions set revoked_at=now() where id=$1', [actor.sid]),
  );
  await checkError(actor.sdk.admitBookedOperation(input, key), 401);
  await checkError(actor.sdk.getBookedOperation(first.operationId), 401);
  console.log(
    JSON.stringify({
      result: 'PASS',
      path: 'real AuthService refresh -> NOBYPASSRLS PostgreSQL actor/game mapping -> signed admission -> actual owner source -> physical Mongo -> B1 SDK GET',
      acceptedOperations: 4,
      initialReadAndReplay: true,
      getExactNoWriteWindow: true,
      postgresDeadline: true,
      race: true,
      ambiguousInsertAck: true,
      lostHttpResponse: true,
      permissionDenied: true,
      rotatedSessionReplay: true,
      postgresDriftReplay: true,
      providerDriftReplay: true,
      foreignActor: true,
      changedMapping: true,
      wrongScopeAndCaller: true,
      revocation: true,
    }),
  );
} finally {
  await app.close();
  await runtime.end();
  if (tenantCreated) {
    await withTenantTransaction(admin, f.tenantId, async (c) => {
      await c.query('delete from audit.audit_log where tenant_id=$1', [f.tenantId]);
      await c.query('delete from games.games where tenant_id=$1', [f.tenantId]);
      await c.query(
        'update identity.refresh_sessions set rotated_at=null,replaced_by_session_id=null,parent_session_id=null where tenant_id=$1',
        [f.tenantId],
      );
      for (const table of [
        'identity.refresh_sessions',
        'integration.external_entity_map',
        'integration.identity_provider_bindings',
        'identity.user_access_profiles',
        'profile.user_summaries',
        'identity.users',
      ])
        await c.query(`delete from ${table} where tenant_id=$1`, [f.tenantId]);
    });
    await admin.query('delete from identity.tenants where id=$1', [f.tenantId]);
  }
  if (roleCreated) {
    await admin.query(`drop owned by ${role}`);
    await admin.query(`drop role if exists ${role}`);
  }
  await admin.end();
}
