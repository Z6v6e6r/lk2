import { randomUUID, createHash, generateKeyPairSync } from 'node:crypto';
import { Pool } from 'pg';
import { describe, it, expect, afterAll, vi } from 'vitest';
import {
  createNotificationEndpointCipher,
  TOURNAMENT_MESSAGE_NOTIFICATION as rule,
} from '@phub/notifications';
import { TournamentMessageNotificationRepository } from '@phub/database/tournament-message-notifications';
import {
  TournamentNotificationOwnerClient,
  TOURNAMENT_FEED_VERSION,
} from './tournament-chat-notification-owner.js';
import { createTournamentNotificationRecipientResolver } from '@phub/database/tournament-notifications';
import {
  tournamentPublication,
  tournamentCandidate,
  type TournamentRecipientRow,
} from '@phub/database/tournament-message-notifications';
import type { PoolClient, QueryResultRow } from 'pg';
import { provisionTournamentSource } from '../../../scripts/provision-tournament-notifications.js';
import { projectTournamentRecipient } from './tournament-notification-projector.js';
import { runTournamentDelivery } from './tournament-notification-delivery.js';
const ci = process.env.GITHUB_ACTIONS === 'true' && process.env.APP_ENV === 'ci';
const url = 'postgresql://phub:ci-password@localhost:5432/phub';
if (ci && (process.env.TIMEWEB_STANDARD_DOCKER_VERIFY !== '1' || process.env.DATABASE_URL !== url))
  throw Error('TOURNAMENT_NOTIFICATION_CI_TARGET_INVALID');
const physical = ci ? describe.sequential : describe.skip;
physical('tournament notifications: existing PostgreSQL CI service, no provider', () => {
  const pool = new Pool({ connectionString: url, max: 4 }),
    second = new Pool({ connectionString: url, max: 2 });
  const repo = new TournamentMessageNotificationRepository(pool),
    other = new TournamentMessageNotificationRepository(second),
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
      tournament = randomUUID(),
      source = randomUUID(),
      map = randomUUID(),
      player = 'player-' + randomUUID(),
      stream = randomUUID(),
      account = randomUUID(),
      endpoint = randomUUID(),
      template = randomUUID();
    tenants.push(tenant);
    await pool.query(
      "insert into identity.tenants(id,tenant_key,display_name) values($1,$2,'Synthetic tournament')",
      [tenant, 'station-' + tenant],
    );
    await repo.tx(tenant, async (c) => {
      await c.query('insert into identity.users(tenant_id,id) values($1,$2)', [tenant, user]);
      await c.query(
        "insert into integration.identity_provider_bindings(tenant_id,provider,provider_tenant_key) values($1,'VIVA','iSkq6G')",
        [tenant],
      );
      await c.query(
        "insert into integration.external_entity_map(tenant_id,id,external_system,entity_type,internal_id,external_id,sync_status,last_synced_at) values($1,$2,'VIVA','viva_profile',$3,$4,'synced',now())",
        [tenant, map, user, player],
      );
      await c.query(
        `insert into notifications.tournament_message_sources(tenant_id,id,tournament_id,owner_namespace,incarnation_hash,stream_id,replay_floor,after_sequence,completed_sequence,enabled) values($1,$2,$3,'iSkq6G',$4,$5,0,0,0,true)`,
        [tenant, source, tournament, 'a'.repeat(64), stream],
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
      const enc = cipher.encrypt(
        kind === 'WEB_PUSH'
          ? JSON.stringify({
              endpoint: 'https://push.example.test/subscription',
              expirationTime: null,
              keys: { p256dh: 'A'.repeat(40), auth: 'B'.repeat(16) },
            })
          : 'synthetic-token',
      );
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
    const fact = {
      tournamentId: tournament,
      incarnationHash: 'a'.repeat(64),
      streamId: stream,
      sequence: 1,
      messageId: randomUUID(),
      authorUserId: randomUUID(),
      factHash: 'b'.repeat(64),
    };
    const witness = { kind: 'ORGANIZER' as const, revision: 1, selectedUserId: user };
    const candidate = {
      witness,
      witnessHash: witnessHash(witness),
      baselineSequence: 0,
      capturedReadThroughSequence: 0,
    };
    const owner = new TournamentNotificationOwnerClient({
      baseUrl: 'https://owner.example.test',
      tenantId: tenant,
      tenantKey: 'station-' + tenant,
      ownerTenantKey: 'iSkq6G',
      issuer: 'synthetic',
      kid: 'test',
      privateKey,
      resolve: createTournamentNotificationRecipientResolver(pool, {
        tenantId: tenant,
        tenantKey: 'station-' + tenant,
        ownerTenantKey: 'iSkq6G',
      }),
      fetchImplementation: (_url, init) => {
        if (typeof init?.body !== 'string') throw Error('SYNTHETIC_REQUEST_INVALID');
        const request = JSON.parse(init.body) as {
          fact: typeof fact;
          candidate: typeof candidate;
          recipient?: typeof candidate;
        };
        const original = request.candidate ?? request.recipient;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              contractVersion: TOURNAMENT_FEED_VERSION,
              fact: request.fact,
              userId: user,
              witnessHash: original.witnessHash,
              baselineSequence: original.baselineSequence,
              decision: 'ALLOW',
              code: 'ELIGIBLE',
              observedAt: Date.now(),
              validUntil: Date.now() + 4500,
            }),
          ),
        );
      },
    });
    const sourceRow = (await repo.claimSource(tenant))!;
    await repo.storePage(sourceRow, {
      tournamentId: tournament,
      incarnationHash: fact.incarnationHash,
      streamId: stream,
      throughSequence: 1,
      facts: [fact],
      nextAfterSequence: null,
      hasMore: false,
    });
    const factRow = (await repo.claimFact(tenant))!;
    const page = {
      fact,
      throughSequence: 1,
      snapshotHash: 'c'.repeat(64),
      candidates: [candidate],
      nextCursor: null,
      hasMore: false,
    };
    const queue = async () => {
      await repo.storeRecipients(factRow, page);
      return (await repo.claimRecipient(tenant))!;
    };
    const project = async (p: TournamentRecipientRow) =>
      projectTournamentRecipient(
        repo,
        p,
        await owner.eligibilityWithIdentity(tournamentPublication(p), tournamentCandidate(p)),
        [configured],
      );
    const send = vi.fn(() =>
      Promise.resolve({
        outcome: 'accepted' as const,
        providerMessageId: 'synthetic-accepted',
      }),
    );
    const transport = {
      ...configured,
      cipher,
      adapter: {
        platform:
          kind === 'FCM'
            ? ('ANDROID' as const)
            : kind === 'APNS'
              ? ('IOS' as const)
              : ('WEB' as const),
        send,
      },
      maxAttempts: 3,
      retryBaseMs: 10,
    };
    return {
      tenant,
      user,
      map,
      player,
      source,
      endpoint,
      configured,
      owner,
      fact,
      factRow,
      candidate,
      page,
      queue,
      project,
      send,
      transport,
    };
  }
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const witnessHash = (w: unknown) =>
    createHash('sha256')
      .update('tournament-chat-witness:v1\0' + JSON.stringify(w))
      .digest('hex');
  const rows = (tenant: string, sql: string, values: unknown[] = []) =>
    repo.tx(tenant, (c) => c.query<Record<string, unknown>>(sql, [tenant, ...values]));
  const counts = async (tenant: string) =>
    (
      await rows(
        tenant,
        `select (select count(*)::int from notifications.intents where tenant_id=$1) intents,(select count(*)::int from notifications.inbox_items where tenant_id=$1) inbox,(select count(*)::int from audit.outbox_events where tenant_id=$1) outbox`,
      )
    ).rows[0];
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
            'notifications.tournament_message_recipient_outbox',
            'notifications.tournament_message_facts',
            'notifications.tournament_message_sources',
            'notifications.ruleset_provision_commands',
            'integration.notification_endpoints',
            'integration.notification_provider_accounts',
            'notifications.trigger_rules',
            'notifications.templates',
            'notifications.user_preferences',
            'notifications.tenant_runtime_settings',
            'identity.user_access_profiles',
            'integration.external_entity_map',
            'integration.identity_provider_bindings',
            'identity.users',
          ])
            await c.query(`delete from ${table} where tenant_id=$1`, [tenant]);
        });
      for (const tenant of tenants)
        await pool.query('delete from identity.tenants where id=$1', [tenant]);
    } finally {
      await pool.end();
    }
  });
  it('stages facts but acknowledges only complete durable fanout, including empty advancing pages', async () => {
    const f = await setup();
    expect(
      (
        await rows(
          f.tenant,
          'select after_sequence,completed_sequence,through_sequence from notifications.tournament_message_sources where tenant_id=$1',
        )
      ).rows[0],
    ).toEqual({ after_sequence: '1', completed_sequence: '0', through_sequence: '1' });
    await repo.storeRecipients(f.factRow, {
      ...f.page,
      candidates: [],
      hasMore: true,
      nextCursor: 'synthetic-cursor',
    });
    expect(
      (
        await rows(
          f.tenant,
          'select completed_sequence from notifications.tournament_message_sources where tenant_id=$1',
        )
      ).rows[0]?.completed_sequence,
    ).toBe('0');
    expect(await repo.claimSource(f.tenant)).toBeNull();
    const next = (await repo.claimFact(f.tenant))!;
    await repo.storeRecipients(next, f.page);
    expect(
      (
        await rows(
          f.tenant,
          'select completed_sequence,through_sequence from notifications.tournament_message_sources where tenant_id=$1',
        )
      ).rows[0],
    ).toEqual({ completed_sequence: '1', through_sequence: null });
    expect((await counts(f.tenant))?.intents).toBe(0);
    expect(await repo.claimRecipient(f.tenant)).not.toBeNull();
  });
  it('snapshot restart retains original candidates and refuses stale lease acknowledgement', async () => {
    const f = await setup();
    await repo.storeRecipients(f.factRow, { ...f.page, hasMore: true, nextCursor: 'old-cursor' });
    const next = (await repo.claimFact(f.tenant))!;
    await expect(
      repo.storeRecipients(next, { ...f.page, snapshotHash: 'd'.repeat(64) }),
    ).rejects.toThrow('TOURNAMENT_SNAPSHOT_CHANGED');
    await repo.restartFact(next);
    expect(await repo.storeRecipients(next, f.page)).toBe(false);
    await rows(
      f.tenant,
      'update notifications.tournament_message_facts set next_attempt_at=now() where tenant_id=$1',
    );
    await repo.storeRecipients((await repo.claimFact(f.tenant))!, {
      ...f.page,
      snapshotHash: 'd'.repeat(64),
    });
    expect(
      (
        await rows(
          f.tenant,
          'select count(*)::int n from notifications.tournament_message_recipient_outbox where tenant_id=$1',
        )
      ).rows[0]?.n,
    ).toBe(1);
  });
  it('rejects malformed witnesses both at repository and SQL boundaries', async () => {
    const f = await setup();
    for (const w of [
      {},
      { kind: null },
      { kind: 'PARTICIPANT' },
      { kind: 'ORGANIZER' },
      { kind: 'ORGANIZER', revision: 0, selectedUserId: f.user },
      { kind: 'ORGANIZER', revision: 1, selectedUserId: f.user, extra: true },
    ]) {
      await expect(
        repo.storeRecipients(f.factRow, {
          ...f.page,
          candidates: [
            {
              ...f.candidate,
              witness: w as typeof f.candidate.witness,
              witnessHash: witnessHash(w),
            },
          ],
        }),
      ).rejects.toThrow('TOURNAMENT_RECIPIENT_INVALID');
      await expect(
        rows(
          f.tenant,
          'insert into notifications.tournament_message_recipient_outbox(tenant_id,id,fact_id,witness,witness_hash,baseline_sequence,read_through_sequence) values($1,$2,$3,$4::jsonb,$5,0,0)',
          [randomUUID(), f.factRow.fact_id, JSON.stringify(w), witnessHash(w)],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
    expect(
      (
        await rows(
          f.tenant,
          'select completed_sequence from notifications.tournament_message_sources where tenant_id=$1',
        )
      ).rows[0]?.completed_sequence,
    ).toBe('0');
  });
  it('globally deduplicates one canonical user across more than 50 original witnesses', async () => {
    const f = await setup();
    const candidates = Array.from({ length: 51 }, (_, i) => {
      const witness = { ...f.candidate.witness, revision: i + 1 };
      return { ...f.candidate, witness, witnessHash: witnessHash(witness) };
    });
    await repo.storeRecipients(f.factRow, {
      ...f.page,
      candidates: candidates.slice(0, 50),
      hasMore: true,
      nextCursor: 'page-2',
    });
    await repo.storeRecipients((await repo.claimFact(f.tenant))!, {
      ...f.page,
      candidates: candidates.slice(50),
    });
    const first = (await repo.claimRecipient(f.tenant))!;
    expect(await f.project(first)).toBe('PROJECTED');
    expect(await f.project(first)).toBe('STALE');
    for (let i = 0; i < 50; i++)
      expect(await f.project((await repo.claimRecipient(f.tenant))!)).toBe('SUPPRESSED');
    expect(await counts(f.tenant)).toEqual({ intents: 1, inbox: 1, outbox: 4 });
    expect(
      (
        await rows(
          f.tenant,
          'select count(*)::int n from notifications.tournament_message_recipient_outbox where tenant_id=$1 and user_id=$2',
          [f.user],
        )
      ).rows[0]?.n,
    ).toBe(1);
  }, 30000);
  it('DENY cannot later bind identity or reserve the canonical user for another original context', async () => {
    const f = await setup();
    const w = { ...f.candidate.witness, revision: 2 };
    await repo.storeRecipients(f.factRow, {
      ...f.page,
      candidates: [f.candidate, { ...f.candidate, witness: w, witnessHash: witnessHash(w) }],
    });
    const p = (await repo.claimRecipient(f.tenant))!;
    const proof = await f.owner.eligibilityWithIdentity(
      tournamentPublication(p),
      tournamentCandidate(p),
    );
    expect(
      await projectTournamentRecipient(
        repo,
        p,
        {
          ...proof,
          observation: { ...proof.observation, decision: 'DENY', code: 'CURRENT_CONTEXT_CHANGED' },
        },
        [f.configured],
      ),
    ).toBe('SUPPRESSED');
    await expect(
      rows(
        f.tenant,
        'update notifications.tournament_message_recipient_outbox set mapping_id=$3,user_id=$4,provider_client_id=$5 where tenant_id=$1 and id=$2',
        [p.context_id, f.map, f.user, f.player],
      ),
    ).rejects.toThrow('TOURNAMENT_RECIPIENT_IMMUTABLE');
    expect(await f.project((await repo.claimRecipient(f.tenant))!)).toBe('PROJECTED');
  });
  it('two independent claimers cannot project the same recipient twice', async () => {
    const f = await setup();
    await repo.storeRecipients(f.factRow, f.page);
    const claims = await Promise.all([
      repo.claimRecipient(f.tenant),
      other.claimRecipient(f.tenant),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const p = claims.find(Boolean)!;
    const proof = await f.owner.eligibilityWithIdentity(
      tournamentPublication(p),
      tournamentCandidate(p),
    );
    const outcomes = await Promise.all([
      projectTournamentRecipient(repo, p, proof, [f.configured]),
      projectTournamentRecipient(other, p, proof, [f.configured]),
    ]);
    expect(outcomes.sort()).toEqual(['PROJECTED', 'STALE']);
    expect(await counts(f.tenant)).toEqual({ intents: 1, inbox: 1, outbox: 4 });
  });
  // Inject failure inside a real PostgreSQL transaction; never mock COMMIT/ROLLBACK semantics.
  function intercept(base: Pool, onQuery: (sql: string) => void): Pool {
    return {
      connect: async () => {
        const client = await base.connect();
        return {
          query: <T extends QueryResultRow>(sql: string, values?: unknown[]) => {
            onQuery(sql);
            return client.query<T>(sql, values);
          },
          release: () => client.release(),
        } as PoolClient;
      },
    } as Pool;
  }
  it('expiry during inbox writes rolls back identity, intent, inbox and outbox atomically', async () => {
    const f = await setup(),
      p = await f.queue();
    let fresh = true;
    const checked = new TournamentMessageNotificationRepository(
      intercept(pool, (sql) => {
        if (sql.includes('insert into notifications.inbox_items')) fresh = false;
      }),
    );
    const proof = await f.owner.eligibilityWithIdentity(
      tournamentPublication(p),
      tournamentCandidate(p),
    );
    await expect(
      projectTournamentRecipient(checked, p, { ...proof, fresh: () => fresh }, [f.configured]),
    ).rejects.toThrow('TOURNAMENT_AUTHORIZATION_EXPIRED');
    expect(await counts(f.tenant)).toEqual({ intents: 0, inbox: 0, outbox: 0 });
    expect(
      (
        await rows(
          f.tenant,
          'select user_id,state from notifications.tournament_message_recipient_outbox where tenant_id=$1',
        )
      ).rows[0],
    ).toEqual({ user_id: null, state: 'PENDING' });
  });
  it('audit failure rolls back projection and an exact retry creates only one result', async () => {
    const f = await setup(),
      p = await f.queue();
    let fail = true;
    const checked = new TournamentMessageNotificationRepository(
      intercept(pool, (sql) => {
        if (fail && sql.includes('insert into audit.audit_log')) {
          fail = false;
          throw Error('SYNTHETIC_AUDIT_FAILURE');
        }
      }),
    );
    const proof = await f.owner.eligibilityWithIdentity(
      tournamentPublication(p),
      tournamentCandidate(p),
    );
    await expect(projectTournamentRecipient(checked, p, proof, [f.configured])).rejects.toThrow(
      'SYNTHETIC_AUDIT_FAILURE',
    );
    expect(await counts(f.tenant)).toEqual({ intents: 0, inbox: 0, outbox: 0 });
    expect(await f.project(p)).toBe('PROJECTED');
  });
  it.each(['FCM', 'APNS', 'WEB_PUSH'] as const)(
    'sends generic %s preview only after a fresh original-context check',
    async (kind) => {
      const f = await setup(kind);
      await f.project(await f.queue());
      await runTournamentDelivery(repo, f.owner, f.tenant, f.transport);
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.send.mock.calls[0]).toBeDefined();
      expect(
        (
          await rows(
            f.tenant,
            "select state,tournament_dispatch_started_at from notifications.deliveries where tenant_id=$1 and channel='PUSH'",
          )
        ).rows[0],
      ).toMatchObject({ state: 'SENT' });
      expect(await runTournamentDelivery(repo, f.owner, f.tenant, f.transport)).toBe(false);
    },
  );
  it('ambiguous provider outcome is terminal and never resent', async () => {
    const f = await setup();
    await f.project(await f.queue());
    f.send.mockRejectedValueOnce(Error('ACCEPTED_BUT_RESPONSE_LOST'));
    await runTournamentDelivery(repo, f.owner, f.tenant, f.transport);
    expect(
      (
        await rows(
          f.tenant,
          "select state,last_error_code from notifications.deliveries where tenant_id=$1 and channel='PUSH'",
        )
      ).rows[0],
    ).toEqual({ state: 'DEAD', last_error_code: 'TOURNAMENT_PROVIDER_OUTCOME_UNKNOWN' });
    expect(await runTournamentDelivery(repo, f.owner, f.tenant, f.transport)).toBe(false);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('lost finalizer write keeps dispatch marker and expired-lease recovery never resends', async () => {
    const f = await setup();
    await f.project(await f.queue());
    let fail = true;
    const checked = new TournamentMessageNotificationRepository(
      intercept(pool, (sql) => {
        if (fail && sql.includes('insert into notifications.delivery_attempts')) {
          fail = false;
          throw Error('SYNTHETIC_FINALIZE_FAILURE');
        }
      }),
    );
    await runTournamentDelivery(checked, f.owner, f.tenant, f.transport);
    const delivery = (
      await rows(
        f.tenant,
        "select state,tournament_dispatch_started_at from notifications.deliveries where tenant_id=$1 and channel='PUSH'",
      )
    ).rows[0];
    expect(delivery?.state).toBe('TOURNAMENT_SENDING');
    expect(delivery?.tournament_dispatch_started_at).not.toBeNull();
    await rows(
      f.tenant,
      "update notifications.deliveries set lease_expires_at=now()-interval '1 second' where tenant_id=$1 and channel='PUSH'",
    );
    await runTournamentDelivery(repo, f.owner, f.tenant, f.transport);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(
      (
        await rows(
          f.tenant,
          "select last_error_code from notifications.deliveries where tenant_id=$1 and channel='PUSH'",
        )
      ).rows[0]?.last_error_code,
    ).toBe('TOURNAMENT_PROVIDER_OUTCOME_UNKNOWN');
  });
  it('blocks source disable, mapping revocation and endpoint transfer before sending', async () => {
    for (const change of ['source', 'mapping', 'endpoint']) {
      const f = await setup();
      await f.project(await f.queue());
      if (change === 'source')
        await rows(
          f.tenant,
          'update notifications.tournament_message_sources set enabled=false where tenant_id=$1',
        );
      if (change === 'mapping')
        await rows(
          f.tenant,
          "update integration.external_entity_map set sync_status='error' where tenant_id=$1",
        );
      if (change === 'endpoint') {
        const stranger = randomUUID();
        await rows(f.tenant, 'insert into identity.users(tenant_id,id) values($1,$2)', [stranger]);
        await rows(
          f.tenant,
          'update integration.notification_endpoints set user_id=$2 where tenant_id=$1',
          [stranger],
        );
      }
      await runTournamentDelivery(repo, f.owner, f.tenant, f.transport);
      expect(f.send).not.toHaveBeenCalled();
    }
  });
  it('enforces immutable context and rejects ordinary states or scenario markers', async () => {
    const f = await setup();
    await f.project(await f.queue());
    for (const update of [
      'tournament_notification_context_id=null',
      "state='PENDING'",
      "state='STATION_PENDING'",
      'scenario_dispatch_started_at=now()',
      "state='SENT',completed_at=now()",
    ])
      await expect(
        rows(
          f.tenant,
          `update notifications.deliveries set ${update} where tenant_id=$1 and channel='PUSH'`,
        ),
      ).rejects.toThrow();
    await expect(
      rows(
        f.tenant,
        'update notifications.intents set tournament_notification_context_id=null where tenant_id=$1',
      ),
    ).rejects.toThrow('TOURNAMENT_CONTEXT_IMMUTABLE');
  });
  it('RLS hides another tenant and rejects cross-tenant writes for a non-bypass role', async () => {
    const a = await setup(),
      b = await setup(),
      c = await pool.connect(),
      role = 'tournament_test_' + randomUUID().replaceAll('-', '');
    try {
      await c.query('begin');
      await c.query(`create role ${role} nologin nosuperuser nobypassrls`);
      await c.query(`grant usage on schema notifications to ${role}`);
      await c.query(`grant select on notifications.tournament_message_sources to ${role}`);
      await c.query(`grant insert on notifications.tournament_message_facts to ${role}`);
      await c.query(`set local role ${role}`);
      await c.query("select set_config('app.tenant_id',$1,true)", [a.tenant]);
      expect(
        (await c.query('select id from notifications.tournament_message_sources')).rows,
      ).toEqual([{ id: a.source }]);
      await expect(
        c.query(
          'insert into notifications.tournament_message_facts(tenant_id,id,source_id,sequence,message_id,author_user_id,fact_hash) values($1,$2,$3,2,$4,$5,$6)',
          [b.tenant, randomUUID(), b.source, randomUUID(), b.user, 'f'.repeat(64)],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
  it('provisioning is authorized, dry-run by default caller, idempotent and disabled', async () => {
    const f = await setup();
    const request = {
      tenantId: f.tenant,
      actorId: f.user,
      idempotencyKey: 'synthetic-tournament-' + randomUUID(),
      tournamentId: randomUUID(),
      ownerNamespace: 'iSkq6G',
      incarnationHash: 'd'.repeat(64),
      streamId: randomUUID(),
      replayFloor: 10,
    };
    await expect(
      provisionTournamentSource({ databaseUrl: url, request, apply: false }),
    ).rejects.toThrow('ADMIN_PERMISSION_REQUIRED');
    await rows(
      f.tenant,
      "insert into identity.user_access_profiles(tenant_id,user_id,roles,permissions) values($1,$2,array['admin'],array['notifications.manage'])",
      [f.user],
    );
    // Existing active rule is deliberately removed only in this synthetic tenant.
    await rows(f.tenant, 'delete from notifications.trigger_rules where tenant_id=$1');
    await rows(f.tenant, 'delete from notifications.templates where tenant_id=$1');
    expect(
      await provisionTournamentSource({ databaseUrl: url, request, apply: false }),
    ).toMatchObject({ dryRun: true, enabled: false, runtimeChanged: false });
    expect(
      (
        await rows(
          f.tenant,
          'select count(*)::int n from notifications.tournament_message_sources where tenant_id=$1',
        )
      ).rows[0]?.n,
    ).toBe(1);
    const audits = () =>
      rows(
        f.tenant,
        'select actor_id,resource_id,action,result,correlation_id from audit.audit_log where tenant_id=$1 and correlation_id=$2',
        [request.idempotencyKey],
      );
    expect((await audits()).rows).toEqual([]);
    const first = await provisionTournamentSource({ databaseUrl: url, request, apply: true });
    expect(await provisionTournamentSource({ databaseUrl: url, request, apply: true })).toEqual(
      first,
    );
    expect((await audits()).rows).toEqual([
      {
        actor_id: request.actorId,
        resource_id: (first as { sourceId: string }).sourceId,
        action: 'TOURNAMENT_NOTIFICATION_SOURCE_PROVISIONED',
        result: 'SUCCESS',
        correlation_id: request.idempotencyKey,
      },
    ]);
    expect(
      (
        await rows(
          f.tenant,
          'select enabled,after_sequence,completed_sequence from notifications.tournament_message_sources where tenant_id=$1 and tournament_id=$2',
          [request.tournamentId],
        )
      ).rows[0],
    ).toEqual({ enabled: false, after_sequence: '10', completed_sequence: '10' });
    expect(
      (await rows(f.tenant, 'select active from notifications.trigger_rules where tenant_id=$1'))
        .rows[0]?.active,
    ).toBe(false);
    await expect(
      provisionTournamentSource({
        databaseUrl: url,
        request: { ...request, replayFloor: 11 },
        apply: true,
      }),
    ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
    await expect(
      provisionTournamentSource({
        databaseUrl: url,
        request: { ...request, ownerNamespace: 'foreign' },
        apply: true,
      }),
    ).rejects.toThrow('TOURNAMENT_NAMESPACE_MISMATCH');
  });
  it('independent senders claim one delivery without duplicate submission', async () => {
    const f = await setup();
    await f.project(await f.queue());
    const outcomes = await Promise.all([
      runTournamentDelivery(repo, f.owner, f.tenant, f.transport),
      runTournamentDelivery(other, f.owner, f.tenant, f.transport),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('endpoint transfer during a policy lock wait invalidates the already obtained owner proof', async () => {
    const f = await setup();
    await f.project(await f.queue());
    const holder = await second.connect();
    let pending: Promise<boolean> | undefined;
    try {
      await holder.query('begin');
      await holder.query("select set_config('app.tenant_id',$1,true)", [f.tenant]);
      const pid = (await holder.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid;
      await holder.query(
        'select id from integration.notification_endpoints where tenant_id=$1 and id=$2 for update',
        [f.tenant, f.endpoint],
      );
      pending = runTournamentDelivery(repo, f.owner, f.tenant, f.transport);
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        blocked = (
          await pool.query<{ blocked: boolean }>(
            'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) blocked',
            [pid],
          )
        ).rows[0]!.blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      const stranger = randomUUID();
      await holder.query('insert into identity.users(tenant_id,id) values($1,$2)', [
        f.tenant,
        stranger,
      ]);
      await holder.query(
        'update integration.notification_endpoints set user_id=$3 where tenant_id=$1 and id=$2',
        [f.tenant, f.endpoint, stranger],
      );
      await holder.query('commit');
      await pending;
      expect(f.send).not.toHaveBeenCalled();
      expect(
        (
          await rows(
            f.tenant,
            "select state,tournament_dispatch_started_at from notifications.deliveries where tenant_id=$1 and channel='PUSH'",
          )
        ).rows[0],
      ).toEqual({ state: 'SUPPRESSED', tournament_dispatch_started_at: null });
    } finally {
      await holder.query('rollback');
      holder.release();
      await pending;
    }
  });
});
