import { createHash, randomUUID } from 'node:crypto';
import { withTenantTransaction } from '@phub/database';
import { resolveScenarioIntentStates } from '@phub/database/notification-scenarios';
import {
  notificationScenarioInputSchema,
  type NotificationScenarioInput,
} from '@phub/domain/notification-scenarios';
import { renderNotificationTemplate } from '@phub/notifications';
import type { VivaNotificationFact } from '@phub/viva-adapter/notification-lifecycle';
import type { Pool } from 'pg';

/** Complete, owner-verified snapshot only. Raw provider IDs and full birth dates never enter contexts. */
export async function persistNotificationLifecycleSnapshot(input: {
  pool: Pool;
  tenantId: string;
  userId: string;
  facts: readonly VivaNotificationFact[];
  scopes: readonly string[];
  now: Date;
}): Promise<void> {
  await withTenantTransaction(input.pool, input.tenantId, async (client) => {
    await client.query(
      "select set_config('statement_timeout','20s',true),set_config('lock_timeout','5s',true)",
    );
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
      `scenario-admin:${input.tenantId}`,
    ]);
    // Serialize collection consent with the same lock as the preferences writer and send gate.
    let birthdayConsent = false;
    if (input.scopes.includes('BIRTHDAY')) {
      await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${input.tenantId}:NOTIFICATION_PREFERENCES:${input.userId}`,
      ]);
      birthdayConsent =
        (
          await client.query(
            `select 1 from notifications.user_preferences where tenant_id=$1 and user_id=$2 and category='BIRTHDAY' and channel in ('IN_APP','PUSH','EMAIL') and enabled=true limit 1`,
            [input.tenantId, input.userId],
          )
        ).rowCount === 1;
      if (!birthdayConsent) {
        await client.query(
          `update notifications.scenario_contexts set revision=revision+1,fingerprint=$4,payload=jsonb_set(jsonb_set(payload-'anchor','{valid}','false'),'{checkedAt}',to_jsonb($3::text)),occurred_at='epoch'::timestamptz where tenant_id=$1 and kind='LIFECYCLE' and payload->>'recipientUserId'=$2 and payload->>'trigger'='BIRTHDAY' and (payload ? 'anchor' or payload->>'valid'='true')`,
          [
            input.tenantId,
            input.userId,
            input.now.toISOString(),
            createHash('sha256').update('BIRTHDAY_CONSENT_DISABLED').digest('hex'),
          ],
        );
      }
    }
    const scenarios = (
      await client.query<{ id: string; version: number; definition: NotificationScenarioInput }>(
        `select id,version,definition from notifications.scenarios where tenant_id=$1 and extended_active=true`,
        [input.tenantId],
      )
    ).rows.map((s) => ({ ...s, definition: notificationScenarioInputSchema.parse(s.definition) }));
    const targets: string[] = [];
    for (const fact of input.facts) {
      if (fact.trigger === 'BIRTHDAY' && !birthdayConsent) continue;
      if (!input.scopes.includes(fact.scope) || !Number.isFinite(Date.parse(fact.anchor)))
        throw new Error('LIFECYCLE_SNAPSHOT_INVALID');
      const key = createHash('sha256').update(fact.key).digest('hex');
      const target = (
        await client.query<{ target_id: string }>(
          `insert into notifications.scenario_source_keys(tenant_id,user_id,fact_key) values($1,$2,$3) on conflict(tenant_id,user_id,fact_key) do update set fact_key=excluded.fact_key returning target_id`,
          [input.tenantId, input.userId, key],
        )
      ).rows[0]!.target_id;
      targets.push(target);
      const payload = {
        recipientUserId: input.userId,
        scope: createHash('sha256').update(fact.scope).digest('hex'),
        valid: fact.valid,
        anchor: fact.anchor,
        trigger: fact.trigger,
        sourceOwner: 'VIVA_PRIMARY',
        checkedAt: input.now.toISOString(),
      };
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ ...payload, checkedAt: undefined }))
        .digest('hex');
      const context = (
        await client.query<{
          revision: string;
          source_event_id: string;
          fingerprint: string;
          payload: { checkedAt: string };
        }>(
          `select revision::text,source_event_id,fingerprint,payload from notifications.scenario_contexts where tenant_id=$1 and kind='LIFECYCLE' and target_id=$2 for update`,
          [input.tenantId, target],
        )
      ).rows[0];
      if (context && Date.parse(context.payload.checkedAt) > input.now.getTime()) continue;
      const changed = context?.fingerprint !== fingerprint;
      const revision = changed ? String(BigInt(context?.revision ?? '0') + 1n) : context.revision;
      const eventId = changed ? randomUUID() : context.source_event_id;
      await client.query(
        `insert into notifications.scenario_contexts(tenant_id,target_id,kind,revision,event_type,fingerprint,payload,occurred_at,source_event_id) values($1,$2,'LIFECYCLE',$3,$4,$5,$6::jsonb,$7,$8) on conflict(tenant_id,kind,target_id) do update set revision=excluded.revision,event_type=excluded.event_type,fingerprint=excluded.fingerprint,payload=excluded.payload,occurred_at=excluded.occurred_at,source_event_id=excluded.source_event_id`,
        [
          input.tenantId,
          target,
          revision,
          fact.trigger,
          fingerprint,
          JSON.stringify(payload),
          fact.anchor,
          eventId,
        ],
      );
      if (!fact.valid) continue;
      for (const scenario of scenarios.filter((s) => s.definition.trigger === fact.trigger)) {
        const due = new Date(Date.parse(fact.anchor) + scenario.definition.delayMinutes * 60_000);
        const expires = new Date(
          Math.min(
            due.getTime() + scenario.definition.ttlMinutes * 60_000,
            scenario.definition.delayMinutes < 0 ? Date.parse(fact.anchor) : Infinity,
          ),
        );
        if (
          expires <= input.now ||
          (fact.trigger === 'TRAINING_ATTENDED' &&
            Date.parse(fact.anchor) < input.now.getTime() - 86_400_000)
        )
          continue;
        const rendered = renderNotificationTemplate({
          titleTemplate: scenario.definition.title,
          bodyTemplate: scenario.definition.body,
          payload: {
            serviceTitle: fact.serviceTitle,
            startsAt: fact.anchor,
            locationName: 'Клуб',
            gameId: '',
          },
        });
        // Correction reuses the occurrence key. Already queued occurrences are never resent.
        const sourceEvent =
          (
            await client.query<{ source_event_id: string }>(
              `select source_event_id from notifications.scenario_runs where tenant_id=$1 and scenario_id=$2 and target_id=$3 and recipient_user_id=$4 limit 1`,
              [input.tenantId, scenario.id, target, input.userId],
            )
          ).rows[0]?.source_event_id ?? eventId;
        await client.query(
          `insert into notifications.scenario_runs(tenant_id,scenario_id,scenario_version,recipient_user_id,target_id,source_event_id,context_kind,context_revision,rendered_title,rendered_body,deep_link,due_at,expires_at,state) values($1,$2,$3,$4,$5,$6,'LIFECYCLE',$7,$8,$9,$10,$11,$12,'EXTENDED_PENDING') on conflict(tenant_id,scenario_id,source_event_id,recipient_user_id) do update set context_revision=excluded.context_revision,due_at=excluded.due_at,expires_at=excluded.expires_at,rendered_title=excluded.rendered_title,rendered_body=excluded.rendered_body,state='EXTENDED_PENDING',reason=null,updated_at=now() where scenario_runs.queued_at is null and scenario_runs.scenario_version=excluded.scenario_version`,
          [
            input.tenantId,
            scenario.id,
            scenario.version,
            input.userId,
            target,
            sourceEvent,
            revision,
            rendered.title,
            rendered.body,
            fact.trigger === 'SUBSCRIPTION_ENDS' ? '/profile' : '/notifications',
            due,
            expires,
          ],
        );
      }
    }
    // Absence in a complete scope revokes a fact, never proves a visit/expiry.
    await client.query(
      `update notifications.scenario_contexts set revision=revision+1,payload=jsonb_set(jsonb_set(payload,'{valid}','false'),'{checkedAt}',to_jsonb($5::text)) where tenant_id=$1 and kind='LIFECYCLE' and payload->>'recipientUserId'=$2 and payload->>'scope'=any($3::text[]) and not(target_id=any($4::uuid[])) and payload->>'valid'='true' and (payload->>'checkedAt')::timestamptz<=$5::timestamptz`,
      [
        input.tenantId,
        input.userId,
        input.scopes.map((scope) => createHash('sha256').update(scope).digest('hex')),
        targets,
        input.now.toISOString(),
      ],
    );
    await client.query(
      `update notifications.scenario_runs r set state=case when state='EXTENDED_PENDING' then 'CANCELLED' else state end,reason='SOURCE_CHANGED',updated_at=now() from notifications.scenario_contexts c where r.tenant_id=$1 and r.recipient_user_id=$2 and r.context_kind='LIFECYCLE' and c.tenant_id=r.tenant_id and c.kind='LIFECYCLE' and c.target_id=r.target_id and (c.revision<>r.context_revision or c.payload->>'valid'<>'true') and r.state in ('EXTENDED_PENDING','QUEUED')`,
      [input.tenantId, input.userId],
    );
    const suppressed = await client.query<{ intent_id: string }>(
      `update notifications.deliveries d set state='SUPPRESSED',last_error_code='SOURCE_CHANGED',completed_at=now(),lease_expires_at=null where d.tenant_id=$1 and d.state='PENDING' and exists(select 1 from notifications.scenario_runs r where r.tenant_id=d.tenant_id and r.intent_id=d.intent_id and r.recipient_user_id=$2 and r.context_kind='LIFECYCLE' and r.reason='SOURCE_CHANGED') returning d.intent_id`,
      [input.tenantId, input.userId],
    );
    await resolveScenarioIntentStates(
      client,
      input.tenantId,
      suppressed.rows.map((r) => r.intent_id),
    );
  });
}
