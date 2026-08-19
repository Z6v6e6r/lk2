export const ROLE_SPLIT_NEGATIVE_SCHEMA_VERSION =
  'communities-role-split-negative-corpus-v2' as const;

export type RoleSplitNegativeIntegration = 'CEREMONY' | 'CLEANUP';
export type RoleSplitNegativePhase = 'WRAPPER' | 'CREATE' | 'RESUME' | 'CLEANUP';
export type RoleSplitNegativeState =
  | 'UNCHANGED'
  | 'CREATE_PENDING'
  | 'CREATION_RECONCILIATION_REQUIRED'
  | 'MARKER_PENDING'
  | 'MARKED'
  | 'QUARANTINE_PENDING_RECONCILIATION_REQUIRED';

export interface RoleSplitNegativeOperations {
  readonly create: 0 | 1;
  readonly adopt: 0;
  readonly restore: 0 | 1;
  readonly comment: 0 | 1;
  readonly drop: 0;
  readonly alter: 0;
  readonly rename: 0;
}

export interface RoleSplitNegativeExpected {
  readonly exit: 'SUCCESS' | 'FAILURE' | 'TIMEOUT';
  readonly stableError: string | null;
  readonly state: RoleSplitNegativeState;
  readonly receipt: 'NOT_APPLICABLE' | 'REQUIRED' | 'REJECTED' | 'VALIDATED';
  readonly marker: 'ABSENT' | 'POSSIBLY_COMMITTED' | 'PRESERVED';
  readonly clone: 'ABSENT' | 'RETAINED' | 'UNKNOWN';
  readonly stdout: 'EMPTY' | 'MARKER_EVIDENCE' | 'CLEANUP_EVIDENCE';
  readonly processGroup: 'NOT_APPLICABLE' | 'TERMINATED';
  readonly callerEnvironment: 'SCRUBBED';
  readonly diagnosticSentinel: 'ABSENT';
  readonly operations: RoleSplitNegativeOperations;
}

export interface RoleSplitNegativeCase {
  readonly id: string;
  readonly integration: RoleSplitNegativeIntegration;
  readonly phase: RoleSplitNegativePhase;
  readonly attack: string;
  readonly expected: RoleSplitNegativeExpected;
}

export interface RoleSplitNegativeCorpus {
  readonly schemaVersion: typeof ROLE_SPLIT_NEGATIVE_SCHEMA_VERSION;
  readonly ceremonyContract: 'RUN_COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CEREMONY_V2';
  readonly cleanupContract: 'CLEANUP_COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CLONE_V1';
  readonly cases: readonly RoleSplitNegativeCase[];
}

export interface RoleSplitNegativeObservation extends RoleSplitNegativeExpected {
  readonly scenarioId: string;
  readonly publicOutput: readonly string[];
  readonly stateTreeOutput: readonly string[];
  readonly sensitiveValues: readonly string[];
}

const rootKeys = ['schemaVersion', 'ceremonyContract', 'cleanupContract', 'cases'] as const;
const caseKeys = ['id', 'integration', 'phase', 'attack', 'expected'] as const;
const expectedKeys = [
  'exit',
  'stableError',
  'state',
  'receipt',
  'marker',
  'clone',
  'stdout',
  'processGroup',
  'callerEnvironment',
  'diagnosticSentinel',
  'operations',
] as const;
const operationKeys = ['create', 'adopt', 'restore', 'comment', 'drop', 'alter', 'rename'] as const;
const ceremonyError = /^COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CEREMONY_[A-Z0-9_]+$/u;
const cleanupError = /^COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CLEANUP_[A-Z0-9_]+$/u;
const caseId =
  /^(?:create|resume|preflight|wrapper|comment|marker|restore|readback|cleanup|diagnostic)-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

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

function validOperations(value: unknown): value is RoleSplitNegativeOperations {
  return (
    isRecord(value) &&
    hasExactKeys(value, operationKeys) &&
    [value.create, value.restore, value.comment].every((count) => count === 0 || count === 1) &&
    [value.adopt, value.drop, value.alter, value.rename].every((count) => count === 0)
  );
}

export function assertRoleSplitNegativeCorpus(
  value: unknown,
): asserts value is RoleSplitNegativeCorpus {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, rootKeys) ||
    value.schemaVersion !== ROLE_SPLIT_NEGATIVE_SCHEMA_VERSION
  )
    throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_SCHEMA_INVALID');
  if (
    value.ceremonyContract !== 'RUN_COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CEREMONY_V2' ||
    value.cleanupContract !== 'CLEANUP_COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CLONE_V1'
  )
    throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_CONTRACT_INVALID');
  if (!Array.isArray(value.cases) || value.cases.length === 0)
    throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_CASES_INVALID');

  const ids = new Set<string>();
  for (const candidate of value.cases) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, caseKeys) ||
      !caseId.test(String(candidate.id)) ||
      ids.has(String(candidate.id)) ||
      !['CEREMONY', 'CLEANUP'].includes(String(candidate.integration)) ||
      !['WRAPPER', 'CREATE', 'RESUME', 'CLEANUP'].includes(String(candidate.phase)) ||
      !/^[A-Z][A-Z0-9_]+$/u.test(String(candidate.attack)) ||
      !isRecord(candidate.expected) ||
      !hasExactKeys(candidate.expected, expectedKeys)
    )
      throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_CASE_INVALID');
    ids.add(String(candidate.id));

    const expected = candidate.expected;
    const operations = expected.operations;
    if (!validOperations(operations)) throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_CASE_INVALID');
    if (
      !['SUCCESS', 'FAILURE', 'TIMEOUT'].includes(String(expected.exit)) ||
      ![
        'UNCHANGED',
        'CREATE_PENDING',
        'CREATION_RECONCILIATION_REQUIRED',
        'MARKER_PENDING',
        'MARKED',
        'QUARANTINE_PENDING_RECONCILIATION_REQUIRED',
      ].includes(String(expected.state)) ||
      !['NOT_APPLICABLE', 'REQUIRED', 'REJECTED', 'VALIDATED'].includes(String(expected.receipt)) ||
      !['ABSENT', 'POSSIBLY_COMMITTED', 'PRESERVED'].includes(String(expected.marker)) ||
      !['ABSENT', 'RETAINED', 'UNKNOWN'].includes(String(expected.clone)) ||
      !['EMPTY', 'MARKER_EVIDENCE', 'CLEANUP_EVIDENCE'].includes(String(expected.stdout)) ||
      !['NOT_APPLICABLE', 'TERMINATED'].includes(String(expected.processGroup)) ||
      expected.callerEnvironment !== 'SCRUBBED' ||
      expected.diagnosticSentinel !== 'ABSENT'
    )
      throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_EXPECTATION_INVALID');
    if (
      expected.stableError !== null &&
      (typeof expected.stableError !== 'string' ||
        !(candidate.integration === 'CEREMONY' ? ceremonyError : cleanupError).test(
          expected.stableError,
        ))
    )
      throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_ERROR_INVALID');
    if ((expected.exit === 'FAILURE') !== (expected.stableError !== null))
      throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_EXIT_INVALID');
    if (
      candidate.phase === 'CREATE' &&
      (operations.adopt !== 0 || operations.restore !== 0 || operations.comment !== 0)
    )
      throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_CREATE_BOUNDARY_INVALID');
    if (
      candidate.phase === 'RESUME' &&
      expected.receipt === 'REJECTED' &&
      (operations.restore !== 0 || operations.comment !== 0)
    )
      throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_RECEIPT_BOUNDARY_INVALID');
    if (
      ['MARKER_PENDING', 'MARKED', 'QUARANTINE_PENDING_RECONCILIATION_REQUIRED'].includes(
        String(expected.state),
      ) &&
      expected.clone !== 'RETAINED'
    )
      throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_RETENTION_INVALID');
    if ((expected.exit === 'TIMEOUT') !== (expected.processGroup === 'TERMINATED'))
      throw new Error('ROLE_SPLIT_NEGATIVE_CORPUS_TIMEOUT_INVALID');
  }
}

export function expectedRoleSplitNegativeObservation(
  scenario: RoleSplitNegativeCase,
  sensitiveValues: readonly string[] = [],
): RoleSplitNegativeObservation {
  return {
    scenarioId: scenario.id,
    ...scenario.expected,
    publicOutput: [],
    stateTreeOutput: [],
    sensitiveValues,
  };
}

export function assertRoleSplitNegativeObservation(
  scenario: RoleSplitNegativeCase,
  observation: RoleSplitNegativeObservation,
): void {
  if (observation.scenarioId !== scenario.id)
    throw new Error('ROLE_SPLIT_NEGATIVE_OBSERVATION_SCENARIO_INVALID');
  for (const key of expectedKeys) {
    const actual = observation[key];
    const expected = scenario.expected[key];
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error(`ROLE_SPLIT_NEGATIVE_OBSERVATION_${key.toUpperCase()}_INVALID`);
  }
  const outputs = [...observation.publicOutput, ...observation.stateTreeOutput];
  if (
    observation.sensitiveValues.some(
      (sensitive) => sensitive.length > 0 && outputs.some((output) => output.includes(sensitive)),
    )
  )
    throw new Error('ROLE_SPLIT_NEGATIVE_OBSERVATION_REDACTION_INVALID');
}
