export const ROLE_SPLIT_NEGATIVE_SCHEMA_VERSION =
  'communities-role-split-negative-corpus-v1' as const;

export type RoleSplitNegativeIntegration = 'CURRENT_PREPARATION' | 'AWAIT_MARKER_WRITER';
export type RoleSplitNegativeMarker = 'ABSENT' | 'PRESERVED';
export type RoleSplitNegativeCleanup =
  'NOT_APPLICABLE' | 'REQUIRE_BEFORE_MARKER' | 'REFUSE_AFTER_MARKER';
export type RoleSplitNegativeProcessGroup = 'NOT_APPLICABLE' | 'TERMINATED';

export interface RoleSplitNegativeCase {
  readonly id: string;
  readonly integration: RoleSplitNegativeIntegration;
  readonly attack: string;
  readonly expected: {
    readonly stableError: string;
    readonly marker: RoleSplitNegativeMarker;
    readonly cleanup: RoleSplitNegativeCleanup;
    readonly processGroup: RoleSplitNegativeProcessGroup;
    readonly stdout: 'EMPTY';
    readonly redaction: 'NO_SENSITIVE_VALUE';
  };
}

export interface RoleSplitNegativeCorpus {
  readonly schemaVersion: typeof ROLE_SPLIT_NEGATIVE_SCHEMA_VERSION;
  readonly contract: 'PHUB_COMMUNITIES_ROLE_SPLIT_CLONE_MARKER_REQUEST_V1';
  readonly cases: readonly RoleSplitNegativeCase[];
}

export interface RoleSplitNegativeObservation {
  readonly scenarioId: string;
  readonly stableError: string;
  readonly marker: RoleSplitNegativeMarker;
  readonly cleanup: RoleSplitNegativeCleanup;
  readonly processGroup: RoleSplitNegativeProcessGroup;
  readonly stdout: string;
  readonly stderr: string;
  readonly evidence: readonly string[];
  readonly sensitiveValues: readonly string[];
}

const stableError = /^COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER(?:_WRITER)?_[A-Z0-9_]+$/u;
const caseId = /^(?:current|future)-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

export function assertRoleSplitNegativeCorpus(
  value: unknown,
): asserts value is RoleSplitNegativeCorpus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'contract', 'cases']) ||
    value.schemaVersion !== ROLE_SPLIT_NEGATIVE_SCHEMA_VERSION
  )
    throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_SCHEMA_INVALID');
  if (value.contract !== 'PHUB_COMMUNITIES_ROLE_SPLIT_CLONE_MARKER_REQUEST_V1')
    throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_CONTRACT_INVALID');
  if (!Array.isArray(value.cases) || value.cases.length === 0)
    throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_CASES_INVALID');

  const ids = new Set<string>();
  for (const candidate of value.cases) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['id', 'integration', 'attack', 'expected']) ||
      !caseId.test(String(candidate.id))
    )
      throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_CASE_INVALID');
    if (ids.has(String(candidate.id))) throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_CASE_DUPLICATE');
    ids.add(String(candidate.id));
    if (
      !['CURRENT_PREPARATION', 'AWAIT_MARKER_WRITER'].includes(String(candidate.integration)) ||
      !/^[A-Z][A-Z0-9_]+$/u.test(String(candidate.attack)) ||
      !isRecord(candidate.expected) ||
      !hasExactKeys(candidate.expected, [
        'stableError',
        'marker',
        'cleanup',
        'processGroup',
        'stdout',
        'redaction',
      ]) ||
      !stableError.test(String(candidate.expected.stableError)) ||
      !['ABSENT', 'PRESERVED'].includes(String(candidate.expected.marker)) ||
      !['NOT_APPLICABLE', 'REQUIRE_BEFORE_MARKER', 'REFUSE_AFTER_MARKER'].includes(
        String(candidate.expected.cleanup),
      ) ||
      !['NOT_APPLICABLE', 'TERMINATED'].includes(String(candidate.expected.processGroup)) ||
      candidate.expected.stdout !== 'EMPTY' ||
      candidate.expected.redaction !== 'NO_SENSITIVE_VALUE'
    )
      throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_CASE_INVALID');
    if (
      (candidate.expected.marker === 'PRESERVED') !==
      (candidate.expected.cleanup === 'REFUSE_AFTER_MARKER')
    )
      throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_MARKER_CLEANUP_INVALID');
  }
}

export function assertRoleSplitNegativeObservation(
  scenario: RoleSplitNegativeCase,
  observation: RoleSplitNegativeObservation,
): void {
  if (observation.scenarioId !== scenario.id)
    throw new Error('ROLE_SPLIT_NEGATIVE_OBSERVATION_SCENARIO_INVALID');
  if (observation.stableError !== scenario.expected.stableError)
    throw new Error('ROLE_SPLIT_NEGATIVE_OBSERVATION_ERROR_INVALID');
  if (observation.marker !== scenario.expected.marker)
    throw new Error('ROLE_SPLIT_NEGATIVE_OBSERVATION_MARKER_INVALID');
  if (observation.cleanup !== scenario.expected.cleanup)
    throw new Error('ROLE_SPLIT_NEGATIVE_OBSERVATION_CLEANUP_INVALID');
  if (observation.processGroup !== scenario.expected.processGroup)
    throw new Error('ROLE_SPLIT_NEGATIVE_OBSERVATION_PROCESS_GROUP_INVALID');
  if (
    observation.sensitiveValues.some(
      (sensitive) =>
        sensitive.length > 0 &&
        [observation.stdout, observation.stderr, ...observation.evidence].some((output) =>
          output.includes(sensitive),
        ),
    )
  )
    throw new Error('ROLE_SPLIT_NEGATIVE_OBSERVATION_REDACTION_INVALID');
  if (observation.stdout !== '') throw new Error('ROLE_SPLIT_NEGATIVE_OBSERVATION_STDOUT_INVALID');
  if (observation.stderr !== `${scenario.expected.stableError}\n`)
    throw new Error('ROLE_SPLIT_NEGATIVE_OBSERVATION_STDERR_INVALID');
}

export function expectedRoleSplitNegativeObservation(
  scenario: RoleSplitNegativeCase,
  sensitiveValues: readonly string[] = [],
): RoleSplitNegativeObservation {
  return {
    scenarioId: scenario.id,
    stableError: scenario.expected.stableError,
    marker: scenario.expected.marker,
    cleanup: scenario.expected.cleanup,
    processGroup: scenario.expected.processGroup,
    stdout: '',
    stderr: `${scenario.expected.stableError}\n`,
    evidence: [],
    sensitiveValues,
  };
}
