import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  COMMUNITIES_STAGED_REHEARSAL_CONFIRMATION,
  COMMUNITIES_STAGED_REHEARSAL_FOUNDATION_FILENAMES,
  COMMUNITIES_STAGED_REHEARSAL_PENDING_FILENAMES,
  COMMUNITIES_STAGED_REHEARSAL_POST_FOUNDATION_FILENAMES,
  COMMUNITIES_STAGED_REHEARSAL_PRE_FOUNDATION_FILENAMES,
  resolveCommunitiesStagedRehearsalRequest,
  selectCommunitiesStagedRehearsalMigrations,
} from './communities-staged-rehearsal-policy.js';

const restoreDatabase = 'phub_restore_31944858210_1';
const connectionString = `postgresql://migrator:secret@postgres:5432/${restoreDatabase}`;

function request(phase: 'pre_foundation' | 'foundation' | 'post_foundation') {
  const value = resolveCommunitiesStagedRehearsalRequest({
    confirmation: COMMUNITIES_STAGED_REHEARSAL_CONFIRMATION,
    phase,
    restoreDatabase,
    connectionString,
  });
  expect(value).not.toBeNull();
  return value!;
}

describe('Communities staged migration rehearsal policy', () => {
  it('does not affect an ordinary migrator invocation', () => {
    expect(resolveCommunitiesStagedRehearsalRequest({ connectionString })).toBeNull();
  });

  it.each([
    { confirmation: 'yes', phase: 'pre_foundation', restoreDatabase },
    { confirmation: COMMUNITIES_STAGED_REHEARSAL_CONFIRMATION, phase: 'unknown', restoreDatabase },
    {
      confirmation: COMMUNITIES_STAGED_REHEARSAL_CONFIRMATION,
      phase: 'pre_foundation',
      restoreDatabase: 'production',
    },
  ])('rejects an invalid staged request before database access', (input) => {
    expect(() => resolveCommunitiesStagedRehearsalRequest({ ...input, connectionString })).toThrow(
      'COMMUNITIES_STAGED_REHEARSAL_',
    );
  });

  it.each([
    `postgresql://migrator:secret@db.example.test:5432/${restoreDatabase}`,
    `postgresql://migrator:secret@postgres:5433/${restoreDatabase}`,
    `postgresql://migrator:secret@postgres:5432/production`,
    `postgresql://migrator:secret@postgres:5432/${restoreDatabase}?sslmode=disable`,
  ])('rejects a non-local or ambiguous database target before access: %s', (target) => {
    expect(() =>
      resolveCommunitiesStagedRehearsalRequest({
        confirmation: COMMUNITIES_STAGED_REHEARSAL_CONFIRMATION,
        phase: 'pre_foundation',
        restoreDatabase,
        connectionString: target,
      }),
    ).toThrow('COMMUNITIES_STAGED_REHEARSAL_DATABASE_');
  });

  it('selects the exact three phases for the reviewed 29-file pending set', () => {
    const packaged = ['0001_initial.sql', ...COMMUNITIES_STAGED_REHEARSAL_PENDING_FILENAMES];
    const initiallyApplied = new Set(['0001_initial.sql']);
    expect(
      selectCommunitiesStagedRehearsalMigrations({
        request: request('pre_foundation'),
        appliedFilenames: initiallyApplied,
        packagedFilenames: packaged,
      }),
    ).toEqual(COMMUNITIES_STAGED_REHEARSAL_PRE_FOUNDATION_FILENAMES);

    const afterPre = new Set([
      ...initiallyApplied,
      ...COMMUNITIES_STAGED_REHEARSAL_PRE_FOUNDATION_FILENAMES,
    ]);
    expect(
      selectCommunitiesStagedRehearsalMigrations({
        request: request('foundation'),
        appliedFilenames: afterPre,
        packagedFilenames: packaged,
      }),
    ).toEqual(COMMUNITIES_STAGED_REHEARSAL_FOUNDATION_FILENAMES);

    const afterFoundation = new Set([
      ...afterPre,
      ...COMMUNITIES_STAGED_REHEARSAL_FOUNDATION_FILENAMES,
    ]);
    expect(
      selectCommunitiesStagedRehearsalMigrations({
        request: request('post_foundation'),
        appliedFilenames: afterFoundation,
        packagedFilenames: packaged,
      }),
    ).toEqual(COMMUNITIES_STAGED_REHEARSAL_POST_FOUNDATION_FILENAMES);
  });

  it.each([
    ['missing one reviewed file', COMMUNITIES_STAGED_REHEARSAL_PENDING_FILENAMES.slice(1)],
    [
      'contains an additional pending file',
      [...COMMUNITIES_STAGED_REHEARSAL_PENDING_FILENAMES, '0084_unreviewed.sql'],
    ],
    [
      'is a partial retry after a committed migration',
      COMMUNITIES_STAGED_REHEARSAL_PENDING_FILENAMES.slice(1),
    ],
  ])('fails closed when the initial pending set %s', (_label, pending) => {
    expect(() =>
      selectCommunitiesStagedRehearsalMigrations({
        request: request('pre_foundation'),
        appliedFilenames: new Set(['0001_initial.sql']),
        packagedFilenames: ['0001_initial.sql', ...pending],
      }),
    ).toThrow('COMMUNITIES_STAGED_REHEARSAL_PENDING_SET_MISMATCH');
  });

  it('validates clone-only targeting before opening a database pool and before DDL', () => {
    const entrypoint = readFileSync(
      new URL('../../../apps/migrator/src/communities-staged-rehearsal.ts', import.meta.url),
      'utf8',
    );
    const runner = readFileSync(
      new URL('../../../apps/migrator/src/migration-runner.ts', import.meta.url),
      'utf8',
    );
    const ordinaryEntrypoint = readFileSync(
      new URL('../../../apps/migrator/src/main.ts', import.meta.url),
      'utf8',
    );
    const requestGuard = entrypoint.indexOf('resolveCommunitiesStagedRehearsalRequest({');
    const stagedRun = entrypoint.indexOf("mode: 'communities_staged_rehearsal'");
    const phaseGuard = runner.indexOf('selectCommunitiesStagedRehearsalMigrations({');
    const schemaMutation = runner.indexOf('create table if not exists public.schema_migrations');

    expect(requestGuard).toBeGreaterThanOrEqual(0);
    expect(requestGuard).toBeLessThan(stagedRun);
    expect(phaseGuard).toBeLessThan(schemaMutation);
    expect(runner).toContain('if (stagedFilenames && !stagedFilenames.has(filename)) continue;');
    expect(ordinaryEntrypoint).toContain("runMigrationProcess({ mode: 'ordinary' })");
    expect(ordinaryEntrypoint).not.toContain('COMMUNITIES_STAGED_REHEARSAL');
  });
});
