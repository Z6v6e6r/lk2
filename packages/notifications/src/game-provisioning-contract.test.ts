import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('GAME notification provisioning contract', () => {
  it('is explicit, audited, idempotent and leaves runtime gates default-off', async () => {
    const [source, contract] = await Promise.all([
      readFile(
        new URL('../../../scripts/provision-game-notifications.ts', import.meta.url),
        'utf8',
      ),
      readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    ]);

    expect(source).toContain("const CONFIRMATION_TOKEN = 'APPLY_GAME_NOTIFICATION_RULESET'");
    expect(contract).toContain("rulesetVersion: 'game.ru-ru.v1'");
    expect(contract).toContain("deepLink: '/games/{{gameId}}'");
    expect(contract).toContain("sourceEventType: 'game.participation.confirmed.v1'");
    expect(contract).toContain("sourceEventType: 'game.participation.left.v1'");
    expect(contract).toContain("sourceEventType: 'game.cancelled.v1'");
    expect(contract).toContain("field: 'userId'");
    expect(contract).toContain("field: 'participantUserIds'");
    expect(source).toContain('notifications.ruleset_provision_commands');
    expect(source).toContain('GAME_NOTIFICATION_REQUEST_HASH');
    expect(source).toContain('GAME_NOTIFICATION_RULESET_PROVISIONED');
    expect(source).toContain('JSON.stringify(definition.audienceSelector)');
    expect(source).toContain("'admin' = any(access.roles)");
    expect(source).toContain("'notifications.manage' = any(access.permissions)");
    expect(
      source.match(/assertNotificationAdminAccess\(client, tenantId, actorId\)/g),
    ).toHaveLength(2);
    expect(source).toContain('`notification-runtime:${tenantId}`');
    expect(source).toContain('runtimeChangedByThisCommand: false');
    expect(source).not.toContain('insert into notifications.tenant_runtime_settings');
    expect(source).not.toContain('update notifications.tenant_runtime_settings');
  });
});
