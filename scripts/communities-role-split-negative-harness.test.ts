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

describe('Communities role-split negative acceptance corpus', () => {
  it('is exact, unique and covers every required adversarial class', () => {
    const fixture = corpus();
    expect(new Set(fixture.cases.map(({ id }) => id)).size).toBe(fixture.cases.length);
    expect(new Set(fixture.cases.map(({ attack }) => attack))).toEqual(
      new Set([
        'SHELL_INJECTION',
        'SQL_INJECTION',
        'SHARED_TARGET',
        'FORBIDDEN_TARGET',
        'MALFORMED_REQUEST',
        'DIGEST_MISMATCH',
        'WRONG_EXECUTOR_SESSION',
        'OWNER_MISMATCH',
        'ROLE_CAPABILITY',
        'REPLAY_CONFLICT',
        'PARTIAL_FAILURE_BEFORE_MARKER',
        'PARTIAL_FAILURE_AFTER_MARKER',
        'CLEANUP_AFTER_MARKER',
        'TIMEOUT_PROCESS_GROUP',
        'OUTPUT_REDACTION',
      ]),
    );
  });

  it('accepts the exact observable outcome for every case', () => {
    for (const scenario of corpus().cases) {
      expect(() =>
        assertRoleSplitNegativeObservation(
          scenario,
          expectedRoleSplitNegativeObservation(scenario, [
            'postgres://runtime:secret@example.invalid/shared',
            'Bearer secret-token',
          ]),
        ),
      ).not.toThrow();
    }
  });

  it.each([
    ['stable error', { stableError: 'WRONG' }],
    ['marker state', { marker: 'PRESERVED' }],
    ['cleanup state', { cleanup: 'REQUIRE_BEFORE_MARKER' }],
    ['process group', { processGroup: 'TERMINATED' }],
    ['stdout', { stdout: 'unexpected' }],
    ['stderr', { stderr: 'unexpected\n' }],
  ] as const)('rejects an observation with a mismatched %s', (_label, override) => {
    const scenario = corpus().cases.find(({ id }) => id === 'current-shell-command-injection')!;
    expect(() =>
      assertRoleSplitNegativeObservation(scenario, {
        ...expectedRoleSplitNegativeObservation(scenario),
        ...override,
      }),
    ).toThrow(/^ROLE_SPLIT_NEGATIVE_OBSERVATION_/u);
  });

  it('rejects sensitive values in stderr or retained evidence', () => {
    const scenario = corpus().cases.find(({ id }) => id === 'future-output-redaction')!;
    const secret = 'postgres://runtime:secret@example.invalid/shared';
    expect(() =>
      assertRoleSplitNegativeObservation(scenario, {
        ...expectedRoleSplitNegativeObservation(scenario, [secret]),
        stderr: `${scenario.expected.stableError}: ${secret}\n`,
      }),
    ).toThrow('ROLE_SPLIT_NEGATIVE_OBSERVATION_REDACTION_INVALID');
    expect(() =>
      assertRoleSplitNegativeObservation(scenario, {
        ...expectedRoleSplitNegativeObservation(scenario, [secret]),
        evidence: [`requestSha256=${'a'.repeat(64)}\nDATABASE_URL=${secret}\n`],
      }),
    ).toThrow('ROLE_SPLIT_NEGATIVE_OBSERVATION_REDACTION_INVALID');
  });

  it('rejects a fixture that permits cleanup after a committed marker', () => {
    const invalid = structuredClone(corpusFixture);
    const marked = invalid.cases.find(({ id }) => id === 'future-repeated-request-conflict')!;
    marked.expected.cleanup = 'REQUIRE_BEFORE_MARKER';
    expect(() => assertRoleSplitNegativeCorpus(invalid)).toThrow(
      'ROLE_SPLIT_NEGATIVE_CORPUS_MARKER_CLEANUP_INVALID',
    );
  });

  it('rejects unversioned extension fields instead of silently weakening the corpus', () => {
    expect(() =>
      assertRoleSplitNegativeCorpus({ ...structuredClone(corpusFixture), allowSharedTarget: true }),
    ).toThrow('ROLE_SPLIT_NEGATIVE_CORPUS_SCHEMA_INVALID');
  });
});
