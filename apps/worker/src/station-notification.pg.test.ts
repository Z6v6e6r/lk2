import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, it, expect, afterAll, vi } from 'vitest';
import {
  createNotificationEndpointCipher,
  STATION_MESSAGE_NOTIFICATION as rule,
} from '@phub/notifications';
import { StationMessageNotificationRepository } from '@phub/database/station-message-notifications';
import { stationRequests } from './station-notification-protocol.js';
import { StationNotificationClient } from './station-notification-client.js';
import { projectStationRecipient } from './station-notification-projector.js';
import { runStationDelivery } from './station-notification-delivery.js';
import { runWebPushDeliveryBatch } from './web-push-delivery.js';
import { runApnsDeliveryBatch } from './apns-delivery.js';
import { runFcmDeliveryBatch } from './fcm-delivery.js';
import type { Logger } from 'pino';
const ci = process.env.GITHUB_ACTIONS === 'true' && process.env.APP_ENV === 'ci';
const url = 'postgresql://phub:ci-password@localhost:5432/phub';
if (ci && (process.env.TIMEWEB_STANDARD_DOCKER_VERIFY !== '1' || process.env.DATABASE_URL !== url))
  throw Error('STATION_NOTIFICATION_CI_TARGET_INVALID');
const physical = ci ? describe.sequential : describe.skip;
physical('station notifications: existing PostgreSQL CI service, no provider', () => {
  const pool = new Pool({ connectionString: url, max: 4 }),
    second = new Pool({ connectionString: url, max: 2 });
  const repo = new StationMessageNotificationRepository(pool),
    other = new StationMessageNotificationRepository(second),
    tenants: string[] = [];
  const cipher = createNotificationEndpointCipher({
    serializedKeys: JSON.stringify({ test: Buffer.alloc(32, 8).toString('base64') }),
    activeKeyId: 'test',
  });
  const provider = {
    provider: 'FCM' as const,
    appId: 'station-test',
    environment: 'SANDBOX' as const,
  };
  async function setup(kind: 'FCM' | 'APNS' | 'WEB_PUSH' = 'FCM') {
    const configured = {
      ...provider,
      provider: kind,
      ...(kind === 'APNS' ? { credentialRef: 'synthetic' } : {}),
    };
    const tenant = randomUUID(),
      user = randomUUID(),
      community = randomUUID(),
      source = randomUUID(),
      map = randomUUID(),
      player = 'player-' + randomUUID(),
      stream = randomUUID(),
      account = randomUUID(),
      endpoint = randomUUID(),
      template = randomUUID();
    tenants.push(tenant);
    await pool.query(
      "insert into identity.tenants(id,tenant_key,display_name) values($1,$2,'Synthetic station')",
      [tenant, 'station-' + tenant],
    );
    await repo.tx(tenant, async (c) => {
      await c.query('insert into identity.users(tenant_id,id) values($1,$2)', [tenant, user]);
      await c.query(
        "insert into integration.identity_provider_bindings(tenant_id,provider,provider_tenant_key) values($1,'VIVA','iSkq6G')",
        [tenant],
      );
      for (const [system, entity, internal, external, id] of [
        ['LK_LEGACY', 'community', community, 'community-' + source, map],
        ['VIVA', 'viva_profile', user, player, randomUUID()],
      ])
        await c.query(
          "insert into integration.external_entity_map(tenant_id,id,external_system,entity_type,internal_id,external_id,sync_status,last_synced_at) values($1,$2,$3,$4,$5,$6,'synced',now())",
          [tenant, id, system, entity, internal, external],
        );
      await c.query(
        `insert into notifications.station_message_sources(tenant_id,id,community_id,mapping_id,owner_namespace,private_community_id,incarnation_hash,stream_id,replay_floor,after_sequence,enabled) values($1,$2,$3,$4,'iSkq6G',$5,$6,$7,0,0,true)`,
        [tenant, source, community, map, 'community-' + source, 'sha256:' + 'a'.repeat(64), stream],
      );
      await c.query(
        'insert into notifications.tenant_runtime_settings(tenant_id,in_app_enabled,android_push_enabled,web_push_enabled,ios_push_enabled) values($1,true,true,true,true)',
        [tenant],
      );
      await c.query(
        `insert into notifications.templates(tenant_id,id,template_key,version,category,channels,title_template,body_template,deep_link_template,active) values($1,$2,$3,1,'MESSAGING',array['IN_APP','PUSH'],$4,$5,$6,true)`,
        [tenant, template, rule.templateKey, rule.title, rule.body, rule.deepLink],
      );
      await c.query(
        `insert into notifications.trigger_rules(tenant_id,rule_key,source_event_type,template_id,audience_selector,mandatory,active) values($1,$2,$3,$4,$5::jsonb,false,true)`,
        [
          tenant,
          rule.ruleKey,
          rule.eventType,
          template,
          JSON.stringify({ type: 'EVENT_USERS', field: 'recipientUserIds' }),
        ],
      );
      await c.query(
        "insert into integration.notification_provider_accounts(tenant_id,id,channel,platform,provider,app_id,environment,credential_ref,status) values($1,$2,'PUSH',$3,$4,'station-test','SANDBOX','synthetic','ACTIVE')",
        [tenant, account, kind === 'FCM' ? 'ANDROID' : kind === 'APNS' ? 'IOS' : 'WEB', kind],
      );
      const enc = cipher.encrypt('synthetic-token');
      await c.query(
        "insert into integration.notification_endpoints(tenant_id,id,user_id,provider_account_id,channel,address_ciphertext,address_hash,encryption_key_id) values($1,$2,$3,$4,'PUSH',$5,$6,$7)",
        [
          tenant,
          endpoint,
          user,
          account,
          enc.ciphertext,
          randomUUID().replaceAll('-', '').repeat(2),
          enc.keyId,
        ],
      );
    });
    const s = (await repo.claimSource(tenant))!;
    await repo.storePage(s, {
      throughSequence: 1,
      items: [
        {
          messageId: randomUUID(),
          sequence: 1,
          authorPlayerId: 'author',
          proofHash: 'sha256:' + 'b'.repeat(64),
        },
      ],
      complete: true,
      nextAfterSequence: null,
    });
    const f = (await repo.claimFact(tenant))!;
    await repo.storeRecipients(f, {
      items: [
        { playerId: player, membershipEpoch: 2, baselineSequence: 0, readThroughSequence: 0 },
      ],
      complete: true,
      nextAfterPlayerId: null,
    });
    const recipient = (await repo.claimRecipient(tenant))!;
    const owner = new StationNotificationClient({
      origin: 'https://owner.example.test',
      sign: () => 'synthetic',
      fetch: (input, init) => {
        if (typeof init?.body !== 'string' || typeof input !== 'string')
          throw Error('TEST_INVALID_REQUEST');
        const q = stationRequests.eligibility.parse(JSON.parse(init.body)),
          checkedAtMs = Date.now();
        const body = {
          contract: 'station-notifications.v1',
          requestId: q.requestId,
          ownerNamespace: 'iSkq6G',
          communityId: q.communityId,
          streamId: q.streamId,
          incarnationHash: q.incarnationHash,
          checkedAtMs,
          validUntilMs: checkedAtMs + 5000,
          fact: q.fact,
          recipient: q.recipient,
          outcome: 'ALLOW',
          currentReadThroughSequence: 0,
        };
        const response = new Response(JSON.stringify(body));
        Object.defineProperty(response, 'url', { value: input });
        return Promise.resolve(response);
      },
    });
    return {
      tenant,
      user,
      source,
      player,
      endpoint,
      recipient,
      owner,
      project: () => projectStationRecipient(repo, recipient, true, () => true, [configured]),
    };
  }
  const rows = (tenant: string, sql: string, values: unknown[] = []) =>
    repo.tx(tenant, (c) => c.query<Record<string, unknown>>(sql, [tenant, ...values]));
  afterAll(async () => {
    await second.end();
    try {
      for (const tenant of tenants)
        await repo.tx(tenant, async (c) => {
          for (const table of [
            'audit.outbox_events',
            'audit.audit_log',
            'notifications.delivery_receipts',
            'notifications.delivery_attempts',
            'integration.notification_provider_links',
            'notifications.inbox_items',
            'notifications.deliveries',
            'notifications.intents',
            'notifications.station_message_recipient_outbox',
            'notifications.station_message_facts',
            'notifications.station_message_sources',
            'integration.notification_endpoints',
            'integration.notification_provider_accounts',
            'notifications.trigger_rules',
            'notifications.templates',
            'notifications.user_preferences',
            'notifications.tenant_runtime_settings',
            'integration.external_entity_map',
            'integration.identity_provider_bindings',
            'identity.users',
          ])
            await c.query(`delete from ${table} where tenant_id=$1`, [tenant]);
        });
      for (const t of tenants) await pool.query('delete from identity.tenants where id=$1', [t]);
    } finally {
      await pool.end();
    }
  });
  function latch() {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { wait, release };
  }
  async function waitBlocked(pid: number) {
    for (let i = 0; i < 100; i++) {
      const q = await pool.query<{ blocked: boolean }>(
        'select cardinality(pg_blocking_pids($1))>0 blocked',
        [pid],
      );
      if (q.rows[0]?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw Error('EXPECTED_OWNED_LOCK_WAITER');
  }
  function observedPool(onQuery: (sql: string, pid: number) => Promise<void>) {
    return {
      connect: async () => {
        const c = await pool.connect();
        const pid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid;
        return {
          query: async (sql: string, args?: unknown[]) => {
            const result = await c.query(sql, args);
            await onQuery(sql, pid);
            return result;
          },
          release: () => c.release(),
        };
      },
    } as unknown as Pool;
  }
  it.each(['retarget', 'disable'] as const)(
    'projection identity custody wins before concurrent %s',
    async (kind) => {
      const f = await setup(),
        locked = latch(),
        resume = latch();
      const nextUser = randomUUID();
      await rows(f.tenant, 'insert into identity.users(tenant_id,id) values($1,$2)', [nextUser]);
      const observed = observedPool(async (sql) => {
        if (sql.includes('identity.users') && sql.includes('for share')) {
          locked.release();
          await resume.wait;
        }
      });
      const projection = projectStationRecipient(
        new StationMessageNotificationRepository(observed),
        f.recipient,
        true,
        () => true,
        [provider],
      );
      await locked.wait;
      const writer = await second.connect();
      let mutation: Promise<unknown> | undefined;
      try {
        await writer.query('begin');
        await writer.query("select set_config('app.tenant_id',$1,true)", [f.tenant]);
        const pid = (await writer.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!
          .pid;
        mutation =
          kind === 'retarget'
            ? writer.query(
                "update integration.external_entity_map set internal_id=$2 where tenant_id=$1 and external_system='VIVA' and external_id=$3",
                [f.tenant, nextUser, f.player],
              )
            : writer.query(
                "update identity.users set status='DISABLED' where tenant_id=$1 and id=$2",
                [f.tenant, f.user],
              );
        await waitBlocked(pid);
        resume.release();
        expect(await projection).toBe('PROJECTED');
        await mutation;
        await writer.query('commit');
        expect(
          (
            await rows(
              f.tenant,
              'select recipient_user_id from notifications.intents where tenant_id=$1',
            )
          ).rows,
        ).toEqual([{ recipient_user_id: f.user }]);
      } finally {
        resume.release();
        await projection.catch(() => undefined);
        await mutation?.catch(() => undefined);
        await writer.query('rollback');
        writer.release();
      }
    },
  );
  it.each(['retarget', 'disable'] as const)(
    'original identity rejects concurrent %s committed before projection lock',
    async (kind) => {
      const f = await setup(),
        nextUser = randomUUID();
      const mapping = (
        await rows(
          f.tenant,
          "select id from integration.external_entity_map where tenant_id=$1 and external_system='VIVA' and external_id=$2",
          [f.player],
        )
      ).rows[0]!.id as string;
      await rows(
        f.tenant,
        'update notifications.station_message_recipient_outbox set mapping_id=$2,user_id=$3 where tenant_id=$1',
        [mapping, f.user],
      );
      const pinned = { ...f.recipient, user_id: f.user, recipient_mapping_id: mapping };
      await rows(f.tenant, 'insert into identity.users(tenant_id,id) values($1,$2)', [nextUser]);
      const holder = await second.connect(),
        started = latch();
      let pid = 0;
      const monitored = {
        connect: async () => {
          const c = await pool.connect();
          pid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid;
          started.release();
          return c;
        },
      } as unknown as Pool;
      let pending: Promise<unknown> | undefined;
      try {
        await holder.query('begin');
        await holder.query("select set_config('app.tenant_id',$1,true)", [f.tenant]);
        if (kind === 'retarget')
          await holder.query(
            'update integration.external_entity_map set internal_id=$2 where tenant_id=$1 and id=$3',
            [f.tenant, nextUser, mapping],
          );
        else
          await holder.query(
            "update identity.users set status='DISABLED' where tenant_id=$1 and id=$2",
            [f.tenant, f.user],
          );
        pending = projectStationRecipient(
          new StationMessageNotificationRepository(monitored),
          pinned,
          true,
          () => true,
          [provider],
        );
        if (kind === 'retarget') {
          const failure = expect(pending).rejects.toThrow('STATION_MAPPING_CHANGED');
          await started.wait;
          await waitBlocked(pid);
          await holder.query('commit');
          await failure;
        } else {
          // Existing auth locks user before map. Station yields immediately, never makes auth a deadlock victim.
          await expect(pending).rejects.toMatchObject({ code: '55P03' });
          await holder.query('commit');
          await expect(
            projectStationRecipient(repo, pinned, true, () => true, [provider]),
          ).rejects.toThrow('STATION_RECIPIENT_UNAVAILABLE');
        }
        expect(
          (await rows(f.tenant, 'select id from notifications.intents where tenant_id=$1'))
            .rowCount,
        ).toBe(0);
      } finally {
        await holder.query('rollback');
        await pending?.catch(() => undefined);
        holder.release();
      }
    },
  );
  it('user-first auth custody survives station map-first acceptance; station yields and safely retries', async () => {
    const f = await setup(),
      mapLocked = latch(),
      resume = latch(),
      auth = await second.connect();
    let projection: Promise<unknown> | undefined, authMap: Promise<unknown> | undefined;
    const observed = observedPool(async (sql) => {
      if (
        sql.includes('external_entity_map m') &&
        sql.includes('for share of m') &&
        sql.includes('sync_status')
      ) {
        // Only the VIVA player mapping, after the community map has already been read.
        if (++mapReads === 2) {
          mapLocked.release();
          await resume.wait;
        }
      }
    });
    let mapReads = 0;
    try {
      await auth.query('begin');
      await auth.query("select set_config('app.tenant_id',$1,true)", [f.tenant]);
      const pid = (await auth.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid;
      // Exact resource order used by auth-repository selectExternalUserForUpdate → selectCanonicalProviderUserForUpdate.
      await auth.query('select id from identity.users where tenant_id=$1 and id=$2 for update', [
        f.tenant,
        f.user,
      ]);
      projection = projectStationRecipient(
        new StationMessageNotificationRepository(observed),
        f.recipient,
        true,
        () => true,
        [provider],
      );
      const denied = expect(projection).rejects.toMatchObject({ code: '55P03' });
      await mapLocked.wait;
      authMap = auth.query(
        "select id from integration.external_entity_map where tenant_id=$1 and external_system='VIVA' and entity_type='viva_profile' and external_id=$2 for update",
        [f.tenant, f.player],
      );
      await waitBlocked(pid);
      resume.release();
      await denied;
      await authMap;
      await auth.query('commit');
      expect(
        (await rows(f.tenant, 'select id from notifications.intents where tenant_id=$1')).rowCount,
      ).toBe(0);
      expect(
        (await rows(f.tenant, 'select id from notifications.inbox_items where tenant_id=$1'))
          .rowCount,
      ).toBe(0);
      expect(
        (await rows(f.tenant, 'select id from notifications.deliveries where tenant_id=$1'))
          .rowCount,
      ).toBe(0);
      expect(
        (
          await rows(
            f.tenant,
            'select mapping_id,user_id from notifications.station_message_recipient_outbox where tenant_id=$1',
          )
        ).rows,
      ).toEqual([{ mapping_id: null, user_id: null }]);
      expect(await f.project()).toBe('PROJECTED');
    } finally {
      resume.release();
      await projection?.catch(() => undefined);
      await authMap?.catch(() => undefined);
      await auth.query('rollback');
      auth.release();
    }
  });
  it('projection cannot consume owner budget while waiting for current mapping custody', async () => {
    const f = await setup(),
      holder = await second.connect(),
      started = latch();
    let fresh = true,
      pid = 0;
    const monitored = {
      connect: async () => {
        const c = await pool.connect();
        pid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid;
        started.release();
        return c;
      },
    } as unknown as Pool;
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query('begin');
      await holder.query("select set_config('app.tenant_id',$1,true)", [f.tenant]);
      await holder.query(
        "update integration.external_entity_map set sync_status='synced' where tenant_id=$1 and external_system='VIVA' and external_id=$2",
        [f.tenant, f.player],
      );
      pending = projectStationRecipient(
        new StationMessageNotificationRepository(monitored),
        f.recipient,
        true,
        () => fresh,
        [provider],
      );
      const failure = expect(pending).rejects.toThrow('STATION_AUTHORIZATION_EXPIRED');
      await started.wait;
      await waitBlocked(pid);
      fresh = false;
      await holder.query('commit');
      await failure;
      expect(
        (await rows(f.tenant, 'select id from notifications.intents where tenant_id=$1')).rowCount,
      ).toBe(0);
    } finally {
      await holder.query('rollback');
      await pending?.catch(() => undefined);
      holder.release();
    }
  });
  it('dispatch marker cannot consume owner budget while waiting for mapping custody', async () => {
    const f = await setup();
    await f.project();
    const holder = await second.connect(),
      originalRead = f.owner.read.bind(f.owner),
      began = latch();
    let fresh = true,
      pid = 0;
    vi.spyOn(f.owner, 'read').mockImplementation(async (mode, body) => {
      const result = await originalRead(mode, body);
      await holder.query('begin');
      await holder.query("select set_config('app.tenant_id',$1,true)", [f.tenant]);
      await holder.query(
        "update integration.external_entity_map set sync_status='synced' where tenant_id=$1 and external_system='VIVA' and external_id=$2",
        [f.tenant, f.player],
      );
      began.release();
      return { ...result, fresh: () => fresh };
    });
    const monitored = {
      connect: async () => {
        const c = await pool.connect();
        pid = (await c.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid;
        return c;
      },
    } as unknown as Pool;
    const send = vi.fn(() => Promise.resolve({ outcome: 'accepted' as const }));
    const pending = runStationDelivery(
      new StationMessageNotificationRepository(monitored),
      f.owner,
      f.tenant,
      {
        ...provider,
        cipher,
        maxAttempts: 3,
        retryBaseMs: 1000,
        adapter: { platform: 'ANDROID', send },
      },
    );
    try {
      await began.wait;
      // Policy transaction starts after owner response; observe its actual waiter, not the preceding claim connection.
      for (let i = 0; i < 100; i++) {
        const waiting = await pool.query<{ blocked: boolean }>(
          'select cardinality(pg_blocking_pids($1))>0 blocked',
          [pid],
        );
        if (waiting.rows[0]?.blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await waitBlocked(pid);
      fresh = false;
      await holder.query('commit');
      await pending;
      expect(send).not.toHaveBeenCalled();
      expect(
        (
          await rows(
            f.tenant,
            "select station_dispatch_started_at from notifications.deliveries where tenant_id=$1 and channel='PUSH'",
          )
        ).rows[0]!.station_dispatch_started_at,
      ).toBeNull();
    } finally {
      await holder.query('rollback');
      await pending.catch(() => undefined);
      holder.release();
    }
  });
  it('two projection clients commit one inbox/context/outbox; lost ACK exact replay', async () => {
    const f = await setup();
    const results = await Promise.all([
      f.project(),
      projectStationRecipient(other, f.recipient, true, () => true, [provider]),
    ]);
    expect(results.sort()).toEqual(['PROJECTED', 'STALE']);
    expect(
      (await rows(f.tenant, 'select id from notifications.inbox_items where tenant_id=$1'))
        .rowCount,
    ).toBe(1);
    expect(
      (
        await rows(
          f.tenant,
          "select id from notifications.deliveries where tenant_id=$1 and state='STATION_PENDING'",
        )
      ).rowCount,
    ).toBe(1);
    const publicStates = await rows(
      f.tenant,
      "select payload->>'state' state from audit.outbox_events where tenant_id=$1 and event_type='notifications.delivery.changed.v1'",
    );
    expect(publicStates.rows.map((x) => x.state).sort()).toEqual(['DELIVERED', 'PENDING']);
    expect(await f.project()).toBe('STALE');
  });
  it('projection/audit failure rolls back business state and leaves work recoverable', async () => {
    const f = await setup();
    const bad = {
      connect: async () => {
        const c = await pool.connect();
        return {
          query: (sql: string, args?: unknown[]) =>
            sql.includes('insert into audit.outbox_events')
              ? Promise.reject(Error('synthetic rollback'))
              : c.query(sql, args),
          release: () => c.release(),
        };
      },
    } as unknown as Pool;
    await expect(
      projectStationRecipient(
        new StationMessageNotificationRepository(bad),
        f.recipient,
        true,
        () => true,
        [provider],
      ),
    ).rejects.toThrow();
    expect(
      (await rows(f.tenant, 'select id from notifications.intents where tenant_id=$1')).rowCount,
    ).toBe(0);
    expect(await f.project()).toBe('PROJECTED');
  });
  it('schema floor rejects old siblings, stripping/rebind, and ordinary states after retry', async () => {
    const f = await setup();
    await f.project();
    const intent = (await rows(f.tenant, 'select id from notifications.intents where tenant_id=$1'))
      .rows[0]!.id;
    for (const sql of [
      "insert into notifications.deliveries(tenant_id,intent_id,channel,state,completed_at) values($1,$2,'IN_APP','DELIVERED',now())",
      'update notifications.intents set station_notification_context_id=null where tenant_id=$1 and id=$2',
      'update notifications.deliveries set station_notification_context_id=null where tenant_id=$1 and intent_id=$2',
      "update notifications.deliveries set state='PENDING' where tenant_id=$1 and intent_id=$2 and channel='PUSH'",
    ])
      await expect(rows(f.tenant, sql, [intent])).rejects.toThrow();
    expect(
      (
        await rows(
          f.tenant,
          'select distinct station_notification_context_id from notifications.deliveries where tenant_id=$1',
        )
      ).rows,
    ).toEqual([{ station_notification_context_id: f.recipient.context_id }]);
  });
  it.each(['FCM', 'APNS', 'WEB_PUSH'] as const)(
    'actual old %s worker ignores station initial/retry/expired, but delivers ordinary control',
    async (kind) => {
      const f = await setup(kind);
      await f.project();
      const send = vi.fn().mockResolvedValue({ outcome: 'accepted' }),
        platform =
          kind === 'FCM'
            ? ('ANDROID' as const)
            : kind === 'APNS'
              ? ('IOS' as const)
              : ('WEB' as const);
      const options = {
        pool,
        tenantId: f.tenant,
        appId: provider.appId,
        environment: provider.environment,
        cipher,
        adapter: { platform, send },
        maxAttempts: 3,
        retryBaseMs: 1000,
        logger: { info: vi.fn() } as unknown as Logger,
      };
      const run = () =>
        kind === 'FCM'
          ? runFcmDeliveryBatch(options)
          : kind === 'WEB_PUSH'
            ? runWebPushDeliveryBatch({ ...options, batchSize: 1 })
            : runApnsDeliveryBatch({ ...options, credentialRef: 'synthetic', enabled: true });
      for (const state of ['STATION_PENDING', 'STATION_SENDING']) {
        await rows(
          f.tenant,
          `update notifications.deliveries set state=$2,next_attempt_at=now()-interval '1 hour',lease_expires_at=now()-interval '1 hour' where tenant_id=$1 and channel='PUSH'`,
          [state],
        );
        await run();
      }
      expect(send).not.toHaveBeenCalled();
      await expect(
        rows(
          f.tenant,
          "update notifications.deliveries set scenario_available_at=now() where tenant_id=$1 and channel='PUSH'",
        ),
      ).rejects.toThrow('STATION_SCENARIO_FORBIDDEN');
      const normal = randomUUID();
      await rows(
        f.tenant,
        `insert into notifications.intents(tenant_id,id,recipient_user_id,source_event_id,trigger_rule_id,template_id,dedupe_key,rendered_title,rendered_body,state) select tenant_id,$2,recipient_user_id,$3,trigger_rule_id,template_id,$4,rendered_title,rendered_body,'PROCESSING' from notifications.intents where tenant_id=$1`,
        [normal, randomUUID(), randomUUID()],
      );
      await rows(
        f.tenant,
        "insert into notifications.deliveries(tenant_id,intent_id,endpoint_id,channel) values($1,$2,$3,'PUSH')",
        [normal, f.endpoint],
      );
      await run();
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
  it('current read/leave DENY suppresses before provider with original context retained', async () => {
    const f = await setup();
    await f.project();
    const deny = {
      read: (_m: unknown, q: unknown) =>
        Promise.resolve({
          value: { ...(q as object), outcome: 'DENY' },
          fresh: () => true,
        }),
    } as unknown as StationNotificationClient;
    const send = vi.fn();
    await runStationDelivery(repo, deny, f.tenant, {
      ...provider,
      cipher,
      adapter: { platform: 'ANDROID', send },
      maxAttempts: 3,
      retryBaseMs: 1000,
    });
    expect(send).not.toHaveBeenCalled();
    expect(
      (
        await rows(
          f.tenant,
          "select state from notifications.deliveries where tenant_id=$1 and channel='PUSH'",
        )
      ).rows[0]!.state,
    ).toBe('SUPPRESSED');
  });
  it('network uncertainty retains marker and never retries even after lease passage', async () => {
    const f = await setup();
    await f.project();
    const send = vi
      .fn()
      .mockResolvedValue({ outcome: 'retryable_failure', errorCode: 'FCM_NETWORK_FAILURE' });
    const transport = {
      ...provider,
      cipher,
      adapter: { platform: 'ANDROID' as const, send },
      maxAttempts: 3,
      retryBaseMs: 1000,
    };
    await runStationDelivery(repo, f.owner, f.tenant, transport);
    await runStationDelivery(repo, f.owner, f.tenant, transport);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (
        await rows(
          f.tenant,
          "select state,last_error_code,station_dispatch_started_at from notifications.deliveries where tenant_id=$1 and channel='PUSH'",
        )
      ).rows[0],
    ).toMatchObject({
      state: 'DEAD',
      last_error_code: 'STATION_PROVIDER_OUTCOME_UNKNOWN',
    });
  });
  it('definite circuit refusal retries only station state; generation never decreases', async () => {
    const f = await setup();
    await f.project();
    const send = vi
      .fn()
      .mockResolvedValue({ outcome: 'retryable_failure', errorCode: 'FCM_CIRCUIT_OPEN' });
    const t = {
      ...provider,
      cipher,
      adapter: { platform: 'ANDROID' as const, send },
      maxAttempts: 3,
      retryBaseMs: 1000,
    };
    await runStationDelivery(repo, f.owner, f.tenant, t);
    const d = (
      await rows(
        f.tenant,
        "select * from notifications.deliveries where tenant_id=$1 and channel='PUSH'",
      )
    ).rows[0]!;
    expect(d.state).toBe('STATION_PENDING');
    expect(d.station_dispatch_started_at).toBeNull();
    await rows(
      f.tenant,
      "update notifications.deliveries set next_attempt_at=now() where tenant_id=$1 and channel='PUSH'",
    );
    await runStationDelivery(other, f.owner, f.tenant, t);
    const next = (
      await rows(
        f.tenant,
        "select * from notifications.deliveries where tenant_id=$1 and channel='PUSH'",
      )
    ).rows[0]!;
    expect(Number(next.station_claim_generation)).toBeGreaterThan(
      Number(d.station_claim_generation),
    );
  });
  it('expired dispatched lease becomes UNKNOWN without provider call', async () => {
    const f = await setup();
    await f.project();
    await rows(
      f.tenant,
      "update notifications.deliveries set state='STATION_SENDING',attempt_count=1,station_claim_generation=1,station_dispatch_started_at=now(),lease_expires_at=now()-interval '1 second' where tenant_id=$1 and channel='PUSH'",
    );
    const send = vi.fn();
    await runStationDelivery(repo, f.owner, f.tenant, {
      ...provider,
      cipher,
      adapter: { platform: 'ANDROID', send },
      maxAttempts: 3,
      retryBaseMs: 1000,
    });
    expect(send).not.toHaveBeenCalled();
    expect(
      (
        await rows(
          f.tenant,
          "select last_error_code from notifications.deliveries where tenant_id=$1 and channel='PUSH'",
        )
      ).rows[0]!.last_error_code,
    ).toBe('STATION_PROVIDER_OUTCOME_UNKNOWN');
  });
  it('mapping transfer holds original recipient, no new actor/provider dispatch', async () => {
    const f = await setup();
    await f.project();
    await rows(
      f.tenant,
      "update integration.external_entity_map set sync_status='pending' where tenant_id=$1 and entity_type='viva_profile'",
    );
    const send = vi.fn();
    await runStationDelivery(repo, f.owner, f.tenant, {
      ...provider,
      cipher,
      adapter: { platform: 'ANDROID', send },
      maxAttempts: 3,
      retryBaseMs: 1000,
    });
    expect(send).not.toHaveBeenCalled();
    expect(
      (
        await rows(
          f.tenant,
          "select state,attempt_count,station_claim_generation from notifications.deliveries where tenant_id=$1 and channel='PUSH'",
        )
      ).rows[0],
    ).toMatchObject({ state: 'STATION_PENDING', attempt_count: 0, station_claim_generation: '1' });
  });
  it('missing rule holds work without fake processed source receipt', async () => {
    const f = await setup();
    await rows(f.tenant, 'update notifications.trigger_rules set active=false where tenant_id=$1');
    await expect(f.project()).rejects.toThrow('STATION_RULE_UNAVAILABLE');
    expect(
      (
        await rows(
          f.tenant,
          'select state from notifications.station_message_recipient_outbox where tenant_id=$1',
        )
      ).rows[0]!.state,
    ).toBe('PENDING');
  });
  it('durable fanout exceeds50, missing mappings retain all work and exact cursor', async () => {
    const f = await setup();
    await rows(
      f.tenant,
      'update notifications.station_message_sources set next_attempt_at=now() where tenant_id=$1',
    );
    const source = (await repo.claimSource(f.tenant))!;
    await repo.storePage(source, {
      throughSequence: 2,
      items: [
        {
          messageId: randomUUID(),
          sequence: 2,
          authorPlayerId: 'author',
          proofHash: 'sha256:' + 'c'.repeat(64),
        },
      ],
      complete: true,
      nextAfterSequence: null,
    });
    const a = (await repo.claimFact(f.tenant))!,
      people = Array.from({ length: 101 }, (_, i) => ({
        playerId: 'unmapped-' + String(i).padStart(3, '0'),
        membershipEpoch: 0,
        baselineSequence: 0,
        readThroughSequence: 0,
      }));
    await repo.storeRecipients(a, {
      items: people.slice(0, 50),
      nextAfterPlayerId: people[49]!.playerId,
      complete: false,
    });
    expect(
      await repo.storeRecipients(a, { items: [], nextAfterPlayerId: null, complete: true }),
    ).toBe(false);
    const b = (await other.claimFact(f.tenant))!;
    expect(b.after_player_id).toBe(people[49]!.playerId);
    await other.storeRecipients(b, {
      items: people.slice(50, 100),
      nextAfterPlayerId: people[99]!.playerId,
      complete: false,
    });
    const c = (await repo.claimFact(f.tenant))!;
    await repo.storeRecipients(c, {
      items: people.slice(100),
      nextAfterPlayerId: null,
      complete: true,
    });
    expect(
      (
        await rows(
          f.tenant,
          'select id from notifications.station_message_recipient_outbox where tenant_id=$1 and fact_id=$2',
          [a.fact_id],
        )
      ).rowCount,
    ).toBe(101);
  });
  it('concurrent import claims have one winner; conflicting fact cannot advance cursor', async () => {
    const f = await setup();
    await rows(
      f.tenant,
      'update notifications.station_message_sources set next_attempt_at=now() where tenant_id=$1',
    );
    const claims = await Promise.all([repo.claimSource(f.tenant), other.claimSource(f.tenant)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const source = claims.find(Boolean)!;
    await expect(
      repo.storePage(source, {
        throughSequence: 2,
        items: [
          {
            messageId: f.recipient.message_id,
            sequence: 2,
            authorPlayerId: 'author',
            proofHash: 'sha256:' + 'd'.repeat(64),
          },
        ],
        complete: true,
        nextAfterSequence: null,
      }),
    ).rejects.toThrow('STATION_FACT_CONFLICT');
    expect(
      (
        await rows(
          f.tenant,
          'select after_sequence from notifications.station_message_sources where tenant_id=$1',
        )
      ).rows[0]!.after_sequence,
    ).toBe('1');
  });
  it('accepted provider + final commit ACK loss remains one send after recovery', async () => {
    const f = await setup();
    await f.project();
    let fail = false,
      done = false;
    const wrapped = {
      connect: async () => {
        const c = await pool.connect();
        return {
          query: async (sql: string, args?: unknown[]) => {
            if (sql.includes('insert into notifications.delivery_attempts')) fail = true;
            const result = await c.query(sql, args);
            if (sql === 'commit' && fail && !done) {
              done = true;
              throw Error('synthetic lost ACK');
            }
            return result;
          },
          release: () => c.release(),
        };
      },
    } as unknown as Pool;
    const send = vi.fn().mockResolvedValue({
        outcome: 'accepted',
        externalMessageId: 'synthetic-accepted-' + randomUUID(),
      }),
      t = {
        ...provider,
        cipher,
        adapter: { platform: 'ANDROID' as const, send },
        maxAttempts: 3,
        retryBaseMs: 1000,
      };
    await runStationDelivery(
      new StationMessageNotificationRepository(wrapped),
      f.owner,
      f.tenant,
      t,
    );
    await runStationDelivery(repo, f.owner, f.tenant, t);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (
        await rows(
          f.tenant,
          "select state from notifications.deliveries where tenant_id=$1 and channel='PUSH'",
        )
      ).rows[0]!.state,
    ).toBe('SENT');
  });
  it('marker commit ACK loss never permits first send and recovers only UNKNOWN', async () => {
    const f = await setup();
    await f.project();
    let marked = false,
      done = false;
    const wrapped = {
      connect: async () => {
        const c = await pool.connect();
        return {
          query: async (sql: string, args?: unknown[]) => {
            if (sql.includes('set station_dispatch_started_at=clock_timestamp()')) marked = true;
            const result = await c.query(sql, args);
            if (sql === 'commit' && marked && !done) {
              done = true;
              throw Error('synthetic marker ACK');
            }
            return result;
          },
          release: () => c.release(),
        };
      },
    } as unknown as Pool;
    const send = vi.fn(),
      t = {
        ...provider,
        cipher,
        adapter: { platform: 'ANDROID' as const, send },
        maxAttempts: 3,
        retryBaseMs: 1000,
      };
    await runStationDelivery(
      new StationMessageNotificationRepository(wrapped),
      f.owner,
      f.tenant,
      t,
    );
    expect(send).not.toHaveBeenCalled();
    await rows(
      f.tenant,
      "update notifications.deliveries set lease_expires_at=now()-interval '1 second' where tenant_id=$1 and channel='PUSH'",
    );
    await runStationDelivery(repo, f.owner, f.tenant, t);
    expect(send).not.toHaveBeenCalled();
    expect(
      (
        await rows(
          f.tenant,
          "select last_error_code from notifications.deliveries where tenant_id=$1 and channel='PUSH'",
        )
      ).rows[0]!.last_error_code,
    ).toBe('STATION_PROVIDER_OUTCOME_UNKNOWN');
  });
  it('two dispatchers cannot spend the same generation or duplicate provider call', async () => {
    const f = await setup();
    await f.project();
    let release!: () => void;
    const blocked = new Promise<void>((r) => (release = r)),
      send = vi.fn(async () => {
        await blocked;
        return { outcome: 'accepted' as const };
      }),
      t = {
        ...provider,
        cipher,
        adapter: { platform: 'ANDROID' as const, send },
        maxAttempts: 3,
        retryBaseMs: 1000,
      };
    const first = runStationDelivery(repo, f.owner, f.tenant, t);
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1), {
        timeout: 3000,
        interval: 10,
      });
      expect(await runStationDelivery(other, f.owner, f.tenant, t)).toBe(false);
    } finally {
      release();
      await first;
    }
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('non-superuser RLS denies cross-tenant source read and fact insert', async () => {
    const a = await setup(),
      b = await setup(),
      name = 'station_notif_' + randomUUID().replaceAll('-', ''),
      c = await pool.connect();
    let created = false;
    try {
      await c.query(`create role "${name}" nologin`);
      created = true;
      await c.query(`grant usage on schema notifications to "${name}"`);
      await c.query(`grant select on notifications.station_message_sources to "${name}"`);
      await c.query(`grant insert on notifications.station_message_facts to "${name}"`);
      await c.query('begin');
      await c.query(`set local role "${name}"`);
      await c.query("select set_config('app.tenant_id',$1,true)", [a.tenant]);
      expect(
        (
          await c.query('select id from notifications.station_message_sources where tenant_id=$1', [
            a.tenant,
          ])
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await c.query('select id from notifications.station_message_sources where tenant_id=$1', [
            b.tenant,
          ])
        ).rowCount,
      ).toBe(0);
      await expect(
        c.query(
          `insert into notifications.station_message_facts(tenant_id,id,source_id,sequence,message_id,author_player_id,proof_hash) values($1,$2,$3,2,$4,'author',$5)`,
          [b.tenant, randomUUID(), b.source, randomUUID(), 'sha256:' + 'f'.repeat(64)],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      try {
        await c.query('rollback');
        if (created) {
          await c.query(`drop owned by "${name}"`);
          await c.query(`drop role "${name}"`);
        }
      } finally {
        c.release();
      }
    }
  });
});
