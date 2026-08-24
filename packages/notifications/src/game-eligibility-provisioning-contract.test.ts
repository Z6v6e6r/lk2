import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('game eligibility notification provisioning contract', () => {
  it('is explicit, audited and does not change notification runtime gates', async () => {
    const [source, contract] = await Promise.all([
      readFile(
        new URL('../../../scripts/provision-game-eligibility-notifications.ts', import.meta.url),
        'utf8',
      ),
      readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    ]);

    expect(source).toContain(
      "const CONFIRMATION_TOKEN = 'APPLY_GAME_ELIGIBILITY_NOTIFICATION_RULESET'",
    );
    expect(contract).toContain("rulesetVersion: 'game-eligibility.ru-ru.v1'");
    expect(contract).toContain("sourceEventType: 'game.waitlist.promotion.denied.v1'");
    expect(contract).toContain("field: 'userId'");
    expect(contract).toContain("deepLink: '/games/{{aggregateId}}'");
    expect(source).toContain('GAME_ELIGIBILITY_NOTIFICATION_REQUEST_HASH');
    expect(source).toContain('notifications.ruleset_provision_commands');
    expect(source).toContain('IDEMPOTENCY_KEY_REUSED');
    expect(source).toContain('GAME_ELIGIBILITY_NOTIFICATION_RULESET_PROVISIONED');
    expect(source).toContain("'notifications.manage' = any(access.permissions)");
    expect(source).toContain('on conflict (tenant_id, template_key, version, locale) do nothing');
    expect(source).toContain('on conflict (tenant_id, rule_key) do update set');
    expect(source).not.toContain('insert into notifications.tenant_runtime_settings');
    expect(source).not.toContain('update notifications.tenant_runtime_settings');
  });
});
