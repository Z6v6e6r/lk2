import { readFileSync } from 'node:fs';
import { validateProductionCutover } from '/opt/phub/timeweb-beta/standard/source/scripts/timeweb-production-cutover.js';
const b = JSON.parse(readFileSync('/tmp/bl.json', 'utf8'));
const dir = '/opt/phub/timeweb-beta/backups/' + b.installedReleaseId + '-api-web';
try {
  const op = validateProductionCutover(JSON.parse(readFileSync(dir + '/operation.json', 'utf8')));
  console.log(JSON.stringify({ schema: op.schema, cand: op.candidateSha, bCand: b.sourceSha, ci: op.sourceCiRunId, bCi: b.sourceCiRunId, pub: op.publicationRunId, bPub: b.publicationRunId, artId: op.artifactId, bArtId: b.artifactId, man: op.manifestSha256, bMan: b.manifestSha256, tree: op.candidateTree, bTree: b.sourceTree }));
} catch (e) { console.error('ERR', e && e.message); }
