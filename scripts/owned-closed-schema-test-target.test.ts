import { describe, expect, it } from 'vitest';
import { ownedClosedSchemaLocalFixtureUrl } from './owned-closed-schema-test-target.js';

describe('explicit owned local schema fixture target', () => {
  it('ignores ordinary shared database settings without explicit local test opt-in', () => {
    expect(
      ownedClosedSchemaLocalFixtureUrl({
        DATABASE_URL: 'postgresql://runtime:synthetic@shared.internal/production',
      }),
    ).toBeUndefined();
  });
  it('rejects missing owned-container markers before any connection', () => {
    expect(() =>
      ownedClosedSchemaLocalFixtureUrl({
        CLOSED_SINGLE_MIGRATION_PG_TESTS: '1',
        CLOSED_SINGLE_MIGRATION_DATABASE_URL: 'postgresql://phub:synthetic@127.0.0.1:5432/phub',
      }),
    ).toThrow('CLOSED_SINGLE_LOCAL_OWNER');
  });
  it('rejects non-loopback, foreign database/user, query or fragment before Docker access', () => {
    for (const value of [
      'postgresql://phub:synthetic@db.internal:5432/phub',
      'postgresql://runtime:synthetic@127.0.0.1:5432/phub',
      'postgresql://phub:synthetic@127.0.0.1:5432/production',
      'postgresql://phub:synthetic@127.0.0.1:5432/phub?sslmode=require',
      'postgresql://phub:synthetic@127.0.0.1:5432/phub#x',
    ])
      expect(() =>
        ownedClosedSchemaLocalFixtureUrl({
          CLOSED_SINGLE_MIGRATION_PG_TESTS: '1',
          CLOSED_SINGLE_MIGRATION_DATABASE_URL: value,
        }),
      ).toThrow('CLOSED_SINGLE_TEST_TARGET');
  });
});
