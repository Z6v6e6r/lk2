import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The operator report claims to count reachability the way the CUP resolver does. Both sides build
 * their own SQL, so this pins the shared predicate: a change to one without the other would make the
 * report disagree with the campaign preview exactly where it matters.
 */
describe('phone anomaly report matches the resolver reachability predicate', () => {
  const normalize = (sql: string): string => sql.replace(/\s+/gu, ' ');

  const sharedClauses = [
    "e.channel = 'PUSH'",
    "e.status = 'ACTIVE'",
    "a.channel = 'PUSH'",
    "a.platform = 'WEB'",
    "a.provider = 'WEB_PUSH'",
    'a.app_id = $',
    'a.environment = $',
    "a.status = 'ACTIVE'",
  ];

  it('uses the same active Web Push endpoint predicate as the resolver', async () => {
    const repository = normalize(
      await readFile(
        resolve(process.cwd(), 'packages/database/src/admin-notification-repository.ts'),
        'utf8',
      ),
    );
    const report = normalize(
      await readFile(resolve(process.cwd(), 'scripts/report-phone-identity-anomalies.ts'), 'utf8'),
    );

    for (const clause of sharedClauses) {
      expect(repository).toContain(clause);
      expect(report).toContain(clause);
    }
    // The resolver does not filter the provider system, but the report must: the writer always pins
    // VIVA, so a row from another system would be a false anomaly.
    expect(report).toContain("m.external_system = 'VIVA'");
    expect(report.match(/m\.external_system = 'VIVA'/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
