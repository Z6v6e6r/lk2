// Host binding for the two closed, individually authorized migration steps.
// Importing this module performs no IO. The restore child's source check stays pure.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import {
  upgradeGit as git,
  readUpgradeFile as read,
  secureUpgradePath as secure,
} from './timeweb-api-web-upgrade.js';
import {
  closedApplicationProductionPaths,
  closedApplicationPreviousRequestHashes,
  closedApplicationRequestPath,
  createClosedApplicationProductionEffects,
  readApiWorkerMigrationCapsule,
  runManualClosedApplicationMigration,
} from './timeweb-api-worker-migration.js';
import { acquireApiWorkerExecutor } from './timeweb-api-worker-upgrade.js';
import {
  assertNoAmbientComposeOverrides,
  assertNoAmbientDockerOverrides,
} from './render-timeweb-beta-release-env.js';
import { parseStrictJson } from './strict-json.js';
import { closedApplicationAclPlan } from './closed-application-migration-acl.js';
import { attestClosedApplicationControllerSource } from './timeweb-closed-application-source.js';
import {
  CLOSED_APPLICATION_STAGE,
  assertClosedApplicationRuntimeOff,
  closedApplicationInputDigests,
  closedApplicationSchemas,
  closedApplicationStateSql,
  createClosedApplicationKernelProfile,
  validateClosedApplicationManifest,
  validateClosedApplicationOperation,
  validateClosedApplicationPlan,
  validateClosedApplicationReceipt,
  validateClosedApplicationRoleReadback,
  validateClosedApplicationState,
} from './timeweb-closed-application-profile.js';
import {
  CLOSED_APPLICATION_BACKUPS,
  closedApplicationBackupBindingSha256,
  closedApplicationBackupDirectory,
  closedApplicationMigrationBinding,
  validateClosedApplicationBackupOperation,
  validateClosedApplicationBackupReceipt,
} from './timeweb-closed-application-backup.js';

const ROOT = '/opt/phub/timeweb-beta',
  SOURCE = `${ROOT}/standard/source`;
const BACKUP_REQUEST = `${ROOT}/operator/database-backup-restore.json`;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const encoded = (value) => Buffer.from(JSON.stringify(value) + '\n');
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort())
      : item,
  );
const same = (a, b) => canonical(a) === canonical(b);
const fail = (code) => {
  throw Error(`CLOSED_APPLICATION_RUNTIME_${code}`);
};
const exact = (value, keys) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !same(Object.keys(value).sort(), [...keys].sort())
  )
    fail('SHAPE');
};
const present = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};
const dependencies = { git, read, secure, present };
const noMutationOwner = { assertOwned: () => fail('READ_ONLY') };

// Called inside the networkless restore child: fs/Git only, no env, Docker, CI or network.
export function attestClosedApplicationBackupSource(backup, deps = dependencies) {
  validateClosedApplicationBackupOperation(backup);
  return attestClosedApplicationControllerSource(backup.migrationIntent, deps);
}

function attestHostSource(operation, deps) {
  attestClosedApplicationControllerSource(operation, deps);
  const environment = {
    api: deps.read('/etc/phub/timeweb-beta/api.env'),
    worker: deps.read('/etc/phub/timeweb-beta/worker.env'),
  };
  for (const service of ['api', 'worker'])
    if (hash(environment[service]) !== operation.expectedSecretSetFiles[`${service}.env`])
      fail('ENV_PREIMAGE');
  assertClosedApplicationRuntimeOff(operation, environment, deps.git);
}

export function readClosedApplicationDatabaseState(operation, phase, deps) {
  validateClosedApplicationOperation(operation);
  const target = deps.postgresSql(
    "begin read only;select json_build_object('databaseName',current_database(),'systemIdentifier',(select system_identifier::text from pg_catalog.pg_control_system()));rollback;",
    true,
    operation.expectedPostgres.id,
  );
  if (!same(target, operation.expectedDatabaseTarget)) fail('DATABASE_TARGET');
  const state = deps.postgresSql(
    closedApplicationStateSql(operation.migrationProfile, phase),
    true,
    operation.expectedPostgres.id,
  );
  validateClosedApplicationState(operation, state, phase);
  return state;
}

function terminalProof(backup, backupBytes, receiptBytes, preimageBytes, deps, retained) {
  const operation = backup.migrationIntent;
  const tool = `${ROOT}/operator/tools/${operation.controllerSha}/control-timeweb-database-backup.py`;
  if (
    hash(deps.read(tool, 0o755)) !== backup.toolFileSha256 ||
    hash(
      deps.read(`${ROOT}/operator/tools/${operation.controllerSha}/installation-receipt.json`),
    ) !== backup.toolInstallationSha256
  )
    fail('BACKUP_TOOL');
  const path = retained
    ? `${closedApplicationBackupDirectory(backup)}/backup-operation.json`
    : BACKUP_REQUEST;
  if (!deps.read(path).equals(backupBytes)) fail('BACKUP_REQUEST');
  let terminal;
  try {
    terminal = parseStrictJson(
      (
        deps.terminal ??
        ((args) =>
          execFileSync('/usr/bin/python3', args, {
            timeout: 120000,
            maxBuffer: 4 * 1024 * 1024,
            env: { PATH: '/usr/bin:/bin', HOME: '/root', LANG: 'C.UTF-8' },
            stdio: ['ignore', 'pipe', 'pipe'],
          }))
      )(['-I', '-S', '-B', tool, retained ? '--attest-closed-retained' : '--attest-disk', path]),
    );
  } catch {
    fail('BACKUP_TERMINAL_UNKNOWN');
  }
  const receipt = parseStrictJson(receiptBytes),
    definition = CLOSED_APPLICATION_BACKUPS[operation.migrationProfile];
  exact(terminal, [
    'schema',
    'operationSha256',
    'receiptSha256',
    'preimageSha256',
    'target',
    'sourceLedgerSha256',
    'storageCleanupVerified',
    'reconciled',
    'migratorPrefetch',
    'migrationProfile',
    'catalogVariant',
    'catalogBuilderSha256',
    'migrationBindingSha256',
  ]);
  if (
    terminal.schema !== definition.terminalSchema ||
    terminal.operationSha256 !== hash(backupBytes) ||
    terminal.receiptSha256 !== hash(receiptBytes) ||
    terminal.preimageSha256 !== hash(preimageBytes) ||
    !same(terminal.target, operation.expectedDatabaseTarget) ||
    terminal.sourceLedgerSha256 !== definition.ledgerSha256 ||
    terminal.storageCleanupVerified !== true ||
    terminal.reconciled !== true ||
    !same(terminal.migratorPrefetch, receipt.migratorPrefetch) ||
    terminal.migrationProfile !== operation.migrationProfile ||
    terminal.catalogVariant !== operation.catalogVariant ||
    terminal.catalogBuilderSha256 !== operation.catalogBuilderSha256 ||
    terminal.migrationBindingSha256 !== closedApplicationBackupBindingSha256(operation)
  )
    fail('BACKUP_TERMINAL');
}

export function readClosedApplicationBackupProof(operation, options = {}, deps = dependencies) {
  validateClosedApplicationOperation(operation);
  const mode = CLOSED_APPLICATION_STAGE[operation.migrationProfile].backupMode;
  const directory = `${ROOT}/backups/${operation.controllerSha}-${operation.controllerSourceCiRunId}-1-${mode}`;
  deps.secure(directory, 0o700);
  const backupBytes = deps.read(`${directory}/backup-operation.json`),
    backup = parseStrictJson(backupBytes);
  const receiptBytes = deps.read(`${directory}/database-backup-receipt.json`);
  const preimageBytes = deps.read(`${directory}/preimage-proof.json`);
  const proof = validateClosedApplicationBackupReceipt(
    operation,
    backup,
    backupBytes,
    receiptBytes,
    preimageBytes,
    options,
  );
  terminalProof(backup, backupBytes, receiptBytes, preimageBytes, deps, options.retained === true);
  // Saved source/pre-state proof is checked after migration too; no fresh pre-ledger query here.
  readClosedApplicationPrefetchProof(operation, deps, backup.migratorPrefetch);
  return proof;
}

export function attestClosedApplicationPrevious(operation, deps = dependencies) {
  validateClosedApplicationOperation(operation);
  if (operation.migrationProfile === 'game_start_0103') return null;
  const pointer = operation.previousMigrationSuccess;
  const root = pointer.path.slice(0, -'/migration-success.json'.length);
  deps.secure(root, 0o700);
  const capsule = readApiWorkerMigrationCapsule(deps.read(`${root}/preparation.json`));
  const previous = validateClosedApplicationOperation(capsule.operation),
    paths = closedApplicationProductionPaths(previous);
  if (
    previous.migrationProfile !== 'game_start_0103' ||
    paths.transactionRoot !== root ||
    previous.controllerSha !== operation.controllerSha ||
    previous.controllerTree !== operation.controllerTree ||
    previous.controllerSourceCiRunId !== operation.controllerSourceCiRunId ||
    !same(previous.publishedMigrator, operation.publishedMigrator) ||
    !same(previous.expectedApi, operation.expectedApi) ||
    !same(previous.expectedWorker, operation.expectedWorker) ||
    !same(previous.expectedPostgres, operation.expectedPostgres) ||
    previous.expectedSecretSetReleaseId !== operation.expectedSecretSetReleaseId ||
    !same(previous.expectedSecretSetFiles, operation.expectedSecretSetFiles) ||
    previous.catalogVariant !== operation.catalogVariant ||
    hash(capsule.operationBytes) !== pointer.operationSha256 ||
    !deps.read(paths.requestPath).equals(capsule.operationBytes) ||
    !deps.read(`${root}/plan.json`).equals(capsule.planBytes)
  )
    fail('PREVIOUS_BINDING');
  const plan = validateClosedApplicationPlan(capsule.plan, capsule.operationBytes);
  const planSha = hash(capsule.planBytes),
    opSha = hash(capsule.operationBytes);
  const successBytes = deps.read(pointer.path),
    success = parseStrictJson(successBytes);
  const receipt = validateClosedApplicationReceipt(
    'game_start_0103',
    parseStrictJson(deps.read(`${root}/migration-receipt.json`)),
    planSha,
    opSha,
  );
  const schemas = closedApplicationSchemas('game_start_0103');
  exact(success, [
    'schema',
    'status',
    'planSha256',
    'operationSha256',
    'containerId',
    'bootstrapSha256',
    'cleanupSha256',
    'migratorPreSha256',
    'migratorBootstrapSha256',
    'backup',
    'ledgerSha256',
    'stateSha256',
    'observedAt',
  ]);
  if (
    hash(successBytes) !== pointer.sha256 ||
    success.schema !== schemas.success ||
    success.status !== 'SUCCESS' ||
    success.operationSha256 !== opSha ||
    success.planSha256 !== planSha ||
    success.ledgerSha256 !== plan.postLedgerSha256 ||
    !same(success.backup, plan.backup) ||
    receipt.status !== 'RECONCILED' ||
    receipt.reconciledStatus !== 'SUCCESS' ||
    receipt.successSha256 !== pointer.sha256 ||
    receipt.containerId !== success.containerId ||
    !Number.isFinite(Date.parse(success.observedAt))
  )
    fail('PREVIOUS_SUCCESS');
  const effects = (deps.effects ?? createClosedApplicationProductionEffects)(
    previous,
    noMutationOwner,
    createClosedApplicationProductionBinding(previous),
  );
  effects.loadPlan(plan, capsule.planBytes, opSha);
  for (const [name, key, schema, phase] of [
    ['bootstrap', 'bootstrapSha256', schemas.bootstrapProof, 'bootstrap'],
    ['cleanup', 'cleanupSha256', schemas.cleanupProof, 'cleanup'],
  ]) {
    const bytes = deps.read(`${root}/${name}.json`),
      proof = parseStrictJson(bytes);
    exact(proof, ['schema', 'operationSha256', 'sqlSha256', 'state']);
    if (
      hash(bytes) !== success[key] ||
      proof.schema !== schema ||
      proof.operationSha256 !== opSha ||
      proof.sqlSha256 !== plan.inputs[`${name}Sha256`]
    )
      fail('PREVIOUS_ACL_PROOF');
    validateClosedApplicationState(previous, proof.state, phase);
    if (name === 'cleanup' && hash(encoded(proof.state)) !== success.stateSha256)
      fail('PREVIOUS_STATE');
  }
  for (const [phase, key, kind] of [
    ['pre', 'migratorPreSha256', 'migrator'],
    ['bootstrap', 'migratorBootstrapSha256', 'migrator-post'],
  ]) {
    const bytes = deps.read(`${root}/migrator-${phase}.json`),
      proof = parseStrictJson(bytes);
    exact(proof, ['schema', 'operationSha256', 'planSha256', 'phase', 'containerId', 'readback']);
    if (
      hash(bytes) !== success[key] ||
      proof.schema !== schemas.roleProof ||
      proof.operationSha256 !== opSha ||
      proof.planSha256 !== planSha ||
      proof.phase !== phase
    )
      fail('PREVIOUS_ROLE_PROOF');
    validateClosedApplicationRoleReadback(
      previous,
      proof.readback,
      phase,
      previous.expectedDatabaseTarget,
    );
    const row = effects.lookup(kind, plan.imageId, opSha);
    if (
      !row ||
      row.Id !== proof.containerId ||
      row.State.Status !== 'exited' ||
      row.State.ExitCode !== 0 ||
      !same(effects.logs(row.Id), proof.readback)
    )
      fail('PREVIOUS_ROLE_CONTAINER');
  }
  const row = effects.lookup('migration', plan.imageId, opSha);
  if (
    !row ||
    row.Id !== success.containerId ||
    row.State.Status !== 'exited' ||
    row.State.ExitCode !== 0
  )
    fail('PREVIOUS_CONTAINER');
  if (
    !same(
      readClosedApplicationBackupProof(previous, { fresh: false, retained: true }, deps),
      plan.backup,
    )
  )
    fail('PREVIOUS_BACKUP');
  const backupPath = `${ROOT}/backups/${previous.controllerSha}-${previous.controllerSourceCiRunId}-1-game-start-pre0103/backup-operation.json`;
  return {
    schema: 'PHUB_CLOSED_APPLICATION_PREVIOUS_REQUESTS_V1',
    status: 'RECONCILED_SUCCESS',
    migrationProfile: 'game_start_0103',
    sourceSha: previous.controllerSha,
    sourceTree: previous.controllerTree,
    controllerSourceCiRunId: previous.controllerSourceCiRunId,
    operationSha256: opSha,
    successSha256: pointer.sha256,
    requestHashes: {
      [paths.requestPath]: opSha,
      [paths.prefetchRequestPath]: hash(deps.read(paths.prefetchRequestPath)),
      [BACKUP_REQUEST]: hash(deps.read(backupPath)),
    },
  };
}

export function createClosedApplicationProductionBinding(operation) {
  validateClosedApplicationOperation(operation);
  return Object.freeze({
    kind: operation.migrationProfile,
    kernelProfile: createClosedApplicationKernelProfile(operation),
    attestSource: attestHostSource,
    validateManifest: validateClosedApplicationManifest,
    backup: readClosedApplicationBackupProof,
    inputs: (op, deps) => {
      const inputs = closedApplicationInputDigests(op);
      if (
        hash(
          deps.read(
            `${SOURCE}/deploy/timeweb/closed-application-migrations-0103-0104.v1.json`,
            0o644,
          ),
        ) !== inputs.packageDescriptorSha256 ||
        hash(deps.read(`${SOURCE}/scripts/closed-application-migration-catalog.js`, 0o644)) !==
          inputs.catalogBuilderSha256
      )
        fail('INPUT_DRIFT');
      return inputs;
    },
    readState: readClosedApplicationDatabaseState,
    bootstrapSql: (op) =>
      closedApplicationAclPlan(op.migrationProfile, op.expectedPrivilegePreimage).bootstrapSql,
    cleanupSql: (op) =>
      closedApplicationAclPlan(op.migrationProfile, op.expectedPrivilegePreimage).cleanupSql,
    attestPrevious: attestClosedApplicationPrevious,
    assertRuntimeFlags: (op, environments, deps) =>
      assertClosedApplicationRuntimeOff(op, environments, deps.git),
  });
}

export function validateClosedApplicationPrefetchRequest(bytes, at) {
  const value = parseStrictJson(bytes);
  exact(value, ['schema', 'migrationIntent', 'expiresAt', 'confirmation']);
  const op = validateClosedApplicationOperation(value.migrationIntent);
  if (
    value.schema !==
      `${CLOSED_APPLICATION_STAGE[op.migrationProfile].prefix}_PREFETCH_OPERATION_V1` ||
    value.confirmation !==
      `PULL_${op.migrationProfile.toUpperCase()}_MIGRATOR_ONLY_NO_DATABASE_MUTATION` ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    new Date(value.expiresAt).toISOString() !== value.expiresAt ||
    (at !== undefined &&
      (Date.parse(value.expiresAt) - at < 1200000 || Date.parse(value.expiresAt) - at > 3600000))
  )
    fail('PREFETCH_REQUEST');
  return value;
}

function validatePrefetchRecords(operation, bytes, intentBytes, receiptBytes) {
  const request = validateClosedApplicationPrefetchRequest(bytes),
    intent = parseStrictJson(intentBytes),
    receipt = parseStrictJson(receiptBytes);
  if (
    !same(
      closedApplicationMigrationBinding(request.migrationIntent),
      closedApplicationMigrationBinding(operation),
    )
  )
    fail('PREFETCH_BINDING');
  exact(intent, ['schema', 'requestBase64', 'input', 'retainedImageIds']);
  exact(receipt, [
    'schema',
    'requestSha256',
    'migrationBindingSha256',
    'intentSha256',
    'imageId',
    'input',
    'retainedImageIds',
  ]);
  exact(intent.input, ['runtimeSha256', 'secretSetSha256', 'prestate']);
  validateClosedApplicationState(operation, intent.input.prestate, 'pre');
  if (
    intent.schema !==
      `${CLOSED_APPLICATION_STAGE[operation.migrationProfile].prefix}_PREFETCH_INTENT_V1` ||
    receipt.schema !==
      `${CLOSED_APPLICATION_STAGE[operation.migrationProfile].prefix}_PREFETCH_RECEIPT_V1` ||
    intent.requestBase64 !== bytes.toString('base64') ||
    receipt.requestSha256 !== hash(bytes) ||
    receipt.migrationBindingSha256 !== closedApplicationBackupBindingSha256(operation) ||
    receipt.intentSha256 !== hash(intentBytes) ||
    receipt.imageId !== operation.publishedMigrator.imageId ||
    !same(receipt.input, intent.input) ||
    !same(receipt.retainedImageIds, intent.retainedImageIds) ||
    !['runtimeSha256', 'secretSetSha256'].every((key) =>
      /^[a-f0-9]{64}$/.test(intent.input[key] ?? ''),
    ) ||
    !Array.isArray(intent.retainedImageIds) ||
    intent.retainedImageIds.some((id) => !/^sha256:[a-f0-9]{64}$/.test(id)) ||
    !same(intent.retainedImageIds, [...new Set(intent.retainedImageIds)].sort())
  )
    fail('PREFETCH_RECORDS');
  return { intent, receipt };
}
export function readClosedApplicationPrefetchProof(operation, deps = dependencies, expected) {
  const paths = closedApplicationProductionPaths(operation);
  const bytes = deps.read(paths.prefetchRequestPath),
    intent = deps.read(`${paths.prefetchRoot}/intent.json`),
    receipt = deps.read(`${paths.prefetchRoot}/receipt.json`);
  const records = validatePrefetchRecords(operation, bytes, intent, receipt);
  const reference = {
    requestSha256: hash(bytes),
    receiptSha256: hash(receipt),
    migratorImage: operation.publishedMigrator.image,
    imageId: operation.publishedMigrator.imageId,
  };
  if (expected !== undefined && !same(reference, expected)) fail('PREFETCH_REFERENCE');
  return { ...records, reference };
}

async function hostPreflight(operation, effects, deps) {
  attestHostSource(operation, deps);
  attestClosedApplicationPrevious(operation, deps);
  const runtime = await effects.snapshot(),
    secrets = await effects.secrets();
  if (
    !same(runtime.api.identity, operation.expectedApi) ||
    !same(runtime.worker.identity, operation.expectedWorker) ||
    !same(runtime.postgres, operation.expectedPostgres) ||
    secrets.releaseId !== operation.expectedSecretSetReleaseId ||
    !same(secrets.files, operation.expectedSecretSetFiles)
  )
    fail('RUNTIME_PREIMAGE');
  return {
    runtimeSha256: hash(encoded(runtime)),
    secretSetSha256: hash(encoded(secrets)),
    prestate: await effects.closedApplicationState('pre'),
  };
}

export async function runClosedApplicationPrefetchAdapter(mode, bytes, effects) {
  if (!['pull', 'reconcile', 'attest'].includes(mode)) fail('PREFETCH_MODE');
  const request = validateClosedApplicationPrefetchRequest(
      bytes,
      mode === 'pull' ? effects.time() : undefined,
    ),
    operation = request.migrationIntent;
  await effects.assertPrefetchOwner();
  await effects.prefetchUnused();
  await effects.assertSource(operation);
  if (mode !== 'attest') await effects.authority(operation);
  const input = await effects.hostPreflight(operation),
    previousIntent = await effects.prefetchIntent();
  validateClosedApplicationState(operation, input.prestate, 'pre');
  if (mode === 'pull') {
    if (effects.time() >= Date.parse(request.expiresAt)) fail('PREFETCH_EXPIRED');
    if (previousIntent || (await effects.prefetchReceipt())) fail('PREFETCH_USE_RECONCILE');
    const retainedImageIds = await effects.imageInventory();
    if (
      !Array.isArray(retainedImageIds) ||
      retainedImageIds.some((id) => !/^sha256:[a-f0-9]{64}$/.test(id)) ||
      !same(retainedImageIds, [...new Set(retainedImageIds)].sort())
    )
      fail('PREFETCH_IMAGE_INVENTORY');
    await effects.writePrefetchIntent(
      encoded({
        schema: `${CLOSED_APPLICATION_STAGE[operation.migrationProfile].prefix}_PREFETCH_INTENT_V1`,
        requestBase64: bytes.toString('base64'),
        input,
        retainedImageIds,
      }),
    );
    await effects.assertPrefetchOwner();
    if (effects.time() >= Date.parse(request.expiresAt)) fail('PREFETCH_EXPIRED');
    await effects.pullMigrator();
  } else if (!previousIntent) fail('PREFETCH_INTENT_MISSING');
  // Reconciliation never repeats a pull whose outcome is unknown.
  if (!(await effects.prefetchImagePresent())) fail('PREFETCH_IMAGE_UNKNOWN');
  const intentBytes = await effects.prefetchIntent(),
    intent = parseStrictJson(intentBytes),
    images = await effects.imageInventory();
  exact(intent, ['schema', 'requestBase64', 'input', 'retainedImageIds']);
  if (
    intent.requestBase64 !== bytes.toString('base64') ||
    !same(intent.input, input) ||
    !Array.isArray(intent.retainedImageIds) ||
    !intent.retainedImageIds.every((id) => images.includes(id)) ||
    (await effects.image()) !== operation.publishedMigrator.imageId
  )
    fail('PREFETCH_DRIFT');
  await effects.assertPrefetchOwner();
  await effects.prefetchUnused();
  if (!same(await effects.hostPreflight(operation), input)) fail('PREFETCH_INPUT_DRIFT');
  const receipt = {
    schema: `${CLOSED_APPLICATION_STAGE[operation.migrationProfile].prefix}_PREFETCH_RECEIPT_V1`,
    requestSha256: hash(bytes),
    migrationBindingSha256: closedApplicationBackupBindingSha256(operation),
    intentSha256: hash(intentBytes),
    imageId: operation.publishedMigrator.imageId,
    input,
    retainedImageIds: intent.retainedImageIds,
  };
  const saved = await effects.prefetchReceipt();
  if (saved) {
    if (!same(parseStrictJson(saved), receipt)) fail('PREFETCH_RECEIPT_DRIFT');
  } else if (mode === 'attest') fail('PREFETCH_RECEIPT_MISSING');
  else await effects.writePrefetchReceipt(encoded(receipt));
  const receiptBytes = await effects.prefetchReceipt();
  validatePrefetchRecords(operation, bytes, intentBytes, receiptBytes);
  return {
    status: 'CLOSED_APPLICATION_MIGRATOR_PREFETCH_VERIFIED',
    migrationProfile: operation.migrationProfile,
    requestSha256: hash(bytes),
    receiptSha256: hash(receiptBytes),
    imageId: operation.publishedMigrator.imageId,
    databaseMutated: false,
    runtimeMutated: false,
  };
}

export async function runManualClosedApplicationPrefetch(mode, kind, requestPath) {
  if (
    !['pull', 'reconcile', 'attest'].includes(mode) ||
    process.getuid?.() !== 0 ||
    !Object.hasOwn(CLOSED_APPLICATION_STAGE, kind) ||
    requestPath !== `${ROOT}/operator/${CLOSED_APPLICATION_STAGE[kind].slug}-migrator-prefetch.json`
  )
    fail('PREFETCH_ENTRY');
  assertNoAmbientDockerOverrides();
  assertNoAmbientComposeOverrides();
  secure(`${ROOT}/standard`, 0o700);
  const bytes = read(requestPath),
    request = validateClosedApplicationPrefetchRequest(bytes),
    operation = request.migrationIntent;
  if (operation.migrationProfile !== kind) fail('PREFETCH_KIND');
  const owner = acquireApiWorkerExecutor(`${ROOT}/standard/api-worker-executor.lock`);
  try {
    const effects = createClosedApplicationProductionEffects(
      operation,
      owner,
      createClosedApplicationProductionBinding(operation),
    );
    return await runClosedApplicationPrefetchAdapter(mode, bytes, {
      ...effects,
      assertPrefetchOwner: () => owner.assertOwned(),
      hostPreflight: () => hostPreflight(operation, effects, dependencies),
    });
  } finally {
    owner.close();
  }
}

export async function attestClosedApplicationMigratorPrefetchForBackup(backup) {
  validateClosedApplicationBackupOperation(backup);
  const operation = backup.migrationIntent,
    paths = closedApplicationProductionPaths(operation),
    effects = createClosedApplicationProductionEffects(
      operation,
      noMutationOwner,
      createClosedApplicationProductionBinding(operation),
    );
  await effects.assertUnused();
  const previous = closedApplicationPreviousRequestHashes(
    operation,
    attestClosedApplicationPrevious(operation, dependencies),
  );
  const other =
    operation.migrationProfile === 'game_start_0103' ? 'subject_link_0104' : 'game_start_0103';
  for (const path of [
    paths.requestPath,
    closedApplicationRequestPath(other),
    `${ROOT}/operator/${CLOSED_APPLICATION_STAGE[other].slug}-migrator-prefetch.json`,
    `${ROOT}/operator/api-worker-upgrade.json`,
    `${ROOT}/operator/api-worker-migration.json`,
    `${ROOT}/operator/notification-migrator-prefetch.json`,
    `${ROOT}/operator/location-photo-migrator-prefetch.json`,
  ])
    if (present(path) && (!Object.hasOwn(previous, path) || hash(read(path)) !== previous[path]))
      fail('BACKUP_PHASE');
  if (
    !same(parseStrictJson(read(BACKUP_REQUEST)), backup) ||
    present(paths.requestPath) ||
    present(`${ROOT}/operator/api-worker-upgrade.json`) ||
    present(`${ROOT}/operator/api-worker-migration.json`)
  )
    fail('BACKUP_PHASE');
  const saved = readClosedApplicationPrefetchProof(
    operation,
    dependencies,
    backup.migratorPrefetch,
  );
  const input = await hostPreflight(operation, effects, dependencies);
  // Bounded application DML may change footprint counts between prefetch and dump.
  if (
    input.runtimeSha256 !== saved.intent.input.runtimeSha256 ||
    input.secretSetSha256 !== saved.intent.input.secretSetSha256 ||
    (await effects.image()) !== operation.publishedMigrator.imageId ||
    !(await effects.prefetchImagePresent()) ||
    !saved.intent.retainedImageIds.every((id) => effects.imageInventory().includes(id))
  )
    fail('BACKUP_PREFETCH_DRIFT');
  return saved.reference;
}
export function readClosedApplicationBackupDatabaseState(backup) {
  attestClosedApplicationBackupSource(backup);
  const operation = backup.migrationIntent;
  const effects = createClosedApplicationProductionEffects(
    operation,
    noMutationOwner,
    createClosedApplicationProductionBinding(operation),
  );
  return effects.closedApplicationState('pre');
}
export function runClosedApplicationMigration(mode, kind, path) {
  return runManualClosedApplicationMigration(
    mode,
    kind,
    path,
    createClosedApplicationProductionBinding,
  );
}
