import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  COMMUNITIES_STAGED_REHEARSAL_CONFIRMATION,
  COMMUNITIES_STAGED_REHEARSAL_32_CONFIRMATION,
  COMMUNITIES_STAGED_REHEARSAL_32_PENDING_FILENAMES,
  COMMUNITIES_STAGED_REHEARSAL_ELIGIBILITY_PAYMENT_FILENAMES,
  COMMUNITIES_STAGED_REHEARSAL_FOUNDATION_FILENAMES,
  COMMUNITIES_STAGED_REHEARSAL_PENDING_FILENAMES,
  COMMUNITIES_STAGED_REHEARSAL_POST_FOUNDATION_FILENAMES,
  COMMUNITIES_STAGED_REHEARSAL_PRE_FOUNDATION_FILENAMES,
  communitiesStagedRehearsalPendingSetSha256,
  resolveCommunitiesStagedRehearsalRequest,
  selectCommunitiesStagedRehearsalMigrations,
} from './communities-staged-rehearsal-policy.js';
import {
  ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256,
  ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION,
} from './eligibility-payment-acl-matrix.js';

const restoreDatabase = 'phub_restore_31944858210_1';
const connectionString = `postgresql://migrator:secret@postgres:5432/${restoreDatabase}`;

function request(
  phase: 'pre_foundation' | 'foundation' | 'post_foundation' | 'eligibility_payment',
  confirmation = COMMUNITIES_STAGED_REHEARSAL_CONFIRMATION,
) {
  if (confirmation === COMMUNITIES_STAGED_REHEARSAL_32_CONFIRMATION) {
    return {
      contractVersion: '32_V1' as const,
      phase,
      restoreDatabase,
      aclMatrixVersion: ELIGIBILITY_PAYMENT_ACL_MATRIX_VERSION,
      aclMatrixSha256: ELIGIBILITY_PAYMENT_ACL_MATRIX_SHA256,
    };
  }
  const value = resolveCommunitiesStagedRehearsalRequest({
    confirmation,
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

  it('binds each version to the SHA-256 of its ordered pending filenames', () => {
    expect(
      communitiesStagedRehearsalPendingSetSha256(COMMUNITIES_STAGED_REHEARSAL_PENDING_FILENAMES),
    ).toBe('13b5ca1d0930fdc4b67852f01418c27f8946f538f2311d7e5f755ecb2df12747');
    expect(
      communitiesStagedRehearsalPendingSetSha256(COMMUNITIES_STAGED_REHEARSAL_32_PENDING_FILENAMES),
    ).toBe('f5ea040e4498a45310ad671f321e3044c33743ca7b0cbee7c72bc01ee9b6a91d');
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

  it('rejects the preparation-only 32-file contract at the migrator policy boundary', () => {
    expect(() =>
      resolveCommunitiesStagedRehearsalRequest({
        confirmation: COMMUNITIES_STAGED_REHEARSAL_32_CONFIRMATION,
        phase: 'pre_foundation',
        restoreDatabase,
        connectionString,
      }),
    ).toThrow('COMMUNITIES_STAGED_REHEARSAL_32_ACL_MATRIX_REQUIRED');
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

  it('keeps the 29-file contract frozen when the 32-file contract is present', () => {
    const packaged = ['0001_initial.sql', ...COMMUNITIES_STAGED_REHEARSAL_32_PENDING_FILENAMES];
    expect(() =>
      selectCommunitiesStagedRehearsalMigrations({
        request: request('pre_foundation'),
        appliedFilenames: new Set(['0001_initial.sql']),
        packagedFilenames: packaged,
      }),
    ).toThrow('COMMUNITIES_STAGED_REHEARSAL_PENDING_SET_MISMATCH');
  });

  it('selects the exact four phases for the reviewed 32-file pending set', () => {
    const packaged = ['0001_initial.sql', ...COMMUNITIES_STAGED_REHEARSAL_32_PENDING_FILENAMES];
    const initiallyApplied = new Set(['0001_initial.sql']);
    const confirmation = COMMUNITIES_STAGED_REHEARSAL_32_CONFIRMATION;
    expect(
      selectCommunitiesStagedRehearsalMigrations({
        request: request('pre_foundation', confirmation),
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
        request: request('foundation', confirmation),
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
        request: request('post_foundation', confirmation),
        appliedFilenames: afterFoundation,
        packagedFilenames: packaged,
      }),
    ).toEqual(COMMUNITIES_STAGED_REHEARSAL_POST_FOUNDATION_FILENAMES);

    const afterPostFoundation = new Set([
      ...afterFoundation,
      ...COMMUNITIES_STAGED_REHEARSAL_POST_FOUNDATION_FILENAMES,
    ]);
    expect(
      selectCommunitiesStagedRehearsalMigrations({
        request: request('eligibility_payment', confirmation),
        appliedFilenames: afterPostFoundation,
        packagedFilenames: packaged,
      }),
    ).toEqual(COMMUNITIES_STAGED_REHEARSAL_ELIGIBILITY_PAYMENT_FILENAMES);
  });

  it('rejects a 32-file phase when its contract version does not match', () => {
    expect(() =>
      selectCommunitiesStagedRehearsalMigrations({
        request: request('eligibility_payment', COMMUNITIES_STAGED_REHEARSAL_32_CONFIRMATION),
        appliedFilenames: new Set(['0001_initial.sql']),
        packagedFilenames: ['0001_initial.sql', ...COMMUNITIES_STAGED_REHEARSAL_PENDING_FILENAMES],
      }),
    ).toThrow('COMMUNITIES_STAGED_REHEARSAL_PENDING_SET_MISMATCH');
  });

  it('requires the exact eligibility/payment ACL matrix for every 32-file phase', () => {
    const exact = request('pre_foundation', COMMUNITIES_STAGED_REHEARSAL_32_CONFIRMATION);
    for (const invalid of [
      { ...exact, aclMatrixVersion: null },
      { ...exact, aclMatrixVersion: 'eligibility-payment-acl-v2' },
      { ...exact, aclMatrixSha256: null },
      { ...exact, aclMatrixSha256: '0'.repeat(64) },
    ]) {
      expect(() =>
        selectCommunitiesStagedRehearsalMigrations({
          request: invalid,
          appliedFilenames: new Set(['0001_initial.sql']),
          packagedFilenames: [
            '0001_initial.sql',
            ...COMMUNITIES_STAGED_REHEARSAL_32_PENDING_FILENAMES,
          ],
        }),
      ).toThrow('COMMUNITIES_STAGED_REHEARSAL_ACL_MATRIX_BINDING_INVALID');
    }
  });

  it.each([
    ['missing', COMMUNITIES_STAGED_REHEARSAL_32_PENDING_FILENAMES.slice(1)],
    ['additional', [...COMMUNITIES_STAGED_REHEARSAL_32_PENDING_FILENAMES, '0087_unreviewed.sql']],
    [
      'reordered',
      [
        COMMUNITIES_STAGED_REHEARSAL_32_PENDING_FILENAMES[1],
        COMMUNITIES_STAGED_REHEARSAL_32_PENDING_FILENAMES[0],
        ...COMMUNITIES_STAGED_REHEARSAL_32_PENDING_FILENAMES.slice(2),
      ],
    ],
  ])('rejects a %s filename in the preparation-only 32-file plan', (_label, pending) => {
    expect(() =>
      selectCommunitiesStagedRehearsalMigrations({
        request: request('pre_foundation', COMMUNITIES_STAGED_REHEARSAL_32_CONFIRMATION),
        appliedFilenames: new Set(['0001_initial.sql']),
        packagedFilenames: ['0001_initial.sql', ...pending],
      }),
    ).toThrow('COMMUNITIES_STAGED_REHEARSAL_PENDING_SET_MISMATCH');
  });

  it.each([
    [
      'pre_foundation',
      [] as readonly string[],
      COMMUNITIES_STAGED_REHEARSAL_PRE_FOUNDATION_FILENAMES[0],
    ],
    [
      'foundation',
      COMMUNITIES_STAGED_REHEARSAL_PRE_FOUNDATION_FILENAMES,
      COMMUNITIES_STAGED_REHEARSAL_FOUNDATION_FILENAMES[0],
    ],
    [
      'post_foundation',
      [
        ...COMMUNITIES_STAGED_REHEARSAL_PRE_FOUNDATION_FILENAMES,
        ...COMMUNITIES_STAGED_REHEARSAL_FOUNDATION_FILENAMES,
      ],
      COMMUNITIES_STAGED_REHEARSAL_POST_FOUNDATION_FILENAMES[0],
    ],
    [
      'eligibility_payment',
      [
        ...COMMUNITIES_STAGED_REHEARSAL_PRE_FOUNDATION_FILENAMES,
        ...COMMUNITIES_STAGED_REHEARSAL_FOUNDATION_FILENAMES,
        ...COMMUNITIES_STAGED_REHEARSAL_POST_FOUNDATION_FILENAMES,
      ],
      COMMUNITIES_STAGED_REHEARSAL_ELIGIBILITY_PAYMENT_FILENAMES[0],
    ],
  ] as const)(
    'rejects a partial commit inside the 32-file %s phase',
    (phase, previouslyApplied, partiallyApplied) => {
      expect(() =>
        selectCommunitiesStagedRehearsalMigrations({
          request: request(phase, COMMUNITIES_STAGED_REHEARSAL_32_CONFIRMATION),
          appliedFilenames: new Set(['0001_initial.sql', ...previouslyApplied, partiallyApplied]),
          packagedFilenames: [
            '0001_initial.sql',
            ...COMMUNITIES_STAGED_REHEARSAL_32_PENDING_FILENAMES,
          ],
        }),
      ).toThrow('COMMUNITIES_STAGED_REHEARSAL_PENDING_SET_MISMATCH');
    },
  );

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
