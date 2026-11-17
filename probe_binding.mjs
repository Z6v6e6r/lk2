import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const h = (b) => createHash('sha256').update(b).digest('hex');
const b = JSON.parse(readFileSync('/tmp/bl.json', 'utf8'));
const dir = '/opt/phub/timeweb-beta/backups/' + b.installedReleaseId + '-api-web';
const opBytes = readFileSync(dir + '/operation.json');
const op = JSON.parse(opBytes);
const archive = readFileSync('/opt/phub/timeweb-beta/releases/' + b.installedReleaseId + '/artifact/canonical-artifact.zip');
const checks = {
  opHash: h(opBytes) === b.operationSha256,
  schema: op.schema,
  cand: op.candidateSha === b.sourceSha,
  tree: op.candidateTree === b.sourceTree,
  ci: String(op.sourceCiRunId) === String(b.sourceCiRunId),
  pub: String(op.publicationRunId) === String(b.publicationRunId),
  artId: String(op.artifactId) === String(b.artifactId),
  manifest: op.manifestSha256 === b.manifestSha256,
  digest: 'sha256:' + h(archive) === op.artifactDigest,
  bTree: b.sourceTree,
  opTree: op.candidateTree,
};
console.log(JSON.stringify(checks, null, 1));
