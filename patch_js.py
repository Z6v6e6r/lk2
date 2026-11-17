import pathlib
p=pathlib.Path('scripts/timeweb-api-web-upgrade.js')
s=p.read_text()
marker='export function attestCanonicalBaseline(baseline) {'
assert marker in s, 'marker'
derive='''export function deriveInstalledCanonicalBaseline(template) {
  const api = inspect('api');
  const id = api.releaseId;
  if (typeof id !== 'string' || !/^[0-9a-f]{40}-[1-9][0-9]*-1$/u.test(id)) fail('installed_release_identity');
  const descriptor = readInstalledApiBaseline(id, { checkRuntimeSecrets: true });
  const transaction = ROOT + '/backups/' + id + '-api-web';
  const operationBytes = read(transaction + '/operation.json');
  const operation = parseStrictJson(operationBytes);
  if (operation.candidateSha !== id.slice(0, 40)) fail('installed_release_operation');
  return {
    schema: 'PHUB_TIMEWEB_INSTALLED_CANONICAL_ROSTER_RUNTIME_V1',
    capturedAt: new Date().toISOString(),
    installedReleaseId: id,
    sourceSha: id.slice(0, 40),
    sourceTree: operation.candidateTree,
    sourceCiRunId: String(operation.sourceCiRunId),
    publicationRunId: String(operation.publicationRunId),
    artifactId: String(operation.artifactId),
    manifestSha256: operation.manifestSha256,
    installedDescriptorSha256: hash(descriptor.bytes),
    operationSha256: hash(operationBytes),
    planSha256: hash(read(transaction + '/plan.json')),
    receiptSha256: hash(read(transaction + '/rollout-receipt.json')),
    observationSha256: hash(read(transaction + '/observation.json')),
    backupOperationSha256: hash(read(transaction + '/backup-operation.json')),
    backupReceiptSha256: hash(read(transaction + '/database-backup-receipt.json')),
    secretSetReleaseId: descriptor.secretSetReleaseId,
    secretHashes: secretHashes(),
    containers: { api, web: inspect('web'), worker: inspect('worker'), realtime: inspect('realtime') },
    excludedSha256: hash(JSON.stringify(excluded(['api', 'worker', 'web']))),
    databaseTarget: template.databaseTarget,
    ledgerSha256: template.ledgerSha256,
  };
}

'''
s=s.replace(marker, derive+marker, 1)
p.write_text(s)
print('patched', len(s), 'has', 'deriveInstalledCanonicalBaseline' in s)