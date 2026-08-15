import {
  BOOKING_NOTIFICATION_AUDIENCE_SELECTOR,
  BOOKING_NOTIFICATION_DEFINITIONS,
  BOOKING_NOTIFICATION_LOCALE,
  BOOKING_NOTIFICATION_REQUEST_HASH,
  BOOKING_NOTIFICATION_RULE_ACTIVE,
  BOOKING_NOTIFICATION_RULE_CHANNEL_OVERRIDE,
  BOOKING_NOTIFICATION_RULE_KEY_SUFFIX,
  BOOKING_NOTIFICATION_RULESET_VERSION,
  BOOKING_NOTIFICATION_TEMPLATE_ACTIVE,
  BOOKING_NOTIFICATION_TEMPLATE_CATEGORY,
  BOOKING_NOTIFICATION_TEMPLATE_CHANNELS,
  BOOKING_NOTIFICATION_TEMPLATE_DEEP_LINK,
  BOOKING_NOTIFICATION_TEMPLATE_VERSION,
} from '@phub/notifications';
import type { PoolClient, QueryResultRow } from 'pg';

const bookingReminderDefinition = (() => {
  const definition = BOOKING_NOTIFICATION_DEFINITIONS.find(
    (candidate) => candidate.key === 'booking.reminder',
  );
  if (!definition) throw new Error('BOOKING_REMINDER_CONTRACT_MISSING');
  return definition;
})();

interface ReminderRuleRow extends QueryResultRow {
  readonly rule_key: string;
  readonly audience_selector: unknown;
  readonly channel_override: string[] | null;
  readonly mandatory: boolean;
  readonly template_key: string;
  readonly template_version: number;
  readonly template_locale: string;
  readonly template_category: string;
  readonly template_channels: string[];
  readonly title_template: string;
  readonly body_template: string;
  readonly deep_link_template: string | null;
  readonly template_active: boolean;
  readonly effective_channels: string[];
}

function hasExactChannels(actual: readonly string[] | null, expected: readonly string[]): boolean {
  return (
    actual !== null &&
    actual.length === expected.length &&
    actual.every((channel, index) => channel === expected[index])
  );
}

function hasExactAudienceSelector(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const selector = value as Record<string, unknown>;
  return (
    Object.keys(selector).sort().join(',') === 'field,type' &&
    selector.type === BOOKING_NOTIFICATION_AUDIENCE_SELECTOR.type &&
    selector.field === BOOKING_NOTIFICATION_AUDIENCE_SELECTOR.field
  );
}

function isCanonicalReminderRule(row: ReminderRuleRow): boolean {
  return (
    row.rule_key === `${bookingReminderDefinition.key}.${BOOKING_NOTIFICATION_RULE_KEY_SUFFIX}` &&
    hasExactAudienceSelector(row.audience_selector) &&
    hasExactChannels(row.channel_override, BOOKING_NOTIFICATION_RULE_CHANNEL_OVERRIDE) &&
    row.mandatory === bookingReminderDefinition.mandatory &&
    row.template_key === bookingReminderDefinition.key &&
    row.template_version === BOOKING_NOTIFICATION_TEMPLATE_VERSION &&
    row.template_locale === BOOKING_NOTIFICATION_LOCALE &&
    row.template_category === BOOKING_NOTIFICATION_TEMPLATE_CATEGORY &&
    hasExactChannels(row.template_channels, BOOKING_NOTIFICATION_TEMPLATE_CHANNELS) &&
    row.title_template === bookingReminderDefinition.title &&
    row.body_template === bookingReminderDefinition.body &&
    row.deep_link_template === BOOKING_NOTIFICATION_TEMPLATE_DEEP_LINK &&
    row.template_active === BOOKING_NOTIFICATION_TEMPLATE_ACTIVE
  );
}

export async function assertCanonicalBookingReminderReady(
  client: Pick<PoolClient, 'query'>,
  tenantId: string,
  desiredRuntime: { readonly inAppEnabled: boolean; readonly webPushEnabled: boolean },
  lock: boolean,
): Promise<void> {
  const provisioned = await client.query(
    `select idempotency_key
       from notifications.ruleset_provision_commands
      where tenant_id = $1
        and ruleset_version = $2
        and request_hash = $3
      order by created_at desc, idempotency_key
      limit 1
      ${lock ? 'for share' : ''}`,
    [tenantId, BOOKING_NOTIFICATION_RULESET_VERSION, BOOKING_NOTIFICATION_REQUEST_HASH],
  );
  if ((provisioned.rowCount ?? 0) !== 1) {
    throw new Error('BOOKING_REMINDER_NOTIFICATION_RULE_NOT_READY');
  }

  const rules = await client.query<ReminderRuleRow>(
    `select trigger_rule.rule_key,
            trigger_rule.audience_selector,
            trigger_rule.channel_override,
            trigger_rule.mandatory,
            template.template_key,
            template.version as template_version,
            template.locale as template_locale,
            template.category as template_category,
            template.channels as template_channels,
            template.title_template,
            template.body_template,
            template.deep_link_template,
            template.active as template_active,
            coalesce(trigger_rule.channel_override, template.channels) as effective_channels
       from notifications.trigger_rules trigger_rule
       join notifications.templates template
         on template.tenant_id = trigger_rule.tenant_id
        and template.id = trigger_rule.template_id
      where trigger_rule.tenant_id = $1
        and trigger_rule.source_event_type = $2
        and trigger_rule.active = $3
      order by trigger_rule.rule_key
      ${lock ? 'for share of trigger_rule, template' : ''}`,
    [tenantId, bookingReminderDefinition.sourceEventType, BOOKING_NOTIFICATION_RULE_ACTIVE],
  );
  const rule = rules.rows[0];
  if (rules.rows.length !== 1 || !rule) {
    throw new Error('BOOKING_REMINDER_NOTIFICATION_RULE_NOT_READY');
  }

  const desiredChannels = new Set<string>([
    ...(desiredRuntime.inAppEnabled ? ['IN_APP'] : []),
    ...(desiredRuntime.webPushEnabled ? ['PUSH'] : []),
  ]);
  if (!rule.effective_channels.some((channel) => desiredChannels.has(channel))) {
    throw new Error('BOOKING_REMINDER_NOTIFICATION_CHANNEL_NOT_READY');
  }
  if (!isCanonicalReminderRule(rule)) {
    throw new Error('BOOKING_REMINDER_NOTIFICATION_RULE_NOT_READY');
  }
}
