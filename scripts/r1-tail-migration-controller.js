import {
  validateClosedRuntimeIdentity,
  CLOSED_APPLICATION_POSTGRES_CONTAINER,
} from './timeweb-closed-application-profile.js';
// Fixed R1 tail state machine. Production effects are source-owned, never request callbacks.
import {
  R1_TAIL,
  r1Exact,
  r1Hash,
  r1Encode,
  r1Same,
  r1Stop,
  r1LedgerCount,
} from './r1-tail-migration-profile.js';
import { parseStrictJson } from './strict-json.js';
import { validateR1TailState } from './r1-tail-migration-state.js';
import { validateR1TailPreparation } from './r1-tail-migration-acl.js';
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const R1_TAIL_ROOT = '/opt/phub/timeweb-beta';
export const R1_TAIL_REQUEST = `${R1_TAIL_ROOT}/operator/r1-tail108-119-migration.json`;
export function r1TailPaths(operation) {
  if (!UUID.test(operation?.attemptId ?? '')) r1Stop('ATTEMPT_ID');
  const root = `${R1_TAIL_ROOT}/backups/r1-tail108-119-${operation.attemptId}`;
  return Object.freeze({
    root,
    request: R1_TAIL_REQUEST,
    containerName: `phub-r1-tail108-119-${operation.attemptId}`,
    receipt: `${root}/migration-receipt.json`,
    success: `${root}/migration-success.json`,
  });
}
export function validateR1TailOperation(op, at) {
  r1Exact(op, [
    'schema',
    'profile',
    'target',
    'expectedDatabaseTarget',
    'controllerSha',
    'controllerTree',
    'controllerSourceCiRunId',
    'publishedMigrator',
    'migrationProfile',
    'packageDescriptorSha256',
    'catalogBuilderSha256',
    'expectedApi',
    'expectedWorker',
    'expectedPostgres',
    'catalogVariant',
    'catalogsSha256',
    'fromCount',
    'attemptId',
    'expectedRuntimeSha256',
    'expectedSecretsSha256',
    'expectedSecuritySha256',
    'previousMigrationSuccess',
    'backup',
    'resume',
    'expiresAt',
    'confirmation',
  ]);
  r1Exact(op.target, ['hostname', 'serverId', 'projectId']);
  r1Exact(op.expectedDatabaseTarget, ['databaseName', 'systemIdentifier']);
  r1Exact(op.publishedMigrator, [
    'sourceSha',
    'sourceTree',
    'publicationRunId',
    'publicationRunAttempt',
    'manifestSha256',
    'image',
    'imageId',
  ]);
  if (
    op.schema !== 'PHUB_R1_TAIL108_119_OPERATION_V1' ||
    op.profile !== 'beta' ||
    op.target.hostname !== 'lk2.padlhub.su' ||
    op.target.serverId !== 8886471 ||
    op.target.projectId !== 262717 ||
    op.expectedDatabaseTarget.databaseName !== 'phub_beta' ||
    op.expectedDatabaseTarget.systemIdentifier !== '7679125609183186977' ||
    !SHA.test(op.controllerSha ?? '') ||
    !SHA.test(op.controllerTree ?? '') ||
    !/^[1-9][0-9]*$/.test(op.controllerSourceCiRunId ?? '') ||
    !['DORMANT', 'SCENARIO_EDITOR_V1'].includes(op.catalogVariant) ||
    !Number.isSafeInteger(op.fromCount) ||
    op.fromCount < 108 ||
    op.fromCount > 118 ||
    !UUID.test(op.attemptId ?? '') ||
    ![
      'catalogsSha256',
      'expectedRuntimeSha256',
      'expectedSecretsSha256',
      'expectedSecuritySha256',
    ].every((k) => HASH.test(op[k] ?? ''))
  )
    r1Stop('OPERATION');
  if (
    op.migrationProfile !== 'r1_tail108_119' ||
    !HASH.test(op.packageDescriptorSha256 ?? '') ||
    !HASH.test(op.catalogBuilderSha256 ?? '')
  )
    r1Stop('PROFILE');
  for (const [key, service] of [
    ['expectedApi', 'api'],
    ['expectedWorker', 'worker'],
    ['expectedPostgres', 'postgres'],
  ])
    validateClosedRuntimeIdentity(op[key], service);
  if (op.expectedPostgres.id !== CLOSED_APPLICATION_POSTGRES_CONTAINER) r1Stop('POSTGRES_TARGET');
  const image = op.publishedMigrator;
  if (
    image.sourceSha !== op.controllerSha ||
    image.sourceTree !== op.controllerTree ||
    !/^[1-9][0-9]*$/.test(image.publicationRunId ?? '') ||
    image.publicationRunAttempt !== 1 ||
    !HASH.test(image.manifestSha256 ?? '') ||
    !/^sha256:[a-f0-9]{64}$/.test(image.imageId ?? '') ||
    !/^ghcr\.io\/z6v6e6r\/phub-migrator@sha256:[a-f0-9]{64}$/.test(image.image ?? '')
  )
    r1Stop('IMAGE');
  r1Exact(op.previousMigrationSuccess, ['path', 'sha256', 'operationSha256']);
  if (
    !new RegExp(
      `^${R1_TAIL_ROOT}/backups/[a-f0-9]{40}-[1-9][0-9]*-1-subject-link0104-migration/migration-success\\.json$`,
    ).test(op.previousMigrationSuccess.path ?? '') ||
    !HASH.test(op.previousMigrationSuccess.sha256 ?? '') ||
    !HASH.test(op.previousMigrationSuccess.operationSha256 ?? '')
  )
    r1Stop('PREDECESSOR');
  r1Exact(op.backup, ['operationPath', 'operationSha256', 'receiptSha256', 'preimageSha256']);
  if (
    !new RegExp(
      `^${R1_TAIL_ROOT}/backups/[a-f0-9]{40}-[1-9][0-9]*-1-r1-tail-pre(?:108|109|11[0-8])-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}/backup-operation\\.json$`,
    ).test(op.backup.operationPath ?? '') ||
    !['operationSha256', 'receiptSha256', 'preimageSha256'].every((k) =>
      HASH.test(op.backup[k] ?? ''),
    )
  )
    r1Stop('BACKUP');
  if (op.fromCount === 108) {
    if (op.resume !== null) r1Stop('RESUME');
  } else {
    r1Exact(op.resume, ['attemptId', 'receiptSha256', 'operationSha256', 'count']);
    if (
      !UUID.test(op.resume.attemptId ?? '') ||
      op.resume.attemptId === op.attemptId ||
      !HASH.test(op.resume.receiptSha256 ?? '') ||
      !HASH.test(op.resume.operationSha256 ?? '') ||
      op.resume.count !== op.fromCount
    )
      r1Stop('RESUME');
  }
  const expiry = Date.parse(op.expiresAt);
  if (
    !Number.isFinite(expiry) ||
    new Date(expiry).toISOString() !== op.expiresAt ||
    (at !== undefined && (expiry - at < 1200000 || expiry - at > 3600000)) ||
    op.confirmation !==
      `MIGRATE_R1_TAIL_FROM_${op.fromCount}_TO_119_KEEP_RUNTIME_NO_SEND_NO_PURCHASE`
  )
    r1Stop('AUTHORITY');
  return op;
}
export function validateR1TailRecord(value, operationSha256, planSha256) {
  r1Exact(value, [
    'schema',
    'operationSha256',
    'planSha256',
    'status',
    'containerId',
    'count',
    'stateSha256',
    'observedAt',
  ]);
  if (
    value.schema !== 'PHUB_R1_TAIL_RECEIPT_V1' ||
    value.operationSha256 !== operationSha256 ||
    value.planSha256 !== planSha256 ||
    ![
      'PREPARED',
      'BOOTSTRAP_INTENT',
      'BOOTSTRAPPED',
      'CREATE_INTENT',
      'CREATED',
      'START_INTENT',
      'STARTED',
      'CLEANUP_INTENT',
      'ABORTED',
      'PARTIAL',
      'SUCCESS',
    ].includes(value.status) ||
    (value.containerId !== null && !HASH.test(value.containerId ?? '')) ||
    !Number.isSafeInteger(value.count) ||
    value.count < 108 ||
    value.count > 119 ||
    (value.stateSha256 !== null && !HASH.test(value.stateSha256 ?? '')) ||
    !Number.isFinite(Date.parse(value.observedAt))
  )
    r1Stop('RECEIPT');
  return value;
}
// Historical terminal evidence is independent of current application identities. The
// caller authenticates retained paths and backup custody; this function has no effects.
export function validateR1TailCompletedEvidence(reference, blobs, expectedRoleSourceSha256) {
  const files = [
    'request.json',
    'preparation.json',
    'plan.json',
    'migration-receipt.json',
    'migration-success.json',
    'cleanup.json',
    'role-proof.json',
  ];
  r1Exact(reference, ['schema', 'attemptId', 'controllerSha', 'controllerTree', 'files', 'backup']);
  if (
    reference.schema !== 'PHUB_R1_TAIL_COMPLETED_V1' ||
    !HASH.test(expectedRoleSourceSha256 ?? '')
  )
    r1Stop('COMPLETED_REFERENCE');
  r1TailPaths(reference);
  r1Exact(reference.files, files);
  r1Exact(blobs, files);
  for (const name of files)
    if (
      !Buffer.isBuffer(blobs[name]) ||
      !HASH.test(reference.files[name] ?? '') ||
      r1Hash(blobs[name]) !== reference.files[name]
    )
      r1Stop('COMPLETED_FILE_HASH');
  const op = validateR1TailOperation(parseStrictJson(blobs['request.json']));
  if (
    op.attemptId !== reference.attemptId ||
    op.controllerSha !== reference.controllerSha ||
    op.controllerTree !== reference.controllerTree
  )
    r1Stop('COMPLETED_SOURCE');
  r1Exact(reference.backup, [
    'path',
    'sha256',
    'operationSha256',
    'preimageSha256',
    'target',
    'sourceLedgerSha256',
  ]);
  if (
    reference.backup.path !==
      op.backup.operationPath.replace(/backup-operation\.json$/u, 'database-backup-receipt.json') ||
    reference.backup.sha256 !== op.backup.receiptSha256 ||
    reference.backup.operationSha256 !== op.backup.operationSha256 ||
    reference.backup.preimageSha256 !== op.backup.preimageSha256 ||
    !r1Same(reference.backup.target, op.expectedDatabaseTarget) ||
    reference.backup.sourceLedgerSha256 !== R1_TAIL.checkpoints[String(op.fromCount)]
  )
    r1Stop('COMPLETED_BACKUP_BINDING');
  const capsule = parseStrictJson(blobs['preparation.json']);
  r1Exact(capsule, ['operation', 'plan']);
  if (
    capsule.operation !== blobs['request.json'].toString('base64') ||
    capsule.plan !== blobs['plan.json'].toString('base64')
  )
    r1Stop('COMPLETED_CAPSULE');
  const plan = parseStrictJson(blobs['plan.json']);
  r1Exact(plan, [
    'schema',
    'operationSha256',
    'runtime',
    'secrets',
    'preimage',
    'backup',
    'inventorySha256',
    'catalogsSha256',
    'preparation',
  ]);
  if (
    plan.schema !== 'PHUB_R1_TAIL_PLAN_V1' ||
    plan.operationSha256 !== reference.files['request.json'] ||
    plan.inventorySha256 !== r1Hash(r1Encode(R1_TAIL)) ||
    plan.catalogsSha256 !== op.catalogsSha256 ||
    r1Hash(r1Encode(plan.runtime)) !== op.expectedRuntimeSha256 ||
    r1Hash(r1Encode(plan.secrets)) !== op.expectedSecretsSha256 ||
    r1Hash(r1Encode(plan.preimage.security)) !== op.expectedSecuritySha256 ||
    !r1Same(plan.backup, reference.backup)
  )
    r1Stop('COMPLETED_PLAN');
  validateR1TailState(op, plan.preimage, 'cleaned', op.fromCount);
  validateR1TailPreparation(plan.preparation, plan.preimage.security);
  const receipt = validateR1TailRecord(
    parseStrictJson(blobs['migration-receipt.json']),
    reference.files['request.json'],
    reference.files['plan.json'],
  );
  if (
    receipt.status !== 'SUCCESS' ||
    receipt.count !== 119 ||
    receipt.containerId === null ||
    !blobs['migration-success.json'].equals(r1Encode(receipt)) ||
    receipt.stateSha256 !== reference.files['cleanup.json']
  )
    r1Stop('COMPLETED_TERMINAL');
  const cleanup = parseStrictJson(blobs['cleanup.json']);
  validateR1TailState(op, cleanup, 'cleaned', 119);
  if (!r1Same(cleanup.security, plan.preparation.preimage)) r1Stop('COMPLETED_CLEANUP');
  const role = parseStrictJson(blobs['role-proof.json']);
  r1Exact(role, ['containerId', 'operationSha256', 'sourceSha256']);
  if (
    !HASH.test(role.containerId ?? '') ||
    role.operationSha256 !== reference.files['request.json'] ||
    role.sourceSha256 !== expectedRoleSourceSha256
  )
    r1Stop('COMPLETED_ROLE_PROOF');
  return { operation: op, plan, receipt, cleanup, roleProof: role };
}
// Every effect is supplied by trusted source code. Reconcile has no create/start/forward-grant calls.
export async function runR1TailAdapter(mode, bytes, ops) {
  if (!['deploy', 'reconcile'].includes(mode)) r1Stop('MODE');
  const op = validateR1TailOperation(
    parseStrictJson(bytes),
    mode === 'deploy' ? ops.time() : undefined,
  );
  const operationSha256 = r1Hash(bytes);
  await ops.assertSource(op);
  await ops.assertPrevious(op);
  let plan, planBytes, record;
  const write = async (status, extra = {}) => {
    record = {
      schema: 'PHUB_R1_TAIL_RECEIPT_V1',
      operationSha256,
      planSha256: r1Hash(planBytes),
      status,
      containerId: record?.containerId ?? null,
      count: record?.count ?? op.fromCount,
      stateSha256: record?.stateSha256 ?? null,
      observedAt: new Date(ops.time()).toISOString(),
      ...extra,
    };
    validateR1TailRecord(record, operationSha256, r1Hash(planBytes));
    await ops.writeReceipt(r1Encode(record));
  };
  const fresh = async () => {
    await ops.assertOwned();
    await ops.assertSource(op);
    if (ops.time() >= Date.parse(op.expiresAt)) r1Stop('EXPIRED');
    await ops.assertAuthority(op);
    if (
      !r1Same(await ops.runtime(), plan.runtime) ||
      !r1Same(await ops.secrets(), plan.secrets) ||
      !r1Same(await ops.backup(op, true), plan.backup) ||
      (await ops.image()) !== op.publishedMigrator.imageId
    )
      r1Stop('PREFLIGHT_DRIFT');
    if (ops.time() >= Date.parse(op.expiresAt)) r1Stop('EXPIRED');
  };
  if (mode === 'deploy') {
    await ops.assertUnused();
    await ops.assertAuthority(op);
    const runtime = await ops.runtime(),
      secrets = await ops.secrets(),
      preimage = await ops.state('cleaned');
    if (
      r1Hash(r1Encode(runtime)) !== op.expectedRuntimeSha256 ||
      r1Hash(r1Encode(secrets)) !== op.expectedSecretsSha256 ||
      r1Hash(r1Encode(preimage.security)) !== op.expectedSecuritySha256 ||
      r1LedgerCount(preimage.ledger) !== op.fromCount
    )
      r1Stop('PREIMAGE');
    await ops.validateState(preimage, 'cleaned', op.fromCount);
    const backup = await ops.backup(op, true);
    if ((await ops.image()) !== op.publishedMigrator.imageId) r1Stop('IMAGE_DRIFT');
    if (op.resume) await ops.assertResume(op);
    plan = {
      schema: 'PHUB_R1_TAIL_PLAN_V1',
      operationSha256,
      runtime,
      secrets,
      preimage,
      backup,
      inventorySha256: r1Hash(r1Encode(R1_TAIL)),
      catalogsSha256: op.catalogsSha256,
      preparation: await ops.preparationPlan(preimage.security),
    };
    planBytes = r1Encode(plan);
    await ops.prepare(bytes, planBytes);
    await write('PREPARED');
    await ops.claim(planBytes, operationSha256);
    await fresh();
    if (!r1Same(await ops.state('cleaned'), preimage)) r1Stop('PREIMAGE_DRIFT');
    await write('BOOTSTRAP_INTENT');
    await fresh();
    await ops.bootstrap(plan.preparation);
    const prepared = await ops.state('prepared');
    await ops.validateState(prepared, 'prepared', op.fromCount);
    await ops.writeProof('bootstrap', r1Encode(prepared));
    await write('BOOTSTRAPPED');
    await fresh();
    await ops.roleProof();
    await fresh();
    await write('CREATE_INTENT');
    await fresh();
    const id = await ops.create();
    if (!HASH.test(id ?? '')) r1Stop('CONTAINER_ID');
    await write('CREATED', { containerId: id });
    await fresh();
    await write('START_INTENT');
    await fresh();
    await ops.start(id);
    await write('STARTED');
    await ops.wait(id);
  } else {
    const saved = await ops.preparation();
    r1Exact(saved, ['operation', 'plan']);
    if (saved.operation !== bytes.toString('base64')) r1Stop('REQUEST_DRIFT');
    planBytes = Buffer.from(saved.plan, 'base64');
    if (planBytes.toString('base64') !== saved.plan) r1Stop('PLAN_ENCODING');
    plan = parseStrictJson(planBytes);
    r1Exact(plan, [
      'schema',
      'operationSha256',
      'runtime',
      'secrets',
      'preimage',
      'backup',
      'inventorySha256',
      'catalogsSha256',
      'preparation',
    ]);
    if (
      plan.schema !== 'PHUB_R1_TAIL_PLAN_V1' ||
      plan.operationSha256 !== operationSha256 ||
      plan.inventorySha256 !== r1Hash(r1Encode(R1_TAIL)) ||
      plan.catalogsSha256 !== op.catalogsSha256
    )
      r1Stop('PLAN_DRIFT');
    await ops.loadPlan(plan, planBytes, operationSha256);
    record = validateR1TailRecord(
      parseStrictJson(await ops.receipt()),
      operationSha256,
      r1Hash(planBytes),
    );
    await ops.reconcileOwnership(record);
    if (['SUCCESS', 'PARTIAL', 'ABORTED'].includes(record.status)) {
      await ops.assertTerminalOwned();
      if (
        !r1Same(await ops.runtime(), plan.runtime) ||
        !r1Same(await ops.secrets(), plan.secrets) ||
        !r1Same(await ops.backup(op, false), plan.backup)
      )
        r1Stop('CUSTODY_DRIFT');
      const final = await ops.state('cleaned');
      if (r1LedgerCount(final.ledger) !== record.count) r1Stop('TERMINAL_DRIFT');
      await ops.validateState(final, 'cleaned', record.count);
      await ops.assertStoppedProbes();
      if (record.status === 'SUCCESS') await ops.attestRoleProof();
      await ops.attestTerminal(record);
      if (record.status === 'SUCCESS') await ops.success(r1Encode(record));
      await ops.releaseTerminal();
      return {
        status: record.status,
        count: record.count,
        ledgerSha256: R1_TAIL.checkpoints[String(record.count)],
        replayAllowed: false,
      };
    }
  }
  // No transport failure is retried. Derive a terminal classification from exact retained state.
  await ops.assertOwned();
  if (
    !r1Same(await ops.runtime(), plan.runtime) ||
    !r1Same(await ops.secrets(), plan.secrets) ||
    !r1Same(await ops.backup(op, false), plan.backup)
  )
    r1Stop('CUSTODY_DRIFT');
  const row = await ops.lookup(),
    state = await ops.state('either');
  const count = r1LedgerCount(state.ledger);
  if (
    count < op.fromCount ||
    (record.containerId && row?.id !== record.containerId) ||
    row?.status === 'running' ||
    (row && !['created', 'exited'].includes(row.status))
  )
    r1Stop('OUTCOME_UNKNOWN');
  const startPossible = [
    'START_INTENT',
    'STARTED',
    'CLEANUP_INTENT',
    'PARTIAL',
    'SUCCESS',
  ].includes(record.status);
  if (startPossible && (!row || row.status !== 'exited')) r1Stop('OUTCOME_UNKNOWN');
  let terminal;
  if (count === 119) {
    if (!row || row.status !== 'exited' || row.exitCode !== 0) r1Stop('OUTCOME_UNKNOWN');
    terminal = 'SUCCESS';
  } else if (count > op.fromCount) {
    if (
      !row ||
      row.status !== 'exited' ||
      !Number.isSafeInteger(row.exitCode) ||
      row.exitCode === 0
    )
      r1Stop('OUTCOME_UNKNOWN');
    terminal = 'PARTIAL';
  } else {
    if (row?.status === 'exited' && row.exitCode === 0) r1Stop('OUTCOME_UNKNOWN');
    if (startPossible && (!row || !Number.isSafeInteger(row.exitCode) || row.exitCode === 0))
      r1Stop('OUTCOME_UNKNOWN');
    terminal = 'ABORTED';
  }
  if (['SUCCESS', 'PARTIAL', 'ABORTED'].includes(record.status) && record.status !== terminal)
    r1Stop('TERMINAL_DRIFT');
  await ops.assertStoppedProbes();
  if (terminal === 'SUCCESS') await ops.attestRoleProof();
  await ops.validateState(state, 'either', count);
  await write('CLEANUP_INTENT', { count });
  // Cleanup can only restore the sealed owned delta, including after authorization expiry.
  await ops.cleanup(plan.preparation, state);
  const final = await ops.state('cleaned');
  await ops.validateState(final, 'cleaned', count);
  await ops.writeProof('cleanup', r1Encode(final));
  await write(terminal, { count, stateSha256: r1Hash(r1Encode(final)) });
  if (terminal === 'SUCCESS') await ops.success(r1Encode(record));
  await ops.release();
  return {
    status: terminal,
    count,
    ledgerSha256: R1_TAIL.checkpoints[String(count)],
    replayAllowed: false,
  };
}
