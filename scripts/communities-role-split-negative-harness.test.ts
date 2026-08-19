import corpusFixture from './communities-role-split-negative-corpus.fixture.json';
import {
  assertRoleSplitNegativeCorpus,
  assertRoleSplitNegativeObservation,
  expectedRoleSplitNegativeObservation,
  type RoleSplitNegativeCorpus,
} from './communities-role-split-negative-harness.test-helper.js';
import { describe, expect, it } from 'vitest';

function corpus(): RoleSplitNegativeCorpus {
  assertRoleSplitNegativeCorpus(corpusFixture);
  return corpusFixture;
}

describe('Communities role-split V2 negative acceptance corpus', () => {
  it('is exact, unique and covers the V2 failure classes', () => {
    const fixture = corpus();
    expect(new Set(fixture.cases.map(({ id }) => id)).size).toBe(fixture.cases.length);
    expect(new Set(fixture.cases.map(({ attack }) => attack))).toEqual(
      new Set([
        'NONE',
        'CREATE_AMBIGUOUS',
        'RECEIPT_MISSING',
        'RECEIPT_CUSTODY',
        'RECEIPT_OID_MISMATCH',
        'OWNER_MISMATCH',
        'ENV_UNREADABLE',
        'APP_ROOT_WRITABLE',
        'RUNTIME_BINDING_MISMATCH',
        'CONTAINER_MISMATCH',
        'TIMEOUT_PROCESS_GROUP',
        'CHILD_MODE_BYPASS',
        'COMMENT_NONZERO',
        'REPLAY_CONFLICT',
        'PARTIAL_FAILURE_BEFORE_MARKER',
        'PARTIAL_FAILURE_AFTER_MARKER',
        'CLEANUP_AFTER_MARKER',
        'OUTPUT_REDACTION',
      ]),
    );
  });

  it('accepts each exact expected V2 observation', () => {
    for (const scenario of corpus().cases) {
      expect(() =>
        assertRoleSplitNegativeObservation(
          scenario,
          expectedRoleSplitNegativeObservation(scenario, [
            'SECRET_SENTINEL',
            'postgres://runtime:secret@example.invalid/shared',
          ]),
        ),
      ).not.toThrow();
    }
  });

  it.each([
    ['state', { state: 'MARKED' }],
    ['receipt', { receipt: 'VALIDATED' }],
    ['clone retention', { clone: 'ABSENT' }],
    ['process group', { processGroup: 'TERMINATED' }],
    [
      'operations',
      { operations: { create: 1, adopt: 0, restore: 1, comment: 0, drop: 0, alter: 0, rename: 0 } },
    ],
  ] as const)('rejects an observation with a mismatched %s', (_label, override) => {
    const scenario = corpus().cases.find(({ id }) => id === 'create-requires-independent-receipt')!;
    expect(() =>
      assertRoleSplitNegativeObservation(scenario, {
        ...expectedRoleSplitNegativeObservation(scenario),
        ...override,
      }),
    ).toThrow(/^ROLE_SPLIT_NEGATIVE_OBSERVATION_/u);
  });

  it('rejects a sentinel or secret in public output and the state tree', () => {
    const scenario = corpus().cases.find(({ id }) => id === 'diagnostic-sentinel-never-published')!;
    for (const override of [
      { publicOutput: ['SECRET_SENTINEL'] },
      { stateTreeOutput: ['DATABASE_URL=postgres://runtime:secret@example.invalid/shared'] },
    ]) {
      expect(() =>
        assertRoleSplitNegativeObservation(scenario, {
          ...expectedRoleSplitNegativeObservation(scenario, [
            'SECRET_SENTINEL',
            'postgres://runtime:secret@example.invalid/shared',
          ]),
          ...override,
        }),
      ).toThrow('ROLE_SPLIT_NEGATIVE_OBSERVATION_REDACTION_INVALID');
    }
  });

  it.each([
    [
      'CREATE restore',
      'create-requires-independent-receipt',
      { restore: 1 },
      'ROLE_SPLIT_NEGATIVE_CORPUS_CREATE_BOUNDARY_INVALID',
    ],
    [
      'rejected receipt restore',
      'resume-missing-root-receipt',
      { restore: 1 },
      'ROLE_SPLIT_NEGATIVE_CORPUS_RECEIPT_BOUNDARY_INVALID',
    ],
    [
      'post-marker clone loss',
      'comment-nonzero-retains-marker-pending',
      { clone: 'ABSENT' },
      'ROLE_SPLIT_NEGATIVE_CORPUS_RETENTION_INVALID',
    ],
  ] as const)('rejects a fixture that permits %s', (_label, id, expectedOverride, error) => {
    const invalid = structuredClone(corpusFixture);
    const scenario = invalid.cases.find((candidate) => candidate.id === id)!;
    if ('restore' in expectedOverride) {
      scenario.expected.operations.restore = expectedOverride.restore;
    } else {
      Object.assign(scenario.expected, expectedOverride);
    }
    expect(() => assertRoleSplitNegativeCorpus(invalid)).toThrow(error);
  });

  it('rejects unversioned extension fields', () => {
    expect(() =>
      assertRoleSplitNegativeCorpus({ ...structuredClone(corpusFixture), allowAdoption: true }),
    ).toThrow('ROLE_SPLIT_NEGATIVE_CORPUS_SCHEMA_INVALID');
  });
});
