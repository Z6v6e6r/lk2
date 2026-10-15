import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('MESSAGING notification provisioning contract', () => {
  it('is explicit, audited, idempotent and leaves runtime gates default-off', async () => {
    const [source, contract] = await Promise.all([
      readFile(
        new URL('../../../scripts/provision-messaging-notifications.ts', import.meta.url),
        'utf8',
      ),
      readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    ]);

    expect(source).toContain("const CONFIRMATION_TOKEN = 'APPLY_MESSAGING_NOTIFICATION_RULESET'");
    expect(contract).toContain("rulesetVersion: 'messaging.ru-ru.v3'");
    expect(contract).toContain("deepLink: '/chats/{{conversationId}}'");
    expect(contract).toContain("sourceEventType: 'messaging.conversation.created.v1'");
    expect(contract).toContain("sourceEventType: 'messaging.message.created.v1'");
    expect(contract).toContain("field: 'recipientUserIds'");
    // A provisioned template version can never change its channels, so opening PUSH moves both
    // the template and the ruleset version forward.
    const messagingContract = contract.slice(
      contract.indexOf('export const MESSAGING_NOTIFICATION_CANONICAL_CONTRACT'),
      contract.indexOf('export const MESSAGING_NOTIFICATION_RULESET_VERSION'),
    );
    expect(messagingContract).toContain("channels: ['IN_APP', 'PUSH']");
    expect(messagingContract).toContain("channelOverride: ['IN_APP', 'PUSH']");
    expect(messagingContract).toContain('version: 3,');
    expect(source).toContain('notifications.ruleset_provision_commands');
    expect(source).toContain('MESSAGING_NOTIFICATION_REQUEST_HASH');
    expect(source).toContain('MESSAGING_NOTIFICATION_RULESET_PROVISIONED');
    expect(source).toContain('JSON.stringify(definition.audienceSelector)');
    expect(source).toContain("'admin' = any(access.roles)");
    expect(source).toContain("'notifications.manage' = any(access.permissions)");
    expect(
      source.match(/assertNotificationAdminAccess\(client, tenantId, actorId\)/g),
    ).toHaveLength(2);
    expect(source).toContain('`notification-runtime:${tenantId}`');
    expect(source).toContain('runtimeChangedByThisCommand: false');
    // The schema keeps at most one active template per (template_key, locale), so a new
    // version must land inactive and be activated only after the previous one is retired.
    const insert = source.slice(
      source.indexOf('insert into notifications.templates'),
      source.indexOf('const template = await queryOne'),
    );
    expect(insert).toContain('false,');
    expect(insert).not.toContain('MESSAGING_NOTIFICATION_TEMPLATE_ACTIVE');
    expect(source).not.toContain('insert into notifications.tenant_runtime_settings');
    expect(source).not.toContain('update notifications.tenant_runtime_settings');
    // The identifier-only payload is the reason for this ruleset; no message body is rendered.
    expect(source).not.toContain('{{body}}');
  });

  it('splits chats by context and carries the previous category decision forward', async () => {
    const [source, contract] = await Promise.all([
      readFile(
        new URL('../../../scripts/provision-messaging-notifications.ts', import.meta.url),
        'utf8',
      ),
      readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    ]);

    // Every definition owns its category, so the settings screen offers one switch per chat context.
    expect(source).toContain('row.category === definition.category');
    expect(source).toContain('definition.category,');
    expect(source).toContain('categories: [...MESSAGING_NOTIFICATION_CATEGORIES]');
    const messagingContract = contract.slice(
      contract.indexOf('export const MESSAGING_NOTIFICATION_CANONICAL_CONTRACT'),
      contract.indexOf('export const MESSAGING_NOTIFICATION_RULESET_VERSION'),
    );
    for (const category of ['CHAT_DIRECT', 'CHAT_GAME']) {
      expect(messagingContract).toContain(`category: '${category}'`);
    }
    // Two contexts times two chat facts, each rule matching only its own conversation kind.
    expect([...messagingContract.matchAll(/category: 'CHAT_/g)]).toHaveLength(4);
    expect([...messagingContract.matchAll(/match: \{ field: /g)]).toHaveLength(4);
    expect(messagingContract).toContain("match: { field: 'kind', oneOf: ['DIRECT'] }");
    expect(messagingContract).toContain("match: { field: 'conversationKind', oneOf: ['GAME'] }");

    // v2 left one active `MESSAGING` rule per event. Both would fire for the same fact, so the new
    // version must retire every `messaging.*` artifact it does not own instead of notifying twice.
    expect(source).toContain("rule_key like 'messaging.%'");
    expect(source).toContain("template_key like 'messaging.%'");
    expect(source).toContain('not (rule_key = any($2::text[]))');
    expect(source).toContain('not (template_key = any($2::text[]))');
    expect(source).toContain('retiredRuleKeys');
    expect(source).toContain('retiredTemplateKeys');
    // A recipient who muted the aggregated category keeps that decision per context; the copy never
    // overwrites a category/channel the recipient has already set.
    expect(source).toContain("and legacy.category = 'MESSAGING'");
    expect(source).toContain('on conflict (tenant_id, user_id, category, channel) do nothing');
    expect(source).toContain('carriedPreferenceRows');
  });
});
