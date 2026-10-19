import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseStrictJson } from './strict-json.js';
import { API_WORKER_BRIDGE as bridge } from './timeweb-api-worker-upgrade.js';
export const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export const id = `${bridge.candidateSha}-${bridge.publicationRunId}-1`;
export const root = '/opt/phub/timeweb-beta';
const names = ['.release-identity.json', 'api.env', 'migrator.env', 'realtime.env', 'worker.env'];
// This operation is frozen to the published candidate, not today's migration directory.
const frozenLedger = parseStrictJson<{
  sourceSha: string;
  sourceTree: string;
  ledger: { filename: string; checksum: string }[];
}>(
  readFileSync(
    new URL('./fixtures/timeweb-api-worker-ledger-11954ffd.json', import.meta.url),
    'utf8',
  ),
);
if (
  frozenLedger.sourceSha !== bridge.candidateSha ||
  frozenLedger.sourceTree !== bridge.candidateTree ||
  frozenLedger.ledger.length !== 101 ||
  hash(frozenLedger.ledger.map((row) => `${row.filename}|${row.checksum}\n`).join('')) !==
    bridge.ledgerSha256
) {
  throw new Error('Frozen API/Worker test ledger does not match the published candidate');
}
export const ledger = frozenLedger.ledger;
export const operation = () => ({
  schema: 'PHUB_TIMEWEB_API_WORKER_OPERATION_V1',
  target: { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 },
  controllerSha: 'a'.repeat(40),
  controllerSourceCiRunId: '123456',
  candidateSha: bridge.candidateSha,
  candidateTree: bridge.candidateTree,
  sourceCiRunId: bridge.sourceCiRunId,
  publicationRunId: bridge.publicationRunId,
  artifactId: bridge.artifactId,
  artifactDigest: bridge.artifactDigest,
  manifestSha256: bridge.manifestSha256,
  expectedApi: {
    id: 'b'.repeat(64),
    image: `ghcr.io/z6v6e6r/phub-api@${bridge.apiDigest}`,
    imageId: bridge.apiDigest,
    releaseId: bridge.apiRelease,
    revision: bridge.apiSource,
    restarts: 0,
    startedAt: '2026-10-05T14:35:52.357Z',
  },
  expectedWorker: {
    id: 'c'.repeat(64),
    image: `ghcr.io/z6v6e6r/phub-worker@${bridge.workerDigest}`,
    imageId: bridge.workerDigest,
    releaseId: null,
    revision: bridge.workerSource,
    restarts: 0,
    startedAt: '2026-09-29T17:04:36.692Z',
  },
  expectedCurrentSecretSetReleaseId: bridge.apiRelease,
  candidateSecretHashes: Object.fromEntries(names.map((name) => [name, 'd'.repeat(64)])),
  fcmEnvironment: 'SANDBOX',
  expiresAt: '2026-10-11T20:30:00.000Z',
  confirmation:
    'UPGRADE_API_WORKER_11954FFD6D7B_FROM_0D6078BE7A50_FF42C9E9A238_GLOBAL_FCM_ON_TENANT_PROVIDER_GATES_OFF_NO_SEND',
});
export function capsuleFixture() {
  const op = operation(),
    operationBytes = Buffer.from(JSON.stringify(op) + '\n');
  const plan = {
    schema: 'PHUB_TIMEWEB_API_WORKER_PLAN_V1',
    operationSha256: hash(operationBytes),
    controllerSha: op.controllerSha,
    manifestSha256: op.manifestSha256,
    artifactDigest: op.artifactDigest,
    composeSha256: 'e'.repeat(64),
    baselineSha256: 'f'.repeat(64),
    baselinePath: `${root}/releases/${bridge.apiRelease}/installed-components.env`,
    previous: { api: op.expectedApi, worker: op.expectedWorker },
    candidate: {
      api: {
        image: `ghcr.io/z6v6e6r/phub-api@${bridge.candidateApiDigest}`,
        releaseId: id,
        revision: bridge.candidateSha,
      },
      worker: {
        image: `ghcr.io/z6v6e6r/phub-worker@${bridge.candidateWorkerDigest}`,
        releaseId: null,
        revision: bridge.candidateSha,
      },
    },
    excluded: [],
    previousSecrets: {
      releaseId: bridge.apiRelease,
      device: 1,
      inode: 2,
      files: op.candidateSecretHashes,
    },
    candidateSecrets: { releaseId: id, device: 1, inode: 3, files: op.candidateSecretHashes },
    credential: {},
    packagedLedger: ledger,
    unchangedImages: {
      WEB_IMAGE_DIGEST: `sha256:${'1'.repeat(64)}`,
      REALTIME_IMAGE_DIGEST: `sha256:${'2'.repeat(64)}`,
      MIGRATOR_IMAGE_DIGEST: `sha256:${'3'.repeat(64)}`,
    },
    createdAt: '2026-10-11T20:00:00.000Z',
  };
  return { op, plan, operationBytes, planBytes: Buffer.from(JSON.stringify(plan) + '\n') };
}
