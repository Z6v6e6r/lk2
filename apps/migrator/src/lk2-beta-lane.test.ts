import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  assertLk2BetaLaneTarget,
  assertLk2RuntimeGrants,
  LK2_BETA_LANE_TARGET,
  lk2RuntimeGrants,
  lk2RuntimeGrantStatements,
} from './lk2-beta-lane.js';

const target = {
  database_name: 'phub_beta',
  system_identifier: '7679125609183186977',
  recovery: false,
  superuser: true,
  runtime_role: true,
};

describe('lk2 beta lane target binding', () => {
  it('accepts only the exact disposable lk2 cluster as superuser', () => {
    expect(() => assertLk2BetaLaneTarget(target)).not.toThrow();
    expect(() => assertLk2BetaLaneTarget(undefined)).toThrow('LK2_BETA_LANE_TARGET_MISMATCH');
    expect(() => assertLk2BetaLaneTarget({ ...target, database_name: 'phub' })).toThrow(
      'LK2_BETA_LANE_TARGET_MISMATCH',
    );
    expect(() =>
      assertLk2BetaLaneTarget({ ...target, system_identifier: '7679125609183186978' }),
    ).toThrow('LK2_BETA_LANE_TARGET_MISMATCH');
    expect(() => assertLk2BetaLaneTarget({ ...target, recovery: true })).toThrow(
      'LK2_BETA_LANE_TARGET_IN_RECOVERY',
    );
    expect(() => assertLk2BetaLaneTarget({ ...target, superuser: false })).toThrow(
      'LK2_BETA_LANE_SUPERUSER_REQUIRED',
    );
    expect(() => assertLk2BetaLaneTarget({ ...target, runtime_role: false })).toThrow(
      'LK2_BETA_LANE_RUNTIME_ROLE_MISSING',
    );
  });

  it('uses the same cluster identity as the checked-in Timeweb target contracts', async () => {
    const tail = JSON.parse(await readFile('deploy/timeweb/r1-tail108-119.v1.json', 'utf8')) as {
      target: { databaseName: string; systemIdentifier: string };
    };
    expect(tail.target).toMatchObject(LK2_BETA_LANE_TARGET);
  });
});

describe('lk2 beta lane runtime grants', () => {
  it('covers every table created by 0102-0115 and nothing else', async () => {
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir('packages/database/migrations'))
      .filter((file) => file >= '0102' && file < '0116')
      .sort();
    const created = new Set<string>();
    for (const file of files) {
      const sql = await readFile(`packages/database/migrations/${file}`, 'utf8');
      for (const match of sql.matchAll(/create table (?:if not exists )?([a-z_]+\.[a-z_]+)/gi))
        created.add(match[1]!.toLowerCase());
    }
    expect(lk2RuntimeGrants().map((grant) => grant.relation)).toEqual([...created].sort());
  });

  it('grants the reviewed post-119 matrix and keeps narrower command receipts narrow', () => {
    const grants = new Map(lk2RuntimeGrants().map((grant) => [grant.relation, grant]));
    expect(grants.get('identity.external_subject_link_commands')).toEqual({
      relation: 'identity.external_subject_link_commands',
      privileges: ['INSERT', 'SELECT'],
      updateColumns: ['completed_at', 'outcome'],
    });
    expect(grants.get('commerce.monthly_purchase_launches')).toEqual({
      relation: 'commerce.monthly_purchase_launches',
      privileges: ['INSERT', 'SELECT'],
      updateColumns: ['used_at'],
    });
    expect(grants.get('locations.recommendation_card_photos')?.privileges).toEqual([
      'DELETE',
      'INSERT',
      'SELECT',
    ]);
    expect(grants.get('integration.game_create_location_bindings')?.privileges).toEqual([
      'INSERT',
      'SELECT',
      'UPDATE',
    ]);
    for (const grant of grants.values()) {
      expect(grant.privileges).not.toContain('TRUNCATE');
      if (grant.privileges.includes('UPDATE')) expect(grant.updateColumns).toEqual([]);
    }
  });

  it('renders revoke-then-grant statements with quoted identifiers', () => {
    const statements = lk2RuntimeGrantStatements([
      {
        relation: 'commerce.monthly_purchase_launches',
        privileges: ['INSERT', 'SELECT'],
        updateColumns: ['used_at'],
      },
    ]);
    expect(statements).toEqual([
      'revoke all on table "commerce"."monthly_purchase_launches" from "phub_runtime"',
      'grant INSERT, SELECT on table "commerce"."monthly_purchase_launches" to "phub_runtime"',
      'grant update ("used_at") on table "commerce"."monthly_purchase_launches" to "phub_runtime"',
    ]);
    expect(() =>
      lk2RuntimeGrantStatements([
        { relation: 'x.y; drop', privileges: ['SELECT'], updateColumns: [] },
      ]),
    ).toThrow('LK2_BETA_LANE_IDENTIFIER');
  });

  it('verifies the exact table-level privileges after granting', () => {
    const grants = [{ relation: 'a.b', privileges: ['SELECT'] as const, updateColumns: [] }].map(
      (grant) => ({ ...grant, privileges: [...grant.privileges] }),
    );
    const ok = { relation: 'a.b', present: true, schema_usage: true, privileges: ['SELECT'] };
    expect(() => assertLk2RuntimeGrants([ok], grants)).not.toThrow();
    expect(() => assertLk2RuntimeGrants([{ ...ok, present: false }], grants)).toThrow(
      'LK2_BETA_LANE_GRANT_RELATION_MISSING:a.b',
    );
    expect(() => assertLk2RuntimeGrants([{ ...ok, schema_usage: false }], grants)).toThrow(
      'LK2_BETA_LANE_SCHEMA_USAGE_MISSING:a.b',
    );
    expect(() =>
      assertLk2RuntimeGrants([{ ...ok, privileges: ['SELECT', 'DELETE'] }], grants),
    ).toThrow('LK2_BETA_LANE_GRANT_MISMATCH:a.b');
    expect(() => assertLk2RuntimeGrants([], grants)).toThrow('LK2_BETA_LANE_GRANT_VERIFY');
  });
});

describe('lk2 beta lane entrypoint', () => {
  it('keeps the ordinary guard block free of the beta mode', async () => {
    const source = await readFile('apps/migrator/src/migration-runner.ts', 'utf8');
    const compatibility =
      'assertMigrationLedgerCompatible({ applied, packaged: packagedMigrations });';
    const start = source.indexOf(compatibility) + compatibility.length;
    const guards = source.slice(start, source.indexOf('const appliedFilenames', start));
    expect(guards).not.toContain('lk2');
    // The target binding runs before the first DDL of the beta mode.
    const binding = source.indexOf('assertLk2BetaLaneTarget(');
    expect(binding).toBeGreaterThan(start);
    expect(binding).toBeLessThan(
      source.indexOf('create table if not exists public.schema_migrations'),
    );
  });
});
