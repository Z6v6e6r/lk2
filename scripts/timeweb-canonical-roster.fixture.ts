import { CANONICAL_OPERATION } from './timeweb-roster-alert-waiver.js';
import {
  CANONICAL_BASELINE_IMAGES,
  CANONICAL_BASELINE_RELEASE,
  CANONICAL_BASELINE_SCHEMA,
  CANONICAL_BASELINE_SOURCE,
  cutoverBaselineHash,
} from './timeweb-production-cutover.js';
import { ownerDirectedTestChoices } from './timeweb-owner-directed-fixture.js';
// Synthetic container/receipt witnesses only. This fixture never grants live authority.
export function canonicalRosterFixture() {
  const canonicalBaseline = {
    schema: CANONICAL_BASELINE_SCHEMA,
    capturedAt: '2026-11-16T10:00:00.000Z',
    installedReleaseId: CANONICAL_BASELINE_RELEASE,
    sourceSha: CANONICAL_BASELINE_SOURCE,
    sourceTree: '8907550c2386aaddc97b3fbda186dced43db00bd',
    sourceCiRunId: '43749601790',
    publicationRunId: '43751306581',
    artifactId: '14176493246',
    manifestSha256: '15465f17d7d4384ea2392fda664ff438a340389b3c5df29d2bd14d4e5ee82672',
    installedDescriptorSha256: 'a'.repeat(64),
    operationSha256: 'a'.repeat(64),
    planSha256: 'a'.repeat(64),
    receiptSha256: 'a'.repeat(64),
    observationSha256: 'a'.repeat(64),
    backupOperationSha256: 'a'.repeat(64),
    backupReceiptSha256: 'a'.repeat(64),
    excludedSha256: 'a'.repeat(64),
    secretSetReleaseId: `${'b'.repeat(40)}-10-1`,
    secretHashes: Object.fromEntries(
      ['.release-identity.json', 'api.env', 'worker.env', 'realtime.env', 'migrator.env'].map(
        (k) => [k, 'c'.repeat(64)],
      ),
    ),
    containers: Object.fromEntries(
      ['api', 'web', 'worker', 'realtime'].map((service, i) => [
        service,
        {
          id: String(i + 1).repeat(64),
          image: `ghcr.io/z6v6e6r/phub-${service}@${CANONICAL_BASELINE_IMAGES[service]}`,
          imageId: CANONICAL_BASELINE_IMAGES[service]!,
          releaseId: ['api', 'web'].includes(service) ? CANONICAL_BASELINE_RELEASE : null,
          revision: service === 'realtime' ? null : CANONICAL_BASELINE_SOURCE,
          restarts: 0,
          startedAt: '2026-11-15T20:17:14.556124403Z',
        },
      ]),
    ),
    databaseTarget: { databaseName: 'phub_beta', systemIdentifier: '7679125609183186977' },
    ledgerSha256: '4dab86cb18f7e3db7a0598cd657eaebc86f07d5af497dc0eea2e33900b6526c1',
  };
  const compact = (s: string) => {
    const c = canonicalBaseline.containers[s]!;
    return { id: c.id, image: c.image, releaseId: c.releaseId };
  };
  const op = {
    schema: CANONICAL_OPERATION,
    profile: 'production',
    target: 'lk2.padlhub.su',
    controllerSha: 'd'.repeat(40),
    candidateSha: 'd'.repeat(40),
    candidateTree: 'e'.repeat(40),
    sourceCiRunId: '101',
    publicationRunId: '102',
    artifactId: '103',
    artifactDigest: 'sha256:' + 'f'.repeat(64),
    manifestSha256: 'a'.repeat(64),
    backupOperationSha256: 'b'.repeat(64),
    expectedApi: compact('api'),
    expectedWeb: compact('web'),
    expectedWorker: compact('worker'),
    canonicalBaseline,
    ownerDecisions: {} as Record<string, unknown>,
    expiresAt: '2026-11-16T11:00:00.000Z',
    confirmation: '',
  };
  op.ownerDecisions = ownerDirectedTestChoices(op);
  op.confirmation = `UPGRADE_CANONICAL_PRODUCTION_API_WORKER_WEB_OWNER_SKIPPED_ALERT_DRILL_PROVIDER_READBACK_REPEAT_RESTORE_${op.candidateSha.slice(0, 12).toUpperCase()}_FROM_${cutoverBaselineHash(op).slice(0, 12).toUpperCase()}_KEEP_DATA_AND_ACCOUNTS`;
  return op;
}
