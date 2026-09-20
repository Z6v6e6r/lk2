import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('FRIENDSHIP notification provisioning contract', () => {
  it('is explicit, audited, idempotent and leaves runtime gates default-off', async () => {
    const [source, contract] = await Promise.all([
      readFile(
        new URL('../../../scripts/provision-friendship-notifications.ts', import.meta.url),
        'utf8',
      ),
      readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    ]);

    expect(source).toContain("const CONFIRMATION_TOKEN = 'APPLY_FRIENDSHIP_NOTIFICATION_RULESET'");
    expect(contract).toContain("rulesetVersion: 'friendship.ru-ru.v1'");
    expect(contract).toContain("deepLink: '/notifications'");
    expect(contract).toContain("sourceEventType: 'profile.friend_request.created.v1'");
    expect(contract).toContain("category: 'FRIENDSHIP'");
    expect(contract).toContain("field: 'recipientUserIds'");
    // A saved request is worthless if the addressed player only finds it after opening the cabinet.
    expect(contract).toContain("channels: ['IN_APP', 'PUSH']");
    expect(source).toContain('notifications.ruleset_provision_commands');
    expect(source).toContain('FRIENDSHIP_NOTIFICATION_REQUEST_HASH');
    expect(source).toContain('FRIENDSHIP_NOTIFICATION_RULESET_PROVISIONED');
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
    expect(insert).not.toContain('FRIENDSHIP_NOTIFICATION_TEMPLATE_ACTIVE');
    expect(source).not.toContain('insert into notifications.tenant_runtime_settings');
    expect(source).not.toContain('update notifications.tenant_runtime_settings');
    // The rendered text never quotes the requester or a profile detail.
    expect(source).not.toContain('{{requesterUserId}}');
    expect(source).not.toContain('{{displayName}}');
  });
});
