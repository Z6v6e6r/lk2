import { createHash } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type AdminNotificationChannel = 'IN_APP' | 'WEB_PUSH' | 'IOS_PUSH' | 'ANDROID_PUSH';

export interface AdminNotificationRecipient {
  readonly userId: string;
  readonly displayName: string;
  readonly phoneMasked?: string;
  readonly availableChannels: readonly AdminNotificationChannel[];
}

export interface AdminNotificationRecipientResolution {
  readonly matched: readonly AdminNotificationRecipient[];
  readonly unresolvedPhones: readonly string[];
  readonly unresolvedUserIds: readonly string[];
}

/**
 * One operator-visible row for the CUP: an account that can actually receive a Web Push right now. The
 * phone is only ever masked, and the count and the last confirmation let the operator judge whether the
 * subscription is live.
 */
export interface AdminWebPushSubscriber {
  readonly userId: string;
  readonly displayName: string;
  readonly phoneMasked?: string;
  readonly endpointCount: number;
  readonly lastConfirmedAt?: string;
}

export interface AdminWebPushSubscriberPage {
  readonly items: readonly AdminWebPushSubscriber[];
  readonly nextCursor?: string;
}

export interface AdminNotificationCapabilities {
  readonly inAppTenantEnabled: boolean;
  readonly webPushTenantEnabled: boolean;
  readonly webPushProviderConfigured: boolean;
  readonly iosPushTenantEnabled: boolean;
  readonly androidPushTenantEnabled: boolean;
}

export interface AdminNotificationCampaignAccepted {
  readonly outcome: 'accepted';
  readonly campaignId: string;
  readonly matchedCount: number;
  readonly unresolvedCount: number;
  readonly inAppCreatedCount: number;
  readonly pushQueuedCount: number;
  readonly suppressedCount: number;
  readonly replayed: boolean;
}

export type AdminNotificationCampaignResult =
  | AdminNotificationCampaignAccepted
  | { readonly outcome: 'idempotency_conflict' }
  | { readonly outcome: 'channel_unavailable'; readonly channel: AdminNotificationChannel }
  | { readonly outcome: 'recipients_not_found' };

export interface AdminNotificationRepository {
  getCapabilities(input: {
    readonly tenantId: string;
    readonly webPushAppId: string;
    readonly webPushEnvironment: 'SANDBOX' | 'PRODUCTION';
  }): Promise<AdminNotificationCapabilities>;
  resolveRecipients(input: {
    readonly tenantId: string;
    readonly normalizedPhones: readonly string[];
    readonly normalizedUserIds: readonly string[];
    readonly webPushGloballyEnabled: boolean;
    readonly webPushAppId: string;
    readonly webPushEnvironment: 'SANDBOX' | 'PRODUCTION';
  }): Promise<AdminNotificationRecipientResolution>;
  listWebPushSubscribers(input: {
    readonly tenantId: string;
    readonly webPushAppId: string;
    readonly webPushEnvironment: 'SANDBOX' | 'PRODUCTION';
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<AdminWebPushSubscriberPage>;
  createCampaign(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly normalizedPhones: readonly string[];
    readonly normalizedUserIds: readonly string[];
    readonly title: string;
    readonly body: string;
    readonly deepLink?: string;
    readonly requestedChannels: readonly ('IN_APP' | 'WEB_PUSH')[];
    readonly requestHash: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
    readonly webPushGloballyEnabled: boolean;
    readonly webPushAppId: string;
    readonly webPushEnvironment: 'SANDBOX' | 'PRODUCTION';
  }): Promise<AdminNotificationCampaignResult>;
}

interface CapabilitiesRow extends QueryResultRow {
  readonly in_app_enabled: boolean;
  readonly web_push_enabled: boolean;
  readonly ios_push_enabled: boolean;
  readonly android_push_enabled: boolean;
  readonly web_push_provider_configured: boolean;
}

interface SubscriberRow extends QueryResultRow {
  readonly user_id: string;
  readonly display_name: string;
  readonly phone_e164: string | null;
  readonly endpoint_count: number;
  readonly last_confirmed_at: Date | null;
}

interface RecipientRow extends QueryResultRow {
  readonly user_id: string;
  readonly display_name: string;
  readonly phone_e164: string | null;
  readonly in_app_preference_enabled: boolean;
  readonly push_preference_enabled: boolean;
  readonly web_push_endpoint_count: number;
}

interface IdRow extends QueryResultRow {
  readonly id: string;
}

interface CommandRow extends QueryResultRow {
  readonly request_hash: string;
  readonly campaign_id: string | null;
  readonly result_state: 'PENDING' | 'ACCEPTED';
}

interface CampaignRow extends QueryResultRow {
  readonly id: string;
  readonly matched_count: number;
  readonly unresolved_count: number;
  readonly in_app_created_count: number;
  readonly push_queued_count: number;
  readonly suppressed_count: number;
}

function maskPhone(phoneE164: string): string {
  return `•••• ${phoneE164.slice(-4)}`;
}

function dedupeKey(campaignId: string, userId: string): string {
  return createHash('sha256').update(`${campaignId}:${userId}`).digest('hex');
}

async function capabilities(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly webPushAppId: string;
    readonly webPushEnvironment: 'SANDBOX' | 'PRODUCTION';
  },
): Promise<AdminNotificationCapabilities> {
  const row = await queryOne<CapabilitiesRow>(
    client,
    `select
       coalesce(s.in_app_enabled, false) as in_app_enabled,
       coalesce(s.web_push_enabled, false) as web_push_enabled,
       coalesce(s.ios_push_enabled, false) as ios_push_enabled,
       coalesce(s.android_push_enabled, false) as android_push_enabled,
       exists (
         select 1
           from integration.notification_provider_accounts a
          where a.tenant_id = $1
            and a.channel = 'PUSH'
            and a.platform = 'WEB'
            and a.provider = 'WEB_PUSH'
            and a.app_id = $2
            and a.environment = $3
            and a.status = 'ACTIVE'
       ) as web_push_provider_configured
     from (select $1::uuid as tenant_id) input
     left join notifications.tenant_runtime_settings s
       on s.tenant_id = input.tenant_id`,
    [input.tenantId, input.webPushAppId, input.webPushEnvironment],
  );
  return {
    inAppTenantEnabled: row?.in_app_enabled ?? false,
    webPushTenantEnabled: row?.web_push_enabled ?? false,
    webPushProviderConfigured: row?.web_push_provider_configured ?? false,
    iosPushTenantEnabled: row?.ios_push_enabled ?? false,
    androidPushTenantEnabled: row?.android_push_enabled ?? false,
  };
}

// Both recipient sources return the same shape: identity, display name, optional phone, the
// ADMIN_MESSAGE preferences and the number of live Web Push endpoints for the requested provider app.
function recipientSelect(phoneExpression: string): string {
  return `\
select
  u.id as user_id,
  p.display_name,
  ${phoneExpression} as phone_e164,
  coalesce((
    select pref.enabled
      from notifications.user_preferences pref
     where pref.tenant_id = u.tenant_id
       and pref.user_id = u.id
       and pref.category = 'ADMIN_MESSAGE'
       and pref.channel = 'IN_APP'
  ), true) as in_app_preference_enabled,
  coalesce((
    select pref.enabled
      from notifications.user_preferences pref
     where pref.tenant_id = u.tenant_id
       and pref.user_id = u.id
       and pref.category = 'ADMIN_MESSAGE'
       and pref.channel = 'PUSH'
  ), true) as push_preference_enabled,
  (
    select count(*)::integer
      from integration.notification_endpoints e
      join integration.notification_provider_accounts a
        on a.tenant_id = e.tenant_id and a.id = e.provider_account_id
     where e.tenant_id = u.tenant_id
       and e.user_id = u.id
       and e.channel = 'PUSH'
       and e.status = 'ACTIVE'
       and a.channel = 'PUSH'
       and a.platform = 'WEB'
       and a.provider = 'WEB_PUSH'
       and a.app_id = $3
       and a.environment = $4
       and a.status = 'ACTIVE'
  ) as web_push_endpoint_count`;
}

async function recipientRows(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly normalizedPhones: readonly string[];
    readonly webPushAppId: string;
    readonly webPushEnvironment: 'SANDBOX' | 'PRODUCTION';
  },
): Promise<readonly RecipientRow[]> {
  if (input.normalizedPhones.length === 0) return [];
  // A phone reaches a PadlHub user through two sources with different proof strength.
  // `profile.user_summaries.phone_e164` only ever holds a phone that an attested command verified (the
  // phone-login exchange or the authenticated profile confirmation), so it always wins.
  // `integration.external_entity_map` (`VIVA`/`legacy_viewer_phone`) carries the phone the
  // provider profile reported and is the fallback that makes an OAuth-only account reachable at all —
  // and because one of its writers relays that value from the client without server attestation, it
  // must never outrank a verified login phone. Ambiguity inside a source stays fail-closed: two rows
  // for one phone resolve to nothing.
  const result = await client.query<RecipientRow>(
    `with requested as (
       select unnest($2::text[]) as phone
     ),
     provider_link as (
       select requested.phone, link.internal_id as user_id
         from requested
         join integration.external_entity_map link
           on link.tenant_id = $1
          and link.external_system = 'VIVA'
          and link.entity_type = 'legacy_viewer_phone'
          and link.external_id = requested.phone
     ),
     login_phone as (
       select requested.phone, summary.user_id
         from requested
         join profile.user_summaries summary
           on summary.tenant_id = $1
          and summary.phone_e164 = requested.phone
     ),
     resolved as (
       select login_phone.phone, login_phone.user_id from login_phone
       union all
       select provider_link.phone, provider_link.user_id
         from provider_link
        where not exists (
          select 1 from login_phone where login_phone.phone = provider_link.phone
        )
     )
${recipientSelect('resolved.phone')}
     from resolved
     join identity.users u
       on u.tenant_id = $1 and u.id = resolved.user_id
     join profile.user_summaries p
       on p.tenant_id = u.tenant_id and p.user_id = u.id
    where u.status = 'ACTIVE'
    order by resolved.phone, u.id`,
    [input.tenantId, [...input.normalizedPhones], input.webPushAppId, input.webPushEnvironment],
  );
  return result.rows;
}

// The CUP may address recipients by PadlHub UUID, which is the authoritative selector: it does not
// depend on any phone mapping and cannot be redirected by a phone claim. Only active users with a
// profile summary are returned; unknown or disabled identifiers stay unresolved.
async function recipientRowsByIds(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly normalizedUserIds: readonly string[];
    readonly webPushAppId: string;
    readonly webPushEnvironment: 'SANDBOX' | 'PRODUCTION';
  },
): Promise<readonly RecipientRow[]> {
  if (input.normalizedUserIds.length === 0) return [];
  const result = await client.query<RecipientRow>(
    `${recipientSelect('p.phone_e164')}
       from identity.users u
       join profile.user_summaries p
         on p.tenant_id = u.tenant_id and p.user_id = u.id
      where u.tenant_id = $1
        and u.status = 'ACTIVE'
        and u.id = any($2::uuid[])
      order by u.id`,
    [input.tenantId, [...input.normalizedUserIds], input.webPushAppId, input.webPushEnvironment],
  );
  return result.rows;
}

function availableChannels(
  row: RecipientRow,
  capabilities: AdminNotificationCapabilities,
  webPushGloballyEnabled: boolean,
): readonly AdminNotificationChannel[] {
  const channels: AdminNotificationChannel[] = [];
  if (capabilities.inAppTenantEnabled && row.in_app_preference_enabled) channels.push('IN_APP');
  if (
    webPushGloballyEnabled &&
    capabilities.webPushTenantEnabled &&
    capabilities.webPushProviderConfigured &&
    row.push_preference_enabled &&
    row.web_push_endpoint_count > 0
  ) {
    channels.push('WEB_PUSH');
  }
  return channels;
}

// One person can be addressed by several selectors at once; the campaign and the preview must list
// that person once, so the first occurrence (the more specific selector) wins.
function dedupeRecipients(
  recipients: readonly AdminNotificationRecipient[],
): readonly AdminNotificationRecipient[] {
  const seen = new Set<string>();
  const unique: AdminNotificationRecipient[] = [];
  for (const recipient of recipients) {
    if (seen.has(recipient.userId)) continue;
    seen.add(recipient.userId);
    unique.push(recipient);
  }
  return unique;
}

function recipientView(
  row: RecipientRow,
  capabilities: AdminNotificationCapabilities,
  webPushGloballyEnabled: boolean,
): AdminNotificationRecipient {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    ...(row.phone_e164 ? { phoneMasked: maskPhone(row.phone_e164) } : {}),
    availableChannels: availableChannels(row, capabilities, webPushGloballyEnabled),
  };
}

function mapUserIdResolution(input: {
  readonly rows: readonly RecipientRow[];
  readonly normalizedUserIds: readonly string[];
  readonly capabilities: AdminNotificationCapabilities;
  readonly webPushGloballyEnabled: boolean;
}): {
  readonly matched: readonly AdminNotificationRecipient[];
  readonly unresolvedUserIds: readonly string[];
} {
  const byUserId = new Map<string, RecipientRow>();
  for (const row of input.rows) byUserId.set(row.user_id, row);
  const matched: AdminNotificationRecipient[] = [];
  const unresolvedUserIds: string[] = [];
  for (const userId of input.normalizedUserIds) {
    const row = byUserId.get(userId);
    if (!row) {
      unresolvedUserIds.push(userId);
      continue;
    }
    matched.push(recipientView(row, input.capabilities, input.webPushGloballyEnabled));
  }
  return { matched, unresolvedUserIds };
}

function mapResolution(input: {
  readonly rows: readonly RecipientRow[];
  readonly normalizedPhones: readonly string[];
  readonly capabilities: AdminNotificationCapabilities;
  readonly webPushGloballyEnabled: boolean;
}): {
  readonly matched: readonly AdminNotificationRecipient[];
  readonly unresolvedPhones: readonly string[];
} {
  const byPhone = new Map<string, RecipientRow[]>();
  for (const row of input.rows) {
    if (!row.phone_e164) continue;
    const group = byPhone.get(row.phone_e164) ?? [];
    group.push(row);
    byPhone.set(row.phone_e164, group);
  }
  const matched: AdminNotificationRecipient[] = [];
  const unresolvedPhones: string[] = [];
  // One user can own two requested phones (a verified login phone and a provider phone). The preview
  // lists that person once, so the operator never sees the same recipient twice.
  const matchedUserIds = new Set<string>();
  for (const phone of input.normalizedPhones) {
    const group = byPhone.get(phone) ?? [];
    if (group.length !== 1) {
      unresolvedPhones.push(maskPhone(phone));
      continue;
    }
    const row = group[0];
    if (!row) continue;
    if (matchedUserIds.has(row.user_id)) continue;
    matchedUserIds.add(row.user_id);
    matched.push(recipientView(row, input.capabilities, input.webPushGloballyEnabled));
  }
  return { matched, unresolvedPhones };
}

function unambiguousRecipientRows(
  rows: readonly RecipientRow[],
  normalizedPhones: readonly string[],
): readonly RecipientRow[] {
  const byPhone = new Map<string, RecipientRow[]>();
  for (const row of rows) {
    if (!row.phone_e164) continue;
    const group = byPhone.get(row.phone_e164) ?? [];
    group.push(row);
    byPhone.set(row.phone_e164, group);
  }
  // A campaign writes one recipient row, one intent and one dedupe key per user, so two requested
  // phones that belong to the same person must collapse into a single recipient here.
  const seenUserIds = new Set<string>();
  const recipients: RecipientRow[] = [];
  for (const phone of normalizedPhones) {
    const group = byPhone.get(phone) ?? [];
    if (group.length !== 1) continue;
    const row = group[0];
    if (!row || seenUserIds.has(row.user_id)) continue;
    seenUserIds.add(row.user_id);
    recipients.push(row);
  }
  return recipients;
}

async function ensureManualTemplate(
  client: PoolClient,
  tenantId: string,
  actorUserId: string,
): Promise<string> {
  const active = await queryOne<IdRow>(
    client,
    `select id
       from notifications.templates
      where tenant_id = $1
        and template_key = 'admin.manual'
        and locale = 'ru-RU'
        and active = true
      order by version desc
      limit 1`,
    [tenantId],
  );
  if (active) return active.id;

  const created = await queryOne<IdRow>(
    client,
    `insert into notifications.templates (
       tenant_id, template_key, version, locale, category, channels,
       title_template, body_template, deep_link_template, active, created_by_user_id
     )
     select
       $1,
       'admin.manual',
       coalesce(max(version), 0) + 1,
       'ru-RU',
       'ADMIN_MESSAGE',
       array['IN_APP', 'PUSH']::text[],
       '{{title}}',
       '{{body}}',
       '{{deepLink}}',
       true,
       $2
     from notifications.templates
     where tenant_id = $1 and template_key = 'admin.manual' and locale = 'ru-RU'
     returning id`,
    [tenantId, actorUserId],
  );
  if (!created) throw new Error('ADMIN_NOTIFICATION_TEMPLATE_WRITE_LOST');
  return created.id;
}

async function replayCampaign(
  client: PoolClient,
  tenantId: string,
  campaignId: string,
): Promise<AdminNotificationCampaignAccepted> {
  const campaign = await queryOne<CampaignRow>(
    client,
    `select id, matched_count, unresolved_count, in_app_created_count,
            push_queued_count, suppressed_count
       from notifications.admin_campaigns
      where tenant_id = $1 and id = $2`,
    [tenantId, campaignId],
  );
  if (!campaign) throw new Error('ADMIN_NOTIFICATION_CAMPAIGN_REPLAY_LOST');
  return {
    outcome: 'accepted',
    campaignId: campaign.id,
    matchedCount: campaign.matched_count,
    unresolvedCount: campaign.unresolved_count,
    inAppCreatedCount: campaign.in_app_created_count,
    pushQueuedCount: campaign.push_queued_count,
    suppressedCount: campaign.suppressed_count,
    replayed: true,
  };
}

export function createAdminNotificationRepository(pool: Pool): AdminNotificationRepository {
  return {
    getCapabilities(input) {
      return withTenantTransaction(pool, input.tenantId, (client) => capabilities(client, input));
    },

    resolveRecipients(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        // One client per transaction serves one query at a time; the selectors run in a stable order.
        const runtime = await capabilities(client, input);
        const phoneRows = await recipientRows(client, input);
        const userIdRows = await recipientRowsByIds(client, input);
        const byPhone = mapResolution({
          rows: phoneRows,
          normalizedPhones: input.normalizedPhones,
          capabilities: runtime,
          webPushGloballyEnabled: input.webPushGloballyEnabled,
        });
        const byUserId = mapUserIdResolution({
          rows: userIdRows,
          normalizedUserIds: input.normalizedUserIds,
          capabilities: runtime,
          webPushGloballyEnabled: input.webPushGloballyEnabled,
        });
        const matched = dedupeRecipients([...byPhone.matched, ...byUserId.matched]);
        // A selector value is either matched or unresolved, never both: an unresolved entry is only
        // produced where no single row was found, so the two lists stay disjoint by construction.
        return {
          matched,
          unresolvedPhones: byPhone.unresolvedPhones,
          unresolvedUserIds: byUserId.unresolvedUserIds,
        };
      });
    },

    listWebPushSubscribers(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        // Keyset pagination on the user id: the resolver's reachability predicate applies, so only
        // accounts with an active Web Push endpoint of an active provider account are listed.
        const result = await client.query<SubscriberRow>(
          `select
             u.id as user_id,
             p.display_name,
             p.phone_e164,
             count(e.id)::integer as endpoint_count,
             max(e.last_confirmed_at) as last_confirmed_at
           from integration.notification_endpoints e
           join integration.notification_provider_accounts a
             on a.tenant_id = e.tenant_id and a.id = e.provider_account_id
           join identity.users u
             on u.tenant_id = e.tenant_id and u.id = e.user_id
           join profile.user_summaries p
             on p.tenant_id = u.tenant_id and p.user_id = u.id
          where e.tenant_id = $1
            and e.channel = 'PUSH'
            and e.status = 'ACTIVE'
            and a.channel = 'PUSH'
            and a.platform = 'WEB'
            and a.provider = 'WEB_PUSH'
            and a.app_id = $2
            and a.environment = $3
            and a.status = 'ACTIVE'
            and u.status = 'ACTIVE'
            and ($4::uuid is null or u.id > $4::uuid)
          group by u.id, p.display_name, p.phone_e164
          order by u.id
          limit $5`,
          [
            input.tenantId,
            input.webPushAppId,
            input.webPushEnvironment,
            input.cursor ?? null,
            input.limit + 1,
          ],
        );
        const page = result.rows.slice(0, input.limit);
        const last = page[page.length - 1];
        return {
          items: page.map((row) => ({
            userId: row.user_id,
            displayName: row.display_name,
            ...(row.phone_e164 ? { phoneMasked: maskPhone(row.phone_e164) } : {}),
            endpointCount: row.endpoint_count,
            ...(row.last_confirmed_at
              ? { lastConfirmedAt: row.last_confirmed_at.toISOString() }
              : {}),
          })),
          ...(result.rows.length > input.limit && last ? { nextCursor: last.user_id } : {}),
        };
      });
    },

    createCampaign(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `admin-notification:${input.tenantId}:${input.actorUserId}`,
        ]);

        const previous = await queryOne<CommandRow>(
          client,
          `select request_hash, campaign_id, result_state
             from notifications.admin_campaign_commands
            where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3`,
          [input.tenantId, input.actorUserId, input.idempotencyKey],
        );
        if (previous) {
          if (
            previous.request_hash !== input.requestHash ||
            previous.result_state !== 'ACCEPTED' ||
            !previous.campaign_id
          ) {
            return { outcome: 'idempotency_conflict' };
          }
          return replayCampaign(client, input.tenantId, previous.campaign_id);
        }

        const runtime = await capabilities(client, input);
        if (input.requestedChannels.includes('IN_APP') && !runtime.inAppTenantEnabled) {
          return { outcome: 'channel_unavailable', channel: 'IN_APP' };
        }
        if (
          input.requestedChannels.includes('WEB_PUSH') &&
          (!input.webPushGloballyEnabled ||
            !runtime.webPushTenantEnabled ||
            !runtime.webPushProviderConfigured)
        ) {
          return { outcome: 'channel_unavailable', channel: 'WEB_PUSH' };
        }

        const candidateRows = await recipientRows(client, input);
        const userIdRows = await recipientRowsByIds(client, input);
        const unambiguousRows = unambiguousRecipientRows(candidateRows, input.normalizedPhones);
        // One person can arrive through both selectors, and the campaign writes exactly one recipient
        // row, one intent and one dedupe key per user, so the rows collapse by user id.
        const seenUserIds = new Set<string>();
        const rows: RecipientRow[] = [];
        for (const row of [...unambiguousRows, ...userIdRows]) {
          if (seenUserIds.has(row.user_id)) continue;
          seenUserIds.add(row.user_id);
          rows.push(row);
        }
        // The campaign row keeps the schema invariant `unresolved_count = input_count - matched_count`:
        // input_count counts selector values and matched_count counts distinct people, so a second
        // selector value that names an already matched person is counted as not adding a recipient.
        // The recipient preview reports the precise unresolved lists instead.
        const inputCount = input.normalizedPhones.length + input.normalizedUserIds.length;
        const unresolvedCount = inputCount - rows.length;
        if (rows.length === 0) return { outcome: 'recipients_not_found' };
        await client.query(
          `insert into notifications.admin_campaign_commands (
             tenant_id, actor_user_id, idempotency_key, request_hash
           ) values ($1, $2, $3, $4)`,
          [input.tenantId, input.actorUserId, input.idempotencyKey, input.requestHash],
        );
        const templateId = await ensureManualTemplate(client, input.tenantId, input.actorUserId);
        const campaign = await queryOne<IdRow>(
          client,
          `insert into notifications.admin_campaigns (
             tenant_id, title, body, deep_link, requested_channels,
             input_count, matched_count, unresolved_count, created_by_user_id
           ) values ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9)
           returning id`,
          [
            input.tenantId,
            input.title,
            input.body,
            input.deepLink ?? null,
            [...input.requestedChannels],
            inputCount,
            rows.length,
            unresolvedCount,
            input.actorUserId,
          ],
        );
        if (!campaign) throw new Error('ADMIN_NOTIFICATION_CAMPAIGN_WRITE_LOST');

        let inAppCreatedCount = 0;
        let pushQueuedCount = 0;
        let suppressedCount = 0;

        for (const recipient of rows) {
          const inAppRequested = input.requestedChannels.includes('IN_APP');
          const webPushRequested = input.requestedChannels.includes('WEB_PUSH');
          const deliverInApp = inAppRequested && recipient.in_app_preference_enabled;
          const deliverWebPush =
            webPushRequested &&
            recipient.push_preference_enabled &&
            recipient.web_push_endpoint_count > 0;
          const projectedChannels: AdminNotificationChannel[] = [];
          const suppressionReasons: string[] = [];
          if (deliverInApp) projectedChannels.push('IN_APP');
          else if (inAppRequested) suppressionReasons.push('IN_APP_PREFERENCE_DISABLED');
          if (deliverWebPush) projectedChannels.push('WEB_PUSH');
          else if (webPushRequested && !recipient.push_preference_enabled) {
            suppressionReasons.push('PUSH_PREFERENCE_DISABLED');
          } else if (webPushRequested) {
            suppressionReasons.push('WEB_PUSH_ENDPOINT_MISSING');
          }

          const intentState = deliverWebPush
            ? 'PROCESSING'
            : deliverInApp
              ? 'DELIVERED'
              : 'SUPPRESSED';
          const intent = await queryOne<IdRow>(
            client,
            `insert into notifications.intents (
               tenant_id, recipient_user_id, source_event_id, template_id, dedupe_key,
               render_data, rendered_title, rendered_body, rendered_deep_link,
               state, completed_at
             ) values (
               $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10,
               case when $10 = 'PROCESSING' then null else now() end
             )
             returning id`,
            [
              input.tenantId,
              recipient.user_id,
              campaign.id,
              templateId,
              dedupeKey(campaign.id, recipient.user_id),
              JSON.stringify({ campaignId: campaign.id }),
              input.title,
              input.body,
              input.deepLink ?? null,
              intentState,
            ],
          );
          if (!intent) throw new Error('ADMIN_NOTIFICATION_INTENT_WRITE_LOST');

          await client.query(
            `insert into audit.outbox_events (
               tenant_id, event_type, aggregate_id, correlation_id, payload
             ) values ($1, 'notifications.intent.created.v1', $2, $3, $4::jsonb)`,
            [
              input.tenantId,
              intent.id,
              input.correlationId,
              JSON.stringify({ intentId: intent.id, recipientUserId: recipient.user_id }),
            ],
          );

          if (inAppRequested) {
            const delivery = await queryOne<IdRow>(
              client,
              `insert into notifications.deliveries (
                 tenant_id, intent_id, channel, state, completed_at
               ) values ($1, $2, 'IN_APP', $3, now())
               returning id`,
              [input.tenantId, intent.id, deliverInApp ? 'DELIVERED' : 'SUPPRESSED'],
            );
            if (!delivery) throw new Error('ADMIN_NOTIFICATION_IN_APP_DELIVERY_WRITE_LOST');
            if (deliverInApp) {
              const inbox = await queryOne<IdRow>(
                client,
                `insert into notifications.inbox_items (
                   tenant_id, intent_id, user_id, category, title, body, deep_link
                 ) values ($1, $2, $3, 'ADMIN_MESSAGE', $4, $5, $6)
                 returning id`,
                [
                  input.tenantId,
                  intent.id,
                  recipient.user_id,
                  input.title,
                  input.body,
                  input.deepLink ?? null,
                ],
              );
              if (!inbox) throw new Error('ADMIN_NOTIFICATION_INBOX_WRITE_LOST');
              await client.query(
                `insert into audit.outbox_events (
                   tenant_id, event_type, aggregate_id, correlation_id, payload
                 ) values
                   ($1, 'notifications.inbox.created.v1', $2, $4, $5::jsonb),
                   ($1, 'notifications.delivery.changed.v1', $3, $4, $6::jsonb)`,
                [
                  input.tenantId,
                  inbox.id,
                  delivery.id,
                  input.correlationId,
                  JSON.stringify({ inboxItemId: inbox.id, recipientUserId: recipient.user_id }),
                  JSON.stringify({ deliveryId: delivery.id, state: 'DELIVERED' }),
                ],
              );
              inAppCreatedCount += 1;
            } else {
              await client.query(
                `insert into audit.outbox_events (
                   tenant_id, event_type, aggregate_id, correlation_id, payload
                 ) values ($1, 'notifications.delivery.changed.v1', $2, $3, $4::jsonb)`,
                [
                  input.tenantId,
                  delivery.id,
                  input.correlationId,
                  JSON.stringify({ deliveryId: delivery.id, state: 'SUPPRESSED' }),
                ],
              );
            }
          }

          if (deliverWebPush) {
            const endpoints = await client.query<IdRow>(
              `select e.id
                 from integration.notification_endpoints e
                 join integration.notification_provider_accounts a
                   on a.tenant_id = e.tenant_id and a.id = e.provider_account_id
                where e.tenant_id = $1
                  and e.user_id = $2
                  and e.channel = 'PUSH'
                  and e.status = 'ACTIVE'
                  and a.channel = 'PUSH'
                  and a.platform = 'WEB'
                  and a.provider = 'WEB_PUSH'
                  and a.app_id = $3
                  and a.environment = $4
                  and a.status = 'ACTIVE'
                order by e.created_at`,
              [input.tenantId, recipient.user_id, input.webPushAppId, input.webPushEnvironment],
            );
            for (const endpoint of endpoints.rows) {
              const delivery = await queryOne<IdRow>(
                client,
                `insert into notifications.deliveries (
                   tenant_id, intent_id, channel, endpoint_id, state
                 ) values ($1, $2, 'PUSH', $3, 'PENDING')
                 returning id`,
                [input.tenantId, intent.id, endpoint.id],
              );
              if (!delivery) throw new Error('ADMIN_NOTIFICATION_PUSH_DELIVERY_WRITE_LOST');
              await client.query(
                `insert into audit.outbox_events (
                   tenant_id, event_type, aggregate_id, correlation_id, payload
                 ) values ($1, 'notifications.delivery.changed.v1', $2, $3, $4::jsonb)`,
                [
                  input.tenantId,
                  delivery.id,
                  input.correlationId,
                  JSON.stringify({ deliveryId: delivery.id, state: 'PENDING' }),
                ],
              );
              pushQueuedCount += 1;
            }
          }

          const recipientState = projectedChannels.length > 0 ? 'PROJECTED' : 'SUPPRESSED';
          if (recipientState === 'SUPPRESSED') suppressedCount += 1;
          await client.query(
            `insert into notifications.admin_campaign_recipients (
               tenant_id, campaign_id, user_id, intent_id, state,
               projected_channels, suppression_reasons, push_delivery_count
             ) values ($1, $2, $3, $4, $5, $6::text[], $7::text[], $8)`,
            [
              input.tenantId,
              campaign.id,
              recipient.user_id,
              intent.id,
              recipientState,
              projectedChannels,
              suppressionReasons,
              deliverWebPush ? recipient.web_push_endpoint_count : 0,
            ],
          );
        }

        await client.query(
          `update notifications.admin_campaigns
              set in_app_created_count = $3,
                  push_queued_count = $4,
                  suppressed_count = $5
            where tenant_id = $1 and id = $2`,
          [input.tenantId, campaign.id, inAppCreatedCount, pushQueuedCount, suppressedCount],
        );
        await client.query(
          `update notifications.admin_campaign_commands
              set campaign_id = $4, result_state = 'ACCEPTED', completed_at = now()
            where tenant_id = $1 and actor_user_id = $2 and idempotency_key = $3`,
          [input.tenantId, input.actorUserId, input.idempotencyKey, campaign.id],
        );
        await client.query(
          `insert into audit.audit_log (
             tenant_id, actor_id, action, resource_type, resource_id,
             result, correlation_id, new_value
           ) values ($1, $2, 'ADMIN_NOTIFICATION_CAMPAIGN_CREATED',
                     'NOTIFICATION_CAMPAIGN', $3, 'SUCCESS', $4, $5::jsonb)`,
          [
            input.tenantId,
            input.actorUserId,
            campaign.id,
            input.correlationId,
            JSON.stringify({
              requestedChannels: input.requestedChannels,
              inputCount,
              matchedCount: rows.length,
              unresolvedCount,
              inAppCreatedCount,
              pushQueuedCount,
              suppressedCount,
            }),
          ],
        );
        await client.query(
          `insert into audit.outbox_events (
             tenant_id, event_type, aggregate_id, correlation_id, payload
           ) values ($1, 'notifications.admin-campaign.accepted.v1', $2, $3, $4::jsonb)`,
          [
            input.tenantId,
            campaign.id,
            input.correlationId,
            JSON.stringify({
              campaignId: campaign.id,
              matchedCount: rows.length,
              requestedChannels: input.requestedChannels,
            }),
          ],
        );

        return {
          outcome: 'accepted',
          campaignId: campaign.id,
          matchedCount: rows.length,
          unresolvedCount,
          inAppCreatedCount,
          pushQueuedCount,
          suppressedCount,
          replayed: false,
        };
      });
    },
  };
}
