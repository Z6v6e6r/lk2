import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('game result command transaction boundary', () => {
  it('keeps result, idempotency, audit and outbox writes in the tenant transaction', async () => {
    const source = await readFile(
      resolve(process.cwd(), 'packages/database/src/game-result-repository.ts'),
      'utf8',
    );

    expect(source).toContain('withTenantTransaction');
    expect(source).toContain('games.command_idempotency');
    expect(source).toContain('audit.audit_log');
    expect(source).toContain('audit.outbox_events');
    expect(source).toContain("type: 'game.result.confirmed.v1'");
    expect(source).toContain('games.result_sets');
    expect(source).toContain('games.result_set_players');
    expect(source).not.toMatch(/fetch\(|axios|viva|legacy/i);
  });
});
