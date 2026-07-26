import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('GAME conversation backfill', () => {
  it('is bounded, dry-run by default and audits an explicit apply', async () => {
    const source = await readFile(
      resolve(process.cwd(), 'scripts/backfill-game-conversations.ts'),
      'utf8',
    );

    expect(source).toContain("const CONFIRMATION_TOKEN = 'BACKFILL_GAME_CONVERSATIONS'");
    expect(source).toContain("value ?? '50'");
    expect(source).toContain('parsed > 500');
    expect(source).toContain("mode: confirm === CONFIRMATION_TOKEN ? 'apply' : 'dry-run'");
    expect(source).toContain("'GAME_CONVERSATION_BACKFILL'");
    expect(source).toContain("game.lifecycle_state in ('SCHEDULED', 'IN_PROGRESS', 'FINISHED')");
    expect(source).not.toMatch(/viva|external_id/i);
  });

  it('is bundled into the immutable migrator image for Nano operations', async () => {
    const buildConfig = await readFile(
      resolve(process.cwd(), 'apps/migrator/tsup.config.ts'),
      'utf8',
    );
    const dockerfile = await readFile(resolve(process.cwd(), 'apps/migrator/Dockerfile'), 'utf8');

    expect(buildConfig).toContain(
      "'backfill-game-conversations': '../../scripts/backfill-game-conversations.ts'",
    );
    expect(buildConfig).toContain(
      "'set-messaging-runtime': '../../scripts/set-messaging-runtime.ts'",
    );
    expect(dockerfile).toContain('COPY --from=build /workspace/apps ./apps');
  });
});
