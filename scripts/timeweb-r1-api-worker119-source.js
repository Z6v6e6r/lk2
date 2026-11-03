// Source attestation is separate from the pure contract to avoid an ESM source/contract cycle.
import { validateR1ApiWorker119Operation } from './timeweb-r1-api-worker119-profile.js';
import { r1TailPaths, validateR1TailOperation } from './r1-tail-migration-controller.js';
import { attestR1TailSource } from './r1-tail-migration-source.js';
import { r1Same, r1Hash, r1Stop } from './r1-tail-migration-profile.js';
import { parseStrictJson } from './strict-json.js';
const need = (ok) => {
  if (!ok) r1Stop('API_WORKER119_IDENTITY');
};
export function attestR1ApiWorker119Source(op, deps) {
  validateR1ApiWorker119Operation(op);
  const bytes = deps.read(r1TailPaths(op.completedTail).root + '/request.json');
  need(r1Hash(bytes) === op.completedTail.files['request.json']);
  const tail = validateR1TailOperation(parseStrictJson(bytes));
  need(
    tail.attemptId === op.completedTail.attemptId &&
      tail.controllerSha === op.controllerSha &&
      tail.controllerTree === op.controllerTree &&
      tail.controllerSourceCiRunId === op.sourceCiRunId &&
      tail.publishedMigrator.image === op.publishedMigratorImage &&
      tail.publishedMigrator.publicationRunId === op.publicationRunId &&
      tail.publishedMigrator.manifestSha256 === op.manifestSha256 &&
      r1Same(tail.expectedPostgres, op.expectedPostgres),
  );
  attestR1TailSource(tail, deps);
  return tail;
}
