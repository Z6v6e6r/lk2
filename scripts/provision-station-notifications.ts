/** Source-only explicit station rules/source adoption. Default dry-run; never called by workers. */
import { randomUUID, createHash } from 'node:crypto';
import { createDatabasePool, withTenantTransaction } from '@phub/database';
import { stationMapping } from '@phub/database/station-message-notifications';
import { STATION_MESSAGE_NOTIFICATION as rule } from '@phub/notifications';
import { z } from 'zod';
const input = z
  .object({
    tenantId: z.string().uuid(),
    actorId: z.string().uuid(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/),
    communityId: z.string().uuid(),
    privateCommunityId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
    incarnationHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    streamId: z.string().uuid(),
    replayFloor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export async function provisionStationSource(options: {
  databaseUrl: string;
  request: unknown;
  apply: boolean;
}) {
  const r = input.parse(options.request),
    pool = createDatabasePool(options.databaseUrl);
  const hash = createHash('sha256')
    .update(JSON.stringify({ version: 1, ...r, rule }))
    .digest('hex');
  try {
    return await withTenantTransaction(pool, r.tenantId, async (c) => {
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
        'station-provision:' + r.tenantId,
      ]);
      const access = await c.query(
        `select u.id from identity.users u join identity.user_access_profiles a on a.tenant_id=u.tenant_id and a.user_id=u.id join identity.tenants t on t.id=u.tenant_id where u.tenant_id=$1 and u.id=$2 and u.status='ACTIVE' and t.active and 'admin'=any(a.roles) and 'notifications.manage'=any(a.permissions)`,
        [r.tenantId, r.actorId],
      );
      if (access.rowCount !== 1) throw Error('ADMIN_PERMISSION_REQUIRED');
      if (
        (
          await c.query(
            "select tenant_id from integration.identity_provider_bindings where tenant_id=$1 and provider='VIVA' and provider_tenant_key='iSkq6G'",
            [r.tenantId],
          )
        ).rowCount !== 1
      )
        throw Error('STATION_NAMESPACE_MISMATCH');
      const mapping = await stationMapping(
        c,
        r.tenantId,
        'LK_LEGACY',
        'community',
        r.privateCommunityId,
      );
      if (mapping.internal_id !== r.communityId) throw Error('STATION_MAPPING_CHANGED');
      const old = await c.query<{ request_hash: string; result: unknown }>(
        'select request_hash,result from notifications.ruleset_provision_commands where tenant_id=$1 and idempotency_key=$2',
        [r.tenantId, r.idempotencyKey],
      );
      if (old.rows[0]) {
        if (old.rows[0].request_hash !== hash) throw Error('IDEMPOTENCY_KEY_REUSED');
        return old.rows[0].result;
      }
      const result = {
        sourceId: randomUUID(),
        streamId: r.streamId,
        replayFloor: r.replayFloor,
        enabled: false,
        runtimeChanged: false,
      };
      if (!options.apply) return { ...result, dryRun: true };
      await c.query(
        `insert into notifications.station_message_sources(tenant_id,id,community_id,mapping_id,owner_namespace,private_community_id,incarnation_hash,stream_id,replay_floor,after_sequence) values($1,$2,$3,$4,'iSkq6G',$5,$6,$7,$8,$8)`,
        [
          r.tenantId,
          result.sourceId,
          r.communityId,
          mapping.id,
          r.privateCommunityId,
          r.incarnationHash,
          r.streamId,
          r.replayFloor,
        ],
      );
      await c.query(
        `insert into notifications.templates(tenant_id,template_key,version,locale,category,channels,title_template,body_template,deep_link_template,active,created_by_user_id) values($1,$2,1,'ru-RU','MESSAGING',array['IN_APP','PUSH'],$3,$4,$5,false,$6) on conflict do nothing`,
        [r.tenantId, rule.templateKey, rule.title, rule.body, rule.deepLink, r.actorId],
      );
      const t = await c.query<{ id: string }>(
        `select id from notifications.templates where tenant_id=$1 and template_key=$2 and version=1 and locale='ru-RU' and category='MESSAGING' and channels=array['IN_APP','PUSH']::text[] and title_template=$3 and body_template=$4 and deep_link_template=$5`,
        [r.tenantId, rule.templateKey, rule.title, rule.body, rule.deepLink],
      );
      if (t.rowCount !== 1) throw Error('STATION_TEMPLATE_CONFLICT');
      await c.query(
        `insert into notifications.trigger_rules(tenant_id,rule_key,source_event_type,template_id,audience_selector,channel_override,mandatory,active,created_by_user_id) values($1,$2,$3,$4,$5::jsonb,array['IN_APP','PUSH'],false,false,$6) on conflict do nothing`,
        [
          r.tenantId,
          rule.ruleKey,
          rule.eventType,
          t.rows[0]!.id,
          JSON.stringify({ type: 'EVENT_USERS', field: 'recipientUserIds' }),
          r.actorId,
        ],
      );
      const exactRule = await c.query(
        `select id from notifications.trigger_rules where tenant_id=$1 and rule_key=$2 and source_event_type=$3 and template_id=$4 and audience_selector=$5::jsonb and not mandatory and channel_override=array['IN_APP','PUSH']::text[]`,
        [
          r.tenantId,
          rule.ruleKey,
          rule.eventType,
          t.rows[0]!.id,
          JSON.stringify({ type: 'EVENT_USERS', field: 'recipientUserIds' }),
        ],
      );
      if (exactRule.rowCount !== 1) throw Error('STATION_RULE_CONFLICT');
      await c.query(
        `insert into notifications.ruleset_provision_commands(tenant_id,idempotency_key,request_hash,result,actor_user_id,ruleset_version) values($1,$2,$3,$4::jsonb,$5,'station.message.v1')`,
        [r.tenantId, r.idempotencyKey, hash, JSON.stringify(result), r.actorId],
      );
      await c.query(
        `insert into audit.audit_log(tenant_id,actor_id,action,resource_type,resource_id,result,correlation_id) values($1,$2,'STATION_NOTIFICATION_SOURCE_PROVISIONED','STATION_NOTIFICATION_SOURCE',$3,'SUCCESS',$4)`,
        [r.tenantId, r.actorId, result.sourceId, r.idempotencyKey],
      );
      return result;
    });
  } finally {
    await pool.end();
  }
}
// No top-level database access: callers explicitly invoke the reviewed helper and choose apply.
