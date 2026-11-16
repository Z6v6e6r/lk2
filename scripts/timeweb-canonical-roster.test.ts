import { expect, it } from 'vitest';
import { canonicalRosterFixture } from './timeweb-canonical-roster.fixture.js';
import {
  validateProductionCutover,
  validateCanonicalBaseline,
  canonicalRuntimeHash,
  cutoverBaselineField,
  cutoverPlanSchema,
  cutoverReceiptSchema,
  cutoverInstalledKind,
} from './timeweb-production-cutover.js';
import {
  CANONICAL_PLAN,
  CANONICAL_RECEIPT,
  CANONICAL_KIND,
  OWNER_OPERATION,
  ownerDirectedScopeSha256,
  createOwnerDirectedBinding,
} from './timeweb-roster-alert-waiver.js';
it('admits only the actual canonical4b8 predecessor using separate operation and custody vocabularies', () => {
  const op = canonicalRosterFixture();
  expect(validateProductionCutover(op)).toBe(op);
  expect(cutoverBaselineField(op)).toBe('canonicalBaselineSha256');
  expect(cutoverPlanSchema(op)).toBe(CANONICAL_PLAN);
  expect(cutoverReceiptSchema(op)).toBe(CANONICAL_RECEIPT);
  expect(cutoverInstalledKind(op)).toBe(CANONICAL_KIND);
  const before = canonicalRuntimeHash(op.canonicalBaseline);
  const later = structuredClone(op.canonicalBaseline);
  later.capturedAt = '2026-11-16T10:01:00.000Z';
  expect(canonicalRuntimeHash(later)).toBe(before);
  const binding = createOwnerDirectedBinding(op, 'a'.repeat(64));
  expect(binding.schema).toBe('PHUB_TIMEWEB_OWNER_DIRECTED_POLICY_BINDING_V2');
});
it.each([
  'legacy-kind',
  'source',
  'tree',
  'ci',
  'publication',
  'artifact',
  'manifest',
  'release',
  'ledger',
  'database',
  'worker-revision',
  'worker-image',
  'worker-label',
  'worker-restart',
  'realtime',
  'unknown-key',
  'missing-custody',
])('rejects canonical predecessor %s', (scenario) => {
  const op = canonicalRosterFixture(),
    b = op.canonicalBaseline;
  switch (scenario) {
    case 'legacy-kind':
      b.schema = 'LEGACY_TEST_STAND_RUNTIME_V1';
      break;
    case 'source':
      b.sourceSha = '7'.repeat(40);
      break;
    case 'tree':
      b.sourceTree = 'a'.repeat(40);
      break;
    case 'ci':
      b.sourceCiRunId = '9';
      break;
    case 'publication':
      b.publicationRunId = '9';
      break;
    case 'artifact':
      b.artifactId = '9';
      break;
    case 'manifest':
      b.manifestSha256 = '9'.repeat(64);
      break;
    case 'release':
      b.installedReleaseId = '9'.repeat(40) + '-9-1';
      break;
    case 'ledger':
      b.ledgerSha256 = '9'.repeat(64);
      break;
    case 'database':
      b.databaseTarget.systemIdentifier = '9';
      break;
    case 'worker-revision':
      b.containers.worker!.revision = null;
      break;
    case 'worker-image':
      b.containers.worker!.imageId = 'sha256:' + '9'.repeat(64);
      break;
    case 'worker-label':
      b.containers.worker!.releaseId = b.installedReleaseId;
      break;
    case 'worker-restart':
      b.containers.worker!.restarts = 1;
      break;
    case 'realtime':
      b.containers.realtime!.revision = b.sourceSha;
      break;
    case 'unknown-key':
      Object.assign(b, { laneCurrentSha256: 'a'.repeat(64) });
      break;
    case 'missing-custody':
      Object.assign(b, { receiptSha256: undefined });
      break;
  }
  expect(() => validateCanonicalBaseline(b)).toThrow();
});
it('rejects V4/V5 field and owner-scope crossover', () => {
  const op = canonicalRosterFixture();
  for (const changed of [
    { ...op, legacyBaseline: op.canonicalBaseline },
    { ...op, schema: OWNER_OPERATION },
    { ...op, expectedWorker: op.expectedApi },
  ])
    expect(() => validateProductionCutover(changed)).toThrow();
  const oldScope = ownerDirectedScopeSha256({
    ...op,
    schema: OWNER_OPERATION,
    legacyBaseline: op.canonicalBaseline,
  });
  expect(oldScope).not.toBe(ownerDirectedScopeSha256(op));
  for (const r of Object.values(op.ownerDecisions) as { scopeSha256: string }[])
    r.scopeSha256 = oldScope;
  expect(() => validateProductionCutover(op)).toThrow('owner_decision');
});
