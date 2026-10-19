// Closed migration-only mode of the enrolled standard runner. No env swap or FCM key access.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  lstatSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  statSync,
  readlinkSync,
  readdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { parseStrictJson } from './strict-json.js';
import { verifySourceCi } from './verify-source-ci.js';
import {
  API_WORKER_BRIDGE as bridge,
  API_WORKER_MIGRATION_CONTROLLER_FILES,
  exact,
  validateApiWorkerControllerDelta,
  parseApiWorkerControllerDiff,
  withoutExactMigrationCiPatch,
} from './timeweb-api-worker-contract.js';
import { acquireApiWorkerExecutor } from './timeweb-api-worker-upgrade.js';
import {
  githubPublic,
  readUpgradeFile as read,
  secureUpgradePath as secure,
  validateUpgradeCandidateAuthority as candidateAuthority,
  validateUpgradeBackup as backupProof,
  writeUpgradeAtomic as durable,
} from './timeweb-api-web-upgrade.js';
import { describeTimewebRuntimeSecretSet as secretSet } from './provision-timeweb-beta-runtime-secrets.js';
import {
  assertNoAmbientComposeOverrides,
  assertNoAmbientDockerOverrides,
} from './render-timeweb-beta-release-env.js';
import {
  MIGRATION_ROLE_PROBE_SOURCE,
  validateMigrationRoleReadback,
} from './timeweb-api-worker-migration-role.js';

const ROOT = '/opt/phub/timeweb-beta',
  SOURCE = `${ROOT}/standard/source`,
  RUNTIME = '/etc/phub/timeweb-beta';
const REQUEST = `${ROOT}/operator/api-worker-migration.json`,
  ACTIVE = `${ROOT}/standard/active`;
const PROVISION = '/etc/phub/.timeweb-beta.provision.lock';
const MIGRATOR_IMAGE =
  'ghcr.io/z6v6e6r/phub-migrator@sha256:d14be0d6f3d114c9268466e75af09e89811bdcea6801c507f7a2b88c5102aaa3';
const PRE_LEDGER = '025c5ee129bd583131192439d991f0dbbba4fbd19c31c1215bca5adcee9ce17c';
const POST_LEDGER = '34e0fb1115e0066733c6ede34ab1d9fb8fcc2842f2df192fbaefc03a97ce1c2d';
const BASE_SHA = '72ca7789b2a4cd93537b442f75c1b8258fce13a0',
  BASE_TREE = '8a79178d7e340c4ce7008bbf2c0b2b411e704572';
const HASH = /^[a-f0-9]{64}$/,
  SHA = /^[a-f0-9]{40}$/;
const hash = (v) => createHash('sha256').update(v).digest('hex');
const canonical = (v) =>
  JSON.stringify(v, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
const same = (a, b) => canonical(a) === canonical(b),
  stop = (code) => {
    throw Error(`API_WORKER_MIGRATION_${code}`);
  };
const encoded = (v) => Buffer.from(`${JSON.stringify(v)}\n`),
  now = () => new Date().toISOString();
const secretNames = [
  '.release-identity.json',
  'api.env',
  'migrator.env',
  'realtime.env',
  'worker.env',
];
const idFields = ['id', 'image', 'imageId', 'releaseId', 'revision', 'restarts', 'startedAt'];
const phases = [
  'PREPARING',
  'PROBE_RUNTIME_CREATE_INTENT',
  'PROBE_RUNTIME_START_INTENT',
  'PROBE_MIGRATOR_CREATE_INTENT',
  'PROBE_MIGRATOR_START_INTENT',
  'PREPARED',
  'CREATE_INTENT',
  'CREATED',
  'START_INTENT',
  'STARTED',
  'SUCCESS',
  'ABORTED',
  'RECONCILED',
];

export const API_WORKER_MIGRATION_BRIDGE = Object.freeze({
  ...bridge,
  migratorImage: MIGRATOR_IMAGE,
  preLedgerSha256: PRE_LEDGER,
  postLedgerSha256: POST_LEDGER,
});
export function validateApiWorkerMigrationOperation(op, at) {
  exact(op, [
    'schema',
    'target',
    'controllerSha',
    'controllerTree',
    'controllerSourceCiRunId',
    'candidateSha',
    'candidateTree',
    'sourceCiRunId',
    'publicationRunId',
    'artifactId',
    'artifactDigest',
    'manifestSha256',
    'migratorImage',
    'expectedApi',
    'expectedWorker',
    'expectedSecretSetReleaseId',
    'expectedSecretSetFiles',
    'expiresAt',
    'confirmation',
  ]);
  exact(op.target, ['hostname', 'serverId', 'projectId']);
  if (
    op.schema !== 'PHUB_TIMEWEB_API_WORKER_MIGRATION_OPERATION_V1' ||
    !same(op.target, { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 }) ||
    !SHA.test(op.controllerSha ?? '') ||
    !SHA.test(op.controllerTree ?? '') ||
    !/^[1-9][0-9]*$/.test(op.controllerSourceCiRunId ?? '') ||
    op.migratorImage !== MIGRATOR_IMAGE
  )
    stop('OPERATION');
  for (const key of [
    'candidateSha',
    'candidateTree',
    'sourceCiRunId',
    'publicationRunId',
    'artifactId',
    'artifactDigest',
    'manifestSha256',
  ])
    if (op[key] !== bridge[key]) stop('BRIDGE');
  for (const service of ['api', 'worker']) {
    const row = op[service === 'api' ? 'expectedApi' : 'expectedWorker'];
    exact(row, idFields);
    if (
      !HASH.test(row.id ?? '') ||
      row.image !== `ghcr.io/z6v6e6r/phub-${service}@${bridge[`${service}Digest`]}` ||
      row.imageId !== bridge[`${service}Digest`] ||
      row.revision !== bridge[`${service}Source`] ||
      row.releaseId !== (service === 'api' ? bridge.apiRelease : null) ||
      row.restarts !== 0 ||
      !Number.isFinite(Date.parse(row.startedAt))
    )
      stop('PREIMAGE');
  }
  exact(op.expectedSecretSetFiles, secretNames);
  if (
    !/^[a-f0-9]{40}-[1-9][0-9]*-1$/.test(op.expectedSecretSetReleaseId ?? '') ||
    !Object.values(op.expectedSecretSetFiles).every((v) => HASH.test(v ?? '')) ||
    op.confirmation !==
      'MIGRATE_0096_0097_11954FFD6D7B_FROM_0D6078BE7A50_NO_API_WORKER_SECRET_OR_FCM_CHANGE'
  )
    stop('CONFIRMATION');
  const expiry = Date.parse(op.expiresAt);
  if (
    !Number.isFinite(expiry) ||
    new Date(expiry).toISOString() !== op.expiresAt ||
    (at !== undefined && (expiry - at < 1200000 || expiry - at > 3600000))
  )
    stop('EXPIRY');
  return op;
}
export function validateMigrationControllerClosure(entries) {
  const ordinary = withoutExactMigrationCiPatch(entries);
  const paths = new Set();
  for (const v of ordinary) {
    if (
      !v ||
      paths.has(v.path) ||
      !API_WORKER_MIGRATION_CONTROLLER_FILES.has(v.path) ||
      !['A', 'M'].includes(v.status) ||
      v.newMode !== '100644' ||
      v.oldMode !== (v.status === 'A' ? '000000' : '100644') ||
      !SHA.test(v.oldOid ?? '') ||
      !SHA.test(v.newOid ?? '') ||
      /^0{40}$/.test(v.newOid) ||
      (v.status === 'A' && !/^0{40}$/.test(v.oldOid))
    )
      stop('CONTROLLER_DELTA');
    paths.add(v.path);
  }
}
export function validateApiWorkerMigrationLedger(rows, expected) {
  if (!Array.isArray(rows) || ![99, 101].includes(rows.length)) stop('LEDGER_COUNT');
  const tuples = rows.map((v) => {
    exact(v, ['filename', 'checksum']);
    if (!/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(v.filename ?? '') || !HASH.test(v.checksum ?? ''))
      stop('LEDGER');
    return [v.filename, v.checksum];
  });
  if (hash(`${JSON.stringify(tuples)}\n`) !== expected) stop('LEDGER');
  return expected;
}
export function encodeApiWorkerMigrationCapsule(operationBytes, planBytes) {
  return encoded({
    schema: 'PHUB_TIMEWEB_API_WORKER_MIGRATION_CAPSULE_V1',
    operation: operationBytes.toString('base64'),
    plan: planBytes.toString('base64'),
  });
}
export function readApiWorkerMigrationCapsule(bytes) {
  const v = parseStrictJson(bytes);
  exact(v, ['schema', 'operation', 'plan']);
  if (
    v.schema !== 'PHUB_TIMEWEB_API_WORKER_MIGRATION_CAPSULE_V1' ||
    typeof v.operation !== 'string' ||
    typeof v.plan !== 'string'
  )
    stop('CAPSULE');
  const operationBytes = Buffer.from(v.operation, 'base64'),
    planBytes = Buffer.from(v.plan, 'base64');
  if (operationBytes.toString('base64') !== v.operation || planBytes.toString('base64') !== v.plan)
    stop('CAPSULE');
  return {
    operationBytes,
    planBytes,
    operation: parseStrictJson(operationBytes),
    plan: parseStrictJson(planBytes),
  };
}
export function validateMigrationPlan(plan, operationBytes) {
  exact(plan, [
    'schema',
    'operationSha256',
    'controllerSha',
    'controllerTree',
    'controllerSourceCiRunId',
    'candidate',
    'migratorImage',
    'imageId',
    'preLedgerSha256',
    'postLedgerSha256',
    'secretSet',
    'runtime',
    'backup',
    'roleProbeSourceSha256',
  ]);
  const op = validateApiWorkerMigrationOperation(parseStrictJson(operationBytes));
  exact(plan.secretSet, ['releaseId', 'device', 'inode', 'files']);
  exact(plan.secretSet.files, secretNames);
  if (!Number.isSafeInteger(plan.secretSet.device) || !Number.isSafeInteger(plan.secretSet.inode))
    stop('PLAN_SECRETS');
  exact(plan.runtime, ['api', 'worker', 'postgres', 'controllerConfigSha256', 'excluded']);
  for (const key of ['api', 'worker']) {
    exact(plan.runtime[key], ['identity', 'status', 'health', 'fingerprint']);
    exact(plan.runtime[key].identity, idFields);
    if (
      !same(plan.runtime[key].identity, op[key === 'api' ? 'expectedApi' : 'expectedWorker']) ||
      plan.runtime[key].status !== 'running' ||
      plan.runtime[key].health !== 'healthy' ||
      !HASH.test(plan.runtime[key].fingerprint ?? '')
    )
      stop('PLAN_RUNTIME');
  }
  exact(plan.runtime.postgres, idFields);
  if (
    plan.runtime.postgres.id !== bridge.postgresId ||
    plan.runtime.postgres.image !== bridge.postgresImage ||
    !HASH.test(plan.runtime.controllerConfigSha256 ?? '') ||
    !Array.isArray(plan.runtime.excluded) ||
    !plan.runtime.excluded.length
  )
    stop('PLAN_RUNTIME');
  const excludedIds = new Set();
  for (const row of plan.runtime.excluded) {
    exact(row, ['identity', 'status', 'health', 'fingerprint']);
    exact(row.identity, idFields);
    if (
      !HASH.test(row.identity.id ?? '') ||
      excludedIds.has(row.identity.id) ||
      !HASH.test(row.fingerprint ?? '')
    )
      stop('PLAN_RUNTIME');
    excludedIds.add(row.identity.id);
  }
  if (!excludedIds.has(bridge.postgresId)) stop('PLAN_RUNTIME');
  if (
    plan.schema !== 'PHUB_TIMEWEB_API_WORKER_MIGRATION_PLAN_V1' ||
    plan.operationSha256 !== hash(operationBytes) ||
    plan.controllerSha !== op.controllerSha ||
    plan.controllerTree !== op.controllerTree ||
    plan.controllerSourceCiRunId !== op.controllerSourceCiRunId ||
    plan.candidate !== `${op.candidateSha}-${op.publicationRunId}-1` ||
    plan.migratorImage !== MIGRATOR_IMAGE ||
    !/^sha256:[a-f0-9]{64}$/.test(plan.imageId ?? '') ||
    plan.preLedgerSha256 !== PRE_LEDGER ||
    plan.postLedgerSha256 !== POST_LEDGER ||
    plan.roleProbeSourceSha256 !== hash(MIGRATION_ROLE_PROBE_SOURCE) ||
    plan.secretSet.releaseId !== op.expectedSecretSetReleaseId ||
    !same(plan.secretSet.files, op.expectedSecretSetFiles)
  )
    stop('PLAN');
  exact(plan.backup, ['path', 'sha256']);
  if (
    plan.backup.path !==
      `${ROOT}/backups/${op.controllerSha}-${op.controllerSourceCiRunId}-1-web/database-backup-receipt.json` ||
    !HASH.test(plan.backup.sha256 ?? '')
  )
    stop('PLAN_BACKUP');
  return plan;
}
export function validateMigrationReceipt(v, planSha, operationSha) {
  exact(v, [
    'schema',
    'status',
    'planSha256',
    'operationSha256',
    'observedAt',
    'containerId',
    'successSha256',
    'reconciledStatus',
  ]);
  if (
    v.schema !== 'PHUB_TIMEWEB_API_WORKER_MIGRATION_RECEIPT_V1' ||
    !phases.includes(v.status) ||
    v.planSha256 !== planSha ||
    v.operationSha256 !== operationSha ||
    !Number.isFinite(Date.parse(v.observedAt)) ||
    new Date(v.observedAt).toISOString() !== v.observedAt ||
    (v.containerId !== null && !HASH.test(v.containerId ?? '')) ||
    (v.successSha256 !== null && !HASH.test(v.successSha256 ?? '')) ||
    (v.status === 'RECONCILED'
      ? !['SUCCESS', 'ABORTED'].includes(v.reconciledStatus)
      : v.reconciledStatus !== null) ||
    ((v.status === 'SUCCESS' || v.reconciledStatus === 'SUCCESS') &&
      (!v.containerId || !v.successSha256))
  )
    stop('RECEIPT');
  return v;
}

export function migrationCreateArgs(name, operationSha, envFile, kind = 'migration', runtimeRole) {
  const base = /^phub-timeweb-migration-[a-f0-9]{12}-[1-9][0-9]*-1(?:-role-(?:runtime|migrator))?$/;
  if (
    !base.test(name) ||
    !HASH.test(operationSha) ||
    !['migration', 'runtime', 'migrator'].includes(kind) ||
    envFile !== `${RUNTIME}/${kind === 'runtime' ? 'api' : 'migrator'}.env` ||
    (kind !== 'migration' && !name.endsWith(`-role-${kind}`)) ||
    (kind === 'migrator' && !/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole ?? ''))
  )
    stop('CREATE');
  return [
    'create',
    '--pull',
    'never',
    '--name',
    name,
    '--label',
    `phub.migration-operation=${operationSha}`,
    '--label',
    `phub.migration-kind=${kind}`,
    '--label',
    'com.docker.compose.project=phub-timeweb-beta',
    '--label',
    `com.docker.compose.service=${kind === 'migration' ? 'migrator' : 'migration-role-probe'}`,
    '--network',
    'phub-timeweb-beta',
    '--restart',
    'no',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--pids-limit',
    '128',
    '--memory',
    '512m',
    '--memory-swap',
    '512m',
    '--cpus',
    '1',
    '--ipc',
    'none',
    '--env-file',
    envFile,
    ...(kind === 'migration' ? [] : ['--entrypoint', 'node']),
    MIGRATOR_IMAGE,
    ...(kind === 'migration'
      ? []
      : [
          '--input-type=module',
          '-e',
          MIGRATION_ROLE_PROBE_SOURCE,
          kind,
          ...(kind === 'migrator' ? [runtimeRole] : []),
        ]),
  ];
}
export function validateMigrationContainer(v, id, operationSha, state, spec) {
  const h = v?.HostConfig,
    c = v?.Config,
    k = spec?.kind;
  const cmd =
    k === 'migration'
      ? ['node', 'apps/migrator/dist/main.js']
      : [
          '--input-type=module',
          '-e',
          MIGRATION_ROLE_PROBE_SOURCE,
          k,
          ...(k === 'migrator' ? [spec.runtimeRole] : []),
        ];
  if (
    !spec ||
    !['migration', 'runtime', 'migrator'].includes(k) ||
    !v ||
    v.Id !== id ||
    v.Name !== `/${spec.name}` ||
    v.Image !== spec.imageId ||
    c?.Image !== MIGRATOR_IMAGE ||
    c.User !== 'appuser' ||
    c.WorkingDir !== '/app' ||
    !same(c.Entrypoint, k === 'migration' ? null : ['node']) ||
    !same(c.Cmd, cmd) ||
    c.Labels?.['phub.migration-operation'] !== operationSha ||
    c.Labels?.['phub.migration-kind'] !== k ||
    c.Labels?.['com.docker.compose.project'] !== 'phub-timeweb-beta' ||
    c.Labels?.['com.docker.compose.service'] !==
      (k === 'migration' ? 'migrator' : 'migration-role-probe') ||
    !same([...(c.Env ?? [])].sort(), [...spec.env].sort()) ||
    h?.NetworkMode !== 'phub-timeweb-beta' ||
    !same(Object.keys(v.NetworkSettings?.Networks ?? {}), ['phub-timeweb-beta']) ||
    h.RestartPolicy?.Name !== 'no' ||
    h.RestartPolicy?.MaximumRetryCount !== 0 ||
    h.ReadonlyRootfs !== true ||
    h.Privileged !== false ||
    h.AutoRemove !== false ||
    h.PublishAllPorts !== false ||
    !same(h.CapDrop, ['ALL']) ||
    (h.CapAdd ?? []).length ||
    !same(h.SecurityOpt, ['no-new-privileges:true']) ||
    h.PidsLimit !== 128 ||
    h.Memory !== 536870912 ||
    h.MemorySwap !== 536870912 ||
    h.NanoCpus !== 1000000000 ||
    h.IpcMode !== 'none' ||
    ['PidMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode'].some(
      (key) => h[key] && !['private'].includes(h[key]),
    ) ||
    ['Binds', 'Devices', 'DeviceRequests', 'VolumesFrom', 'Links', 'ExtraHosts'].some(
      (key) => (h[key] ?? []).length,
    ) ||
    Object.keys(h.PortBindings ?? {}).length ||
    Object.keys(h.Tmpfs ?? {}).length ||
    (v.Mounts ?? []).length ||
    c.Volumes !== null ||
    v.RestartCount !== 0 ||
    v.State?.Status !== state
  )
    stop('CONTAINER');
}

// Domain-specific effects keep the real controller's crash paths testable without Docker/DB access.
export async function runMigrationAdapter(mode, operationBytes, ops) {
  const op = validateApiWorkerMigrationOperation(
    parseStrictJson(operationBytes),
    mode === 'deploy' ? ops.time() : undefined,
  );
  const operationSha = hash(operationBytes);
  let plan, planBytes, current;
  const initialReceipt = (status, extra = {}) => ({
    schema: 'PHUB_TIMEWEB_API_WORKER_MIGRATION_RECEIPT_V1',
    status,
    planSha256: hash(planBytes),
    operationSha256: operationSha,
    observedAt: now(),
    containerId: current?.containerId ?? null,
    successSha256: current?.successSha256 ?? null,
    reconciledStatus: null,
    ...extra,
  });
  const journal = async (status, extra) => {
    current = initialReceipt(status, extra);
    await ops.writeReceipt(current);
  };
  const attest = async (expected) => {
    await ops.assertSource(op);
    await ops.assertOwned();
    if (!same(await ops.snapshot(), plan.runtime) || !same(await ops.secrets(), plan.secretSet))
      stop('RUNTIME_DRIFT');
    validateApiWorkerMigrationLedger(await ops.ledger(), expected);
  };
  const success = async (row, record = true) => {
    await attest(POST_LEDGER);
    const roleBytes = await ops.readRoleProof();
    const role = parseStrictJson(roleBytes);
    exact(role, [
      'schema',
      'planSha256',
      'operationSha256',
      'observedAt',
      'target',
      'runtime',
      'migrator',
      'runtimeContainerId',
      'migratorContainerId',
    ]);
    if (
      role.schema !== 'PHUB_TIMEWEB_MIGRATION_ROLE_PROOF_V1' ||
      role.planSha256 !== hash(planBytes) ||
      role.operationSha256 !== operationSha
    )
      stop('ROLE_PROOF');
    if (!same(await ops.target(), role.target)) stop('ROLE_TARGET_DRIFT');
    validateMigrationRoleReadback(role.runtime, 'runtime', role.target);
    validateMigrationRoleReadback(
      role.migrator,
      'migrator',
      role.target,
      role.runtime.currentRoleName,
    );
    await ops.attestRoleContainers(role);
    const proof = {
      schema: 'PHUB_TIMEWEB_API_WORKER_MIGRATION_SUCCESS_V1',
      status: 'SUCCESS',
      planSha256: hash(planBytes),
      operationSha256: operationSha,
      containerId: row.Id,
      roleProofSha256: hash(roleBytes),
      observedAt: now(),
    };
    const saved = await ops.successProof();
    if (saved) {
      const old = parseStrictJson(saved);
      exact(old, Object.keys(proof));
      if (!same({ ...old, observedAt: proof.observedAt }, proof)) stop('SUCCESS_DRIFT');
    } else await ops.writeSuccess(encoded(proof));
    if (record)
      await journal('SUCCESS', {
        containerId: row.Id,
        successSha256: hash(await ops.successProof()),
      });
  };
  if (mode === 'deploy') {
    await ops.assertUnused();
    await ops.assertSource(op);
    await ops.authority(op);
    const runtime = await ops.snapshot(),
      secrets = await ops.secrets();
    if (
      !same(runtime.api.identity, op.expectedApi) ||
      !same(runtime.worker.identity, op.expectedWorker) ||
      secrets.releaseId !== op.expectedSecretSetReleaseId ||
      !same(secrets.files, op.expectedSecretSetFiles)
    )
      stop('PREIMAGE');
    validateApiWorkerMigrationLedger(await ops.ledger(), PRE_LEDGER);
    const backup = await ops.backup(op),
      imageId = await ops.image();
    plan = {
      schema: 'PHUB_TIMEWEB_API_WORKER_MIGRATION_PLAN_V1',
      operationSha256: operationSha,
      controllerSha: op.controllerSha,
      controllerTree: op.controllerTree,
      controllerSourceCiRunId: op.controllerSourceCiRunId,
      candidate: `${op.candidateSha}-${op.publicationRunId}-1`,
      migratorImage: MIGRATOR_IMAGE,
      imageId,
      preLedgerSha256: PRE_LEDGER,
      postLedgerSha256: POST_LEDGER,
      secretSet: secrets,
      runtime,
      backup,
      roleProbeSourceSha256: hash(MIGRATION_ROLE_PROBE_SOURCE),
    };
    planBytes = encoded(plan);
    validateMigrationPlan(plan, operationBytes);
    await ops.prepare(encodeApiWorkerMigrationCapsule(operationBytes, planBytes));
    await journal('PREPARING');
    await ops.claim(planBytes, operationSha);
    const fresh = async () => {
      if (ops.time() >= Date.parse(op.expiresAt)) stop('EXPIRED');
      await attest(PRE_LEDGER);
      if (!same(await ops.backup(op), plan.backup) || (await ops.image()) !== plan.imageId)
        stop('CUSTODY_DRIFT');
    };
    const target = await ops.target();
    let runtimeRole;
    const roleProof = {
      schema: 'PHUB_TIMEWEB_MIGRATION_ROLE_PROOF_V1',
      planSha256: hash(planBytes),
      operationSha256: operationSha,
      observedAt: now(),
      target,
      runtime: null,
      migrator: null,
      runtimeContainerId: null,
      migratorContainerId: null,
    };
    for (const kind of ['runtime', 'migrator']) {
      await fresh();
      await journal(`PROBE_${kind.toUpperCase()}_CREATE_INTENT`);
      const container = await ops.create(kind, plan.imageId, operationSha, runtimeRole);
      await fresh();
      await journal(`PROBE_${kind.toUpperCase()}_START_INTENT`);
      await ops.start(container, kind);
      await ops.wait(container, kind);
      const value = validateMigrationRoleReadback(
        await ops.logs(container),
        kind,
        target,
        runtimeRole,
      );
      roleProof[kind] = value;
      roleProof[`${kind}ContainerId`] = container;
      if (kind === 'runtime') runtimeRole = value.currentRoleName;
    }
    roleProof.observedAt = now();
    await ops.writeRoleProof(encoded(roleProof));
    await fresh();
    await journal('PREPARED');
    await journal('CREATE_INTENT');
    const container = await ops.create('migration', plan.imageId, operationSha);
    await journal('CREATED', { containerId: container });
    await fresh();
    await ops.attestRoleContainers(roleProof);
    await fresh();
    await journal('START_INTENT');
    await ops.start(container, 'migration');
    await journal('STARTED');
    await ops.wait(container, 'migration');
    const row = await ops.lookup('migration', plan.imageId, operationSha);
    if (!row || row.Id !== container || row.State.Status !== 'exited' || row.State.ExitCode !== 0)
      stop('EXIT');
    await success(row);
    return { status: 'SUCCESS', receipt: ops.receiptPath };
  }
  if (mode !== 'reconcile') stop('MODE');
  const capsule = readApiWorkerMigrationCapsule(await ops.preparation());
  if (!capsule.operationBytes.equals(operationBytes)) stop('REQUEST_DRIFT');
  plan = capsule.plan;
  planBytes = capsule.planBytes;
  validateMigrationPlan(plan, operationBytes);
  await ops.loadPlan(plan, planBytes, operationSha);
  current = await ops.receipt();
  if (current) validateMigrationReceipt(current, hash(planBytes), operationSha);
  else current = initialReceipt('PREPARING');
  await ops.assertSource(op);
  await ops.assertOwned();
  if (!same(await ops.snapshot(), plan.runtime) || !same(await ops.secrets(), plan.secretSet))
    stop('RUNTIME_DRIFT');
  const row = await ops.lookup('migration', plan.imageId, operationSha);
  if (current.containerId && row?.Id !== current.containerId) stop('CONTAINER_DRIFT');
  const terminal = current.status === 'RECONCILED' ? current.reconciledStatus : current.status;
  if (terminal === 'SUCCESS') {
    if (!row || row.State.Status !== 'exited' || row.State.ExitCode !== 0) stop('RECONCILE');
    const proof = await ops.successProof();
    if (!proof || hash(proof) !== current.successSha256) stop('SUCCESS_DRIFT');
    await success(row, current.status !== 'RECONCILED');
  } else if (['START_INTENT', 'STARTED'].includes(current.status)) {
    if (!row || row.State.Status !== 'exited' || row.State.ExitCode !== 0)
      stop('RECONCILE_OWNER_DECISION');
    await success(row);
  } else {
    await attest(PRE_LEDGER);
    if (
      row &&
      (row.State.Status !== 'created' ||
        !['CREATE_INTENT', 'CREATED', 'ABORTED', 'RECONCILED'].includes(current.status))
    )
      stop('RECONCILE_OWNER_DECISION');
    if (['CREATED'].includes(current.status) && !row) stop('CONTAINER_DRIFT');
    await ops.attestStoppedProbes();
    await journal('ABORTED', { containerId: row?.Id ?? null, successSha256: null });
  }
  if (current.status !== 'RECONCILED')
    await journal('RECONCILED', {
      reconciledStatus: current.status,
      containerId: current.containerId,
      successSha256: current.successSha256,
    });
  await ops.release();
  return { status: 'RECONCILED', receipt: ops.receiptPath };
}

export function validateMigrationReleaseState(active, provision) {
  if (!active && provision) stop('LOCK_RELEASE_ORDER');
}
function syncParent(path) {
  const fd = openSync(dirname(path), 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
const present = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
};
function docker(args, timeout = 120000) {
  try {
    return execFileSync('/usr/bin/docker', args, {
      cwd: SOURCE,
      encoding: 'utf8',
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        DOCKER_HOST: 'unix:///var/run/docker.sock',
        DOCKER_CONFIG: '/proc/self/phub-nonexistent-docker-config',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    stop('DOCKER_UNKNOWN');
  }
}
function git(args) {
  try {
    return execFileSync(
      '/usr/bin/git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      {
        cwd: SOURCE,
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: '/root',
          LANG: 'C',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_NO_LAZY_FETCH: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  } catch {
    stop('GIT');
  }
}
function inspect(id) {
  const rows = parseStrictJson(docker(['container', 'inspect', id]));
  if (!Array.isArray(rows) || rows.length !== 1) stop('INSPECT');
  return rows[0];
}
function ids(args) {
  const values = docker(['ps', '-aq', '--no-trunc', ...args])
    .trim()
    .split('\n')
    .filter(Boolean);
  if (values.some((v) => !HASH.test(v)) || new Set(values).size !== values.length) stop('IDS');
  return values;
}
function identity(v) {
  return {
    id: v.Id,
    image: v.Config.Image,
    imageId: v.Image,
    releaseId: v.Config.Labels?.['phub.release-id'] ?? null,
    revision: v.Config.Labels?.['org.opencontainers.image.revision'] ?? null,
    restarts: v.RestartCount,
    startedAt: v.State.StartedAt,
  };
}
function snapshotRow(v) {
  return {
    identity: identity(v),
    status: v.State.Status,
    health: v.State.Health?.Status ?? null,
    fingerprint: hash(
      canonical({
        config: v.Config,
        host: v.HostConfig,
        mounts: v.Mounts,
        network: v.NetworkSettings,
      }),
    ),
  };
}
function sourceAttest(op) {
  if (!secure(SOURCE, 0o700).isDirectory() || !secure(`${SOURCE}/.git`).isDirectory())
    stop('SOURCE_DIRECTORY');
  if (
    git(['rev-parse', '--show-toplevel']) !== SOURCE ||
    git(['rev-parse', '--absolute-git-dir']) !== `${SOURCE}/.git`
  )
    stop('SOURCE_DIRECTORY');
  const config = parseStrictJson(read('/etc/phub/timeweb-beta-standard-delivery.json'));
  exact(config, ['schema', 'enabled', 'owner', 'controllerSha']);
  if (
    config.schema !== 1 ||
    config.enabled !== true ||
    typeof config.owner !== 'string' ||
    !config.owner.trim() ||
    config.controllerSha !== op.controllerSha ||
    present(`${SOURCE}/.git/objects/info/alternates`) ||
    present(`${SOURCE}/.git/shallow`) ||
    git(['config', '--local', '--list'])
      .split('\n')
      .some((line) =>
        /^(?:remote\..*\.(?:promisor|partialclonefilter)|extensions\.partialclone|include(?:if\..*)?\.path)=/i.test(
          line,
        ),
      )
  )
    stop('ENROLLMENT');
  if (
    git(['rev-parse', 'HEAD']) !== op.controllerSha ||
    git(['rev-parse', 'HEAD^{tree}']) !== op.controllerTree ||
    git(['status', '--porcelain', '--untracked-files=all'])
  )
    stop('CONTROLLER');
  if (git(['rev-parse', `${BASE_SHA}^{tree}`]) !== BASE_TREE) stop('CONTROLLER_BASE');
  git(['merge-base', '--is-ancestor', BASE_SHA, op.controllerSha]);
  git(['merge-base', '--is-ancestor', op.candidateSha, op.controllerSha]);
  validateMigrationControllerClosure(
    parseApiWorkerControllerDiff(
      git(['diff', '--no-renames', '--raw', '--abbrev=40', '-z', BASE_SHA, op.controllerSha]),
    ),
  );
  validateApiWorkerControllerDelta(
    parseApiWorkerControllerDiff(
      git([
        'diff',
        '--no-renames',
        '--raw',
        '--abbrev=40',
        '-z',
        op.candidateSha,
        op.controllerSha,
      ]),
    ),
  );
  for (const item of git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
    const m = /^(100644|100755) [a-f0-9]{40} 0\t(.+)$/.exec(item);
    if (!m) stop('SOURCE_FILE');
    secure(`${SOURCE}/${m[2]}`, m[1] === '100644' ? 0o644 : 0o755);
  }
}
function envValues(kind, imageEnv) {
  const values = Object.fromEntries(
    imageEnv.map((v) => {
      const i = v.indexOf('=');
      return [v.slice(0, i), v.slice(i + 1)];
    }),
  );
  const path = `${RUNTIME}/${kind === 'runtime' ? 'api' : 'migrator'}.env`;
  const seen = new Set();
  for (const line of read(path).toString().trimEnd().split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (
      !m ||
      seen.has(m[1]) ||
      ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV'].includes(
        m[1],
      )
    )
      stop('ENV');
    seen.add(m[1]);
    values[m[1]] = m[2];
  }
  return Object.entries(values).map(([key, value]) => `${key}=${value}`);
}
const DISK_BACKUP_REQUEST = `${ROOT}/operator/database-backup-restore.json`;
const DISK_POST_SCHEMA = 'PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_DISK_V1';
const DISK_EXCLUSION_SCHEMA = 'PHUB_TIMEWEB_DISK_RESTORE_EXCLUSION_V1';
const NS_POST_SCHEMA = 'PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_DISK_NAMESPACE_V2';
const NS_EXCLUSION_SCHEMA = 'PHUB_TIMEWEB_DISK_RESTORE_EXCLUSION_V2';
const diskHostKeys = [
  'NetworkMode',
  'ReadonlyRootfs',
  'Binds',
  'PortBindings',
  'Tmpfs',
  'Privileged',
  'AutoRemove',
  'RestartPolicy',
  'CapAdd',
  'CapDrop',
  'SecurityOpt',
  'PidsLimit',
  'Memory',
  'MemorySwap',
  'NanoCpus',
  'PublishAllPorts',
  'Links',
  'Devices',
  'DeviceRequests',
  'VolumesFrom',
  'PidMode',
  'IpcMode',
  'LogConfig',
];

export function parseDiskRestoreMountinfo(raw) {
  if (typeof raw !== 'string' || raw.length > 4 * 1024 * 1024) stop('DISK_MOUNTINFO');
  const decode = (v) => {
    if (/\\(?![0-7]{3})/.test(v)) stop('DISK_MOUNTINFO_ESCAPE');
    return v.replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(Number.parseInt(code, 8)));
  };
  return raw
    .trim()
    .split('\n')
    .map((line) => {
      const parts = line.split(' - '),
        left = parts[0].split(/\s+/),
        right = parts[1]?.split(/\s+/);
      if (
        parts.length !== 2 ||
        left.length < 6 ||
        right?.length !== 3 ||
        !/^[0-9]+:[0-9]+$/.test(left[2])
      )
        stop('DISK_MOUNTINFO');
      return {
        id: left[0],
        parent: left[1],
        device: left[2],
        root: decode(left[3]),
        target: decode(left[4]),
        options: left[5].split(','),
        optional: left.slice(6),
        fstype: right[0],
        source: decode(right[1]),
        superOptions: right[2].split(','),
      };
    });
}

function diskUuid(name) {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const bytes = createHash('sha1').update(namespace).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const v = bytes.toString('hex');
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20)}`;
}

export function validateMigrationBackupRestoreReference(operationBytes, expected, reference) {
  const op = parseStrictJson(operationBytes);
  if (op.schema === NS_POST_SCHEMA) {
    exact(reference, ['schema', 'storageProofSha256']);
    if (reference.schema !== NS_EXCLUSION_SCHEMA || !HASH.test(reference.storageProofSha256 ?? ''))
      stop('NS_REFERENCE_DOWNGRADE');
    return 'namespace';
  }
  if (op.schema === DISK_POST_SCHEMA) {
    exact(reference, ['schema', 'storageProofSha256']);
    if (
      reference.schema !== DISK_EXCLUSION_SCHEMA ||
      !HASH.test(reference.storageProofSha256 ?? '')
    )
      stop('DISK_REFERENCE_DOWNGRADE');
    return 'disk';
  }
  exact(reference, ['id', 'operationSha256']);
  if (
    op.schema !== 'PHUB_TIMEWEB_BACKUP_OPERATION_API_WORKER_V2' ||
    !HASH.test(reference.id ?? '') ||
    reference.operationSha256 !== hash(operationBytes) ||
    !same(Object.fromEntries(Object.keys(expected).map((k) => [k, op[k]])), expected) ||
    op.expectedLedgerSha256 !== POST_LEDGER ||
    op.toolCommit !== op.controllerSha ||
    op.confirmation !== 'BACKUP_RESTORE_API_WORKER_11954FFD6D7B_KEEP_API_0D6078BE7A50'
  )
    stop('BACKUP_REFERENCE');
  return 'legacy';
}

export function validateLegacyBackupRestoreMounts(row) {
  const targets = ['/var/lib/postgresql/data', '/var/run/postgresql', '/tmp'];
  if (
    !Array.isArray(row.Mounts) ||
    row.Mounts.some(
      (v) => v.Type !== 'tmpfs' || v.RW !== true || !targets.includes(v.Destination),
    ) ||
    new Set(row.Mounts.map((v) => v.Destination)).size !== row.Mounts.length ||
    !((row.State.Status === 'created' && row.Mounts.length === 0) || row.Mounts.length === 3)
  )
    stop('BACKUP_RESTORE_MOUNTS');
}

export function validateDiskRestoreReadback(value, expected, reference, operationBytes) {
  if (parseStrictJson(operationBytes).schema === NS_POST_SCHEMA)
    return validateNamespaceRestoreReadback(value, expected, reference, operationBytes);
  exact(reference, ['schema', 'storageProofSha256']);
  if (reference.schema !== DISK_EXCLUSION_SCHEMA || !HASH.test(reference.storageProofSha256 ?? ''))
    stop('DISK_REFERENCE');
  exact(value, [
    'schema',
    'operationSha256',
    'storageProofSha256',
    'plan',
    'readback',
    'migration',
  ]);
  const op = parseStrictJson(operationBytes);
  exact(op, [
    'schema',
    'target',
    'toolCommit',
    'toolFileSha256',
    'controllerSha',
    'toolProofSha256',
    'toolInstallationSha256',
    'controllerTree',
    'controllerConfigSha256',
    'expectedBoundarySha256',
    'expectedApi',
    'expectedPostgres',
    'expiresAt',
    'confirmation',
    'candidateReleaseId',
    'expectedLedgerSha256',
    'controllerSourceCiRunId',
    'migrationPlanSha256',
    'migrationSuccessSha256',
  ]);
  const sha = hash(operationBytes),
    work = `${ROOT}/backups/.disk-restore-${sha}`;
  if (
    op.schema !== DISK_POST_SCHEMA ||
    value.schema !== 'PHUB_TIMEWEB_DISK_RESTORE_READBACK_V1' ||
    value.operationSha256 !== sha ||
    value.storageProofSha256 !== reference.storageProofSha256 ||
    !same(value.migration, expected) ||
    !same(value.migration, Object.fromEntries(Object.keys(expected).map((k) => [k, op[k]]))) ||
    op.toolCommit !== op.controllerSha ||
    op.expectedLedgerSha256 !== POST_LEDGER ||
    op.confirmation !== 'BACKUP_RESTORE_API_WORKER_DISK_LUKS2_11954FFD6D7B_KEEP_API_0D6078BE7A50' ||
    !same(op.target, { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 })
  )
    stop('DISK_OPERATION');
  const p = value.plan;
  exact(p, [
    'schema',
    'operationSha256',
    'work',
    'canonical',
    'pendingLock',
    'image',
    'mount',
    'publication',
    'mapperName',
    'mapperPath',
    'luksUuid',
    'filesystemUuid',
    'mountOptions',
    'containerName',
    'restoreImage',
    'expectedLedgerSha256',
    'databaseBytes',
    'restoreDataBytes',
    'imageBytes',
    'memoryBytes',
    'dumpLimitBytes',
    'diskReserveBytes',
  ]);
  if (
    p.schema !== 'PHUB_TIMEWEB_DISK_RESTORE_PLAN_V1' ||
    p.operationSha256 !== sha ||
    p.work !== work ||
    p.canonical !== `${ROOT}/backups/${expected.candidateReleaseId}-api-worker` ||
    p.pendingLock !== `${ROOT}/standard/.disk-lock-${sha}` ||
    p.image !== `${work}/restore.luks` ||
    p.mount !== `${work}/pgdata-mounted` ||
    p.publication !== `${work}/publication` ||
    p.mapperName !== `phub-restore-${sha.slice(0, 24)}` ||
    p.mapperPath !== `/dev/mapper/${p.mapperName}` ||
    p.containerName !==
      `phub-timeweb-restore-${bridge.candidateSha.slice(0, 12)}-${bridge.publicationRunId}-1` ||
    p.restoreImage !== bridge.postgresImage ||
    p.expectedLedgerSha256 !== POST_LEDGER ||
    p.mountOptions !== 'rw,nosuid,nodev,noexec,noatime' ||
    p.memoryBytes !== 2 * 1024 ** 3 ||
    !Number.isSafeInteger(p.databaseBytes) ||
    p.databaseBytes <= 0 ||
    p.databaseBytes > 64 * 1024 ** 3
  )
    stop('DISK_PLAN');
  const data = Math.max(512 * 1024 ** 2, p.databaseBytes * 3 + 256 * 1024 ** 2);
  const image =
    Math.ceil((data + Math.max(512 * 1024 ** 2, Math.ceil(data / 20))) / (4 * 1024 ** 2)) *
    4 *
    1024 ** 2;
  if (
    p.restoreDataBytes !== data ||
    p.imageBytes !== image ||
    p.diskReserveBytes !== 5 * 1024 ** 3 ||
    p.dumpLimitBytes !== Math.min(64 * 1024 ** 3, p.databaseBytes * 2 + 256 * 1024 ** 2) ||
    p.luksUuid !== diskUuid(`phub-luks-${sha}`) ||
    p.filesystemUuid !== diskUuid(`phub-ext4-${sha}`)
  )
    stop('DISK_CAPACITY_PLAN');
  exact(value.readback, ['storage', 'kernel', 'container']);
  const c = value.readback.container;
  exact(c, ['Id', 'Config', 'HostConfig', 'Mounts', 'State']);
  exact(c.Config, ['Image', 'User', 'Volumes', 'Labels', 'Env', 'Cmd', 'Entrypoint']);
  exact(c.HostConfig, diskHostKeys);
  exact(c.State, ['Status', 'Pid', 'StartedAt']);
  const h = c.HostConfig,
    empty = (v) => v == null || (typeof v === 'object' && Object.keys(v).length === 0);
  const tmpfs = {
    '/var/run/postgresql': 'rw,nosuid,nodev,noexec,mode=1777,size=16777216',
    '/tmp': 'rw,nosuid,nodev,noexec,mode=1777,size=16777216',
  };
  if (
    !same(h.LogConfig, { Type: 'none', Config: {} }) ||
    h.NetworkMode !== 'none' ||
    h.ReadonlyRootfs !== true ||
    h.Privileged !== false ||
    h.AutoRemove !== false ||
    !same(h.RestartPolicy, { Name: 'no', MaximumRetryCount: 0 }) ||
    !same(h.CapDrop, ['ALL']) ||
    !empty(h.CapAdd) ||
    ![canonical(['no-new-privileges']), canonical(['no-new-privileges:true'])].includes(
      canonical(h.SecurityOpt),
    ) ||
    h.PidsLimit !== 128 ||
    h.Memory !== 2 * 1024 ** 3 ||
    h.MemorySwap !== h.Memory ||
    h.NanoCpus !== 1000000000 ||
    h.PublishAllPorts !== false ||
    h.PidMode !== '' ||
    h.IpcMode !== 'private' ||
    ['Binds', 'PortBindings', 'Links', 'Devices', 'DeviceRequests', 'VolumesFrom'].some(
      (k) => !empty(h[k]),
    ) ||
    !same(h.Tmpfs, tmpfs) ||
    (!empty(c.Config.Volumes) && !same(c.Config.Volumes, { '/var/lib/postgresql/data': {} })) ||
    !Array.isArray(c.Mounts) ||
    c.Mounts.length !== 3 ||
    new Set(c.Mounts.map((v) => v.Destination)).size !== 3
  )
    stop('DISK_CONTAINMENT');
  const bind = c.Mounts.filter((v) => v.Type === 'bind'),
    temps = c.Mounts.filter((v) => v.Type === 'tmpfs');
  if (
    bind.length !== 1 ||
    bind[0].Source !== p.mount ||
    bind[0].Destination !== '/var/lib/postgresql/data' ||
    bind[0].RW !== true ||
    bind[0].Propagation !== 'rprivate' ||
    temps.length !== 2 ||
    !same(temps.map((v) => v.Destination).sort(), Object.keys(tmpfs).sort()) ||
    temps.some((v) => v.RW !== true)
  )
    stop('DISK_CONTAINMENT_MOUNTS');
  if (
    !Array.isArray(c.Config.Env) ||
    c.Config.Env.some((v) => typeof v !== 'string' || !v.includes('=')) ||
    new Set(c.Config.Env.map((v) => v.slice(0, v.indexOf('=')))).size !== c.Config.Env.length ||
    ![
      'PGDATA=/var/lib/postgresql/data/phub-restore',
      'POSTGRES_USER=phub_restore',
      'POSTGRES_DB=phub_restore',
      'POSTGRES_HOST_AUTH_METHOD=trust',
    ].every((v) => c.Config.Env.includes(v)) ||
    !same(c.Config.Cmd, ['postgres']) ||
    !same(c.Config.Entrypoint, ['docker-entrypoint.sh']) ||
    !same(c.Config.Labels, { 'phub.backup-operation': sha })
  )
    stop('DISK_CONFIG');
  validateDiskStorageKernel(value.readback, p);
  if (
    !HASH.test(c?.Id ?? '') ||
    c.Config?.Image !== bridge.postgresImage ||
    c.Config?.User !== 'postgres' ||
    c.Config.Labels?.['phub.backup-operation'] !== sha ||
    c.State?.Status !== 'running' ||
    !Number.isSafeInteger(c.State?.Pid) ||
    c.State.Pid < 1 ||
    value.readback.kernel?.pid !== c.State.Pid ||
    value.readback.kernel?.startedAt !== c.State.StartedAt
  )
    stop('DISK_CONTAINER');
  return { ...value, requestSha256: sha, id: c.Id };
}

function validateDiskStorageIdentity(s, plan, mountMode) {
  exact(s, ['image', 'loop', 'mapper', 'mount']);
  exact(s.image, ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink']);
  exact(s.mapper, ['device', 'minor', 'uuid']);
  exact(s.mount, ['dev', 'ino', 'uid', 'gid', 'mode']);
  const integer = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
  if (
    !integer(s.image.dev) ||
    !integer(s.image.ino, 1) ||
    s.image.uid !== 0 ||
    s.image.gid !== 0 ||
    s.image.mode !== 0o100600 ||
    s.image.nlink !== 1 ||
    !/^\/dev\/loop[0-9]+$/.test(s.loop ?? '') ||
    !integer(s.mapper.device) ||
    !integer(s.mapper.minor) ||
    s.mapper.uuid !== `CRYPT-LUKS2-${plan.luksUuid.replaceAll('-', '')}-${plan.mapperName}` ||
    !integer(s.mount.dev) ||
    !integer(s.mount.ino, 1) ||
    s.mount.uid !== 0 ||
    s.mount.gid !== 0 ||
    s.mount.mode !== mountMode
  )
    stop('DISK_STORAGE');
  const major = BigInt(s.mapper.device),
    minor = BigInt(s.mapper.minor);
  const dev =
    (minor & 255n) | ((major & 4095n) << 8n) | ((minor & ~255n) << 12n) | ((major & ~4095n) << 32n);
  if (BigInt(s.mount.dev) !== dev) stop('DISK_STORAGE_DEVICE');
}

function validateDiskStorageKernel(readback, plan) {
  const s = readback.storage,
    k = readback.kernel;
  validateDiskStorageIdentity(s, plan, 0o41777);
  const integer = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
  exact(k, [
    'hostNamespace',
    'containerNamespace',
    'pid',
    'startedAt',
    'hostMount',
    'containerMount',
  ]);
  if (
    !integer(k.hostNamespace, 1) ||
    !integer(k.containerNamespace, 1) ||
    !integer(k.pid, 1) ||
    k.pid > 2 ** 31 - 1 ||
    typeof k.startedAt !== 'string'
  )
    stop('DISK_KERNEL_FIELDS');
  for (const [record, target] of [
    [k.hostMount, plan.mount],
    [k.containerMount, '/var/lib/postgresql/data'],
  ]) {
    exact(record, [
      'id',
      'parent',
      'device',
      'root',
      'target',
      'options',
      'optional',
      'fstype',
      'source',
      'superOptions',
    ]);
    if (
      !/^[0-9]+$/.test(record.id ?? '') ||
      !/^[0-9]+$/.test(record.parent ?? '') ||
      record.device !== `${s.mapper.device}:${s.mapper.minor}` ||
      record.target !== target ||
      record.root !== '/' ||
      record.fstype !== 'ext4' ||
      record.source !== plan.mapperPath ||
      !Array.isArray(record.options) ||
      !Array.isArray(record.optional) ||
      record.optional.length ||
      !Array.isArray(record.superOptions) ||
      [...record.options, ...record.superOptions].some((v) => typeof v !== 'string') ||
      new Set(record.options).size !== record.options.length ||
      ['rw', 'nosuid', 'nodev', 'noexec'].some((v) => !record.options.includes(v)) ||
      record.options.includes('ro')
    )
      stop('DISK_KERNEL_FIELDS');
  }
}

export function validateDiskRestoreToolBytes(installedBytes, sourceBytes, expectedSha256) {
  if (
    !Buffer.isBuffer(installedBytes) ||
    !Buffer.isBuffer(sourceBytes) ||
    !HASH.test(expectedSha256 ?? '') ||
    !installedBytes.equals(sourceBytes) ||
    hash(sourceBytes) !== expectedSha256
  )
    stop('DISK_TOOL_SOURCE');
}

export function validateDiskRestoreKernelSnapshot(row, attestation, actual) {
  const expected = attestation.readback,
    p = attestation.plan;
  validateDiskStorageKernel(expected, p);
  const projection = {
    Id: row.Id,
    Config: Object.fromEntries(
      ['Image', 'User', 'Volumes', 'Labels', 'Env', 'Cmd', 'Entrypoint'].map((k) => [
        k,
        row.Config[k] ?? null,
      ]),
    ),
    HostConfig: Object.fromEntries(diskHostKeys.map((k) => [k, row.HostConfig[k] ?? null])),
    Mounts: row.Mounts,
    State: Object.fromEntries(['Status', 'Pid', 'StartedAt'].map((k) => [k, row.State[k]])),
  };
  if (
    row.Name !== `/${p.containerName}` ||
    !same(projection, expected.container) ||
    row.State.Status !== 'running' ||
    actual.hostNamespace !== expected.kernel.hostNamespace ||
    actual.containerNamespace !== expected.kernel.containerNamespace
  )
    stop('DISK_KERNEL_CONTAINER');
  const check = (raw, target, record) => {
    const entries = parseDiskRestoreMountinfo(raw),
      rows = entries.filter((v) => v.target === target);
    if (
      rows.length !== 1 ||
      !same(rows[0], record) ||
      rows[0].optional.length ||
      rows[0].root !== '/' ||
      rows[0].fstype !== 'ext4' ||
      ['rw', 'nosuid', 'nodev', 'noexec'].some((v) => !rows[0].options.includes(v)) ||
      rows[0].options.includes('ro') ||
      entries.some((v) => v.target.startsWith(`${target}/`))
    )
      stop('DISK_KERNEL_MOUNT');
  };
  check(actual.hostMountinfo, p.mount, expected.kernel.hostMount);
  check(actual.containerMountinfo, '/var/lib/postgresql/data', expected.kernel.containerMount);
  if (
    actual.afterHostNamespace !== actual.hostNamespace ||
    actual.afterContainerNamespace !== actual.containerNamespace
  )
    stop('DISK_NAMESPACE_DRIFT');
}

function validateNamespaceContainer(c, p, sha) {
  exact(c, ['Id', 'Config', 'HostConfig', 'Mounts', 'State', 'Image']);
  exact(c.Config, ['Image', 'User', 'Volumes', 'Labels', 'Env', 'Cmd', 'Entrypoint']);
  exact(c.HostConfig, [...diskHostKeys, 'CgroupParent', 'CgroupnsMode']);
  exact(c.State, ['Status', 'Pid', 'StartedAt']);
  const h = c.HostConfig,
    empty = (v) => v == null || (typeof v === 'object' && Object.keys(v).length === 0);
  const tmpfs = {
    '/var/run/postgresql': 'rw,nosuid,nodev,noexec,mode=1777,size=16777216',
    '/tmp': 'rw,nosuid,nodev,noexec,mode=1777,size=16777216',
  };
  if (
    !same(h.LogConfig, { Type: 'none', Config: {} }) ||
    h.NetworkMode !== 'none' ||
    h.ReadonlyRootfs !== true ||
    h.Privileged !== false ||
    h.AutoRemove !== false ||
    !same(h.RestartPolicy, { Name: 'no', MaximumRetryCount: 0 }) ||
    !same(h.CapDrop, ['ALL']) ||
    !empty(h.CapAdd) ||
    ![canonical(['no-new-privileges']), canonical(['no-new-privileges:true'])].includes(
      canonical(h.SecurityOpt),
    ) ||
    h.PidsLimit !== 128 ||
    h.Memory !== 2 * 1024 ** 3 ||
    h.MemorySwap !== h.Memory ||
    h.NanoCpus !== 1000000000 ||
    h.PublishAllPorts !== false ||
    h.PidMode !== '' ||
    h.IpcMode !== 'private' ||
    ['Binds', 'PortBindings', 'Links', 'Devices', 'DeviceRequests', 'VolumesFrom'].some(
      (k) => !empty(h[k]),
    ) ||
    !same(h.Tmpfs, tmpfs) ||
    (!empty(c.Config.Volumes) && !same(c.Config.Volumes, { '/var/lib/postgresql/data': {} })) ||
    !Array.isArray(c.Mounts) ||
    c.Mounts.length !== 3 ||
    new Set(c.Mounts.map((v) => v.Destination)).size !== 3
  )
    stop('DISK_CONTAINMENT');
  const bind = c.Mounts.filter((v) => v.Type === 'bind'),
    temps = c.Mounts.filter((v) => v.Type === 'tmpfs');
  if (
    bind.length !== 1 ||
    bind[0].Source !== p.isolation.pgdata ||
    bind[0].Destination !== '/var/lib/postgresql/data' ||
    bind[0].RW !== true ||
    bind[0].Propagation !== 'rprivate' ||
    temps.length !== 2 ||
    !same(temps.map((v) => v.Destination).sort(), Object.keys(tmpfs).sort()) ||
    temps.some((v) => v.RW !== true)
  )
    stop('DISK_CONTAINMENT_MOUNTS');
  if (
    !Array.isArray(c.Config.Env) ||
    c.Config.Env.some((v) => typeof v !== 'string' || !v.includes('=')) ||
    new Set(c.Config.Env.map((v) => v.slice(0, v.indexOf('=')))).size !== c.Config.Env.length ||
    ![
      'PGDATA=/var/lib/postgresql/data/phub-restore',
      'POSTGRES_USER=phub_restore',
      'POSTGRES_DB=phub_restore',
      'POSTGRES_HOST_AUTH_METHOD=trust',
    ].every((v) => c.Config.Env.includes(v)) ||
    !same(c.Config.Cmd, ['postgres']) ||
    !same(c.Config.Entrypoint, ['docker-entrypoint.sh']) ||
    !same(c.Config.Labels, { 'phub.backup-operation': sha })
  )
    stop('DISK_CONFIG');

  const env = Object.fromEntries(
    p.isolation.image.Env.map((v) => [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)]),
  );
  Object.assign(env, {
    PGDATA: '/var/lib/postgresql/data/phub-restore',
    POSTGRES_USER: 'phub_restore',
    POSTGRES_DB: 'phub_restore',
    POSTGRES_HOST_AUTH_METHOD: 'trust',
  });
  if (
    !HASH.test(c.Id ?? '') ||
    c.Image !== p.isolation.image.Id ||
    c.Config.Image !== c.Image ||
    c.Config.User !== 'postgres' ||
    c.State.Status !== 'running' ||
    !Number.isSafeInteger(c.State.Pid) ||
    c.State.Pid < 1 ||
    typeof c.State.StartedAt !== 'string' ||
    c.HostConfig.CgroupParent !== p.isolation.slice ||
    c.HostConfig.CgroupnsMode !== 'private' ||
    !same(
      [...c.Config.Env].sort(),
      Object.entries(env)
        .map(([k, v]) => `${k}=${v}`)
        .sort(),
    )
  )
    stop('NS_CONTAINER');
}

function namespaceImage(v, source = null) {
  exact(v, ['Id', 'Os', 'Architecture', 'RepoDigests', 'Size', 'RootFS', 'Env']);
  exact(v.RootFS, ['Type', 'Layers']);
  if (
    !/^sha256:[a-f0-9]{64}$/.test(v.Id ?? '') ||
    v.Os !== 'linux' ||
    v.Architecture !== 'amd64' ||
    !Number.isSafeInteger(v.Size) ||
    v.Size <= 0 ||
    v.Size > 2 * 1024 ** 3 ||
    v.RootFS.Type !== 'layers' ||
    !Array.isArray(v.RootFS.Layers) ||
    !v.RootFS.Layers.length ||
    v.RootFS.Layers.length > 128 ||
    v.RootFS.Layers.some((x) => !/^sha256:[a-f0-9]{64}$/.test(x)) ||
    !Array.isArray(v.Env) ||
    v.Env.length > 256 ||
    v.Env.some((x) => typeof x !== 'string' || !x.includes('=')) ||
    new Set(v.Env.map((x) => x.split('=')[0])).size !== v.Env.length
  )
    stop('NS_IMAGE');
  if (source) {
    if (['Id', 'Os', 'Architecture', 'Size', 'RootFS', 'Env'].some((k) => !same(v[k], source[k])))
      stop('NS_IMAGE_IMPORT');
  } else if (
    !Array.isArray(v.RepoDigests) ||
    !v.RepoDigests.some((x) =>
      [bridge.postgresImage, bridge.postgresImage.replace('docker.io/library/', '')].includes(x),
    )
  )
    stop('NS_IMAGE_SOURCE');
}

function namespaceProcess(v, executable, root = true) {
  exact(v, [
    'pid',
    'startTicks',
    'executable',
    'cmdline',
    'mountNamespace',
    'uid',
    'gid',
    'cgroup',
  ]);
  if (
    !Number.isSafeInteger(v.pid) ||
    v.pid < 1 ||
    v.pid >= 2 ** 31 ||
    !/^[0-9]+$/.test(v.startTicks ?? '') ||
    v.executable !== executable ||
    !Number.isSafeInteger(v.mountNamespace) ||
    v.mountNamespace < 1 ||
    !Array.isArray(v.cmdline) ||
    !v.cmdline.length ||
    v.cmdline.some((x) => typeof x !== 'string' || x.includes('\0')) ||
    !Array.isArray(v.uid) ||
    v.uid.length !== 4 ||
    !Array.isArray(v.gid) ||
    v.gid.length !== 4 ||
    [...v.uid, ...v.gid].some((x) => !Number.isSafeInteger(x) || x < 0) ||
    (root
      ? [...v.uid, ...v.gid].some((x) => x !== 0)
      : [...v.uid, ...v.gid].some((x) => x === 0)) ||
    typeof v.cgroup !== 'string' ||
    !v.cgroup.startsWith('0::/')
  )
    stop('NS_PROCESS');
}

function namespaceMount(record, target, root, plan, mapper) {
  exact(record, [
    'id',
    'parent',
    'device',
    'root',
    'target',
    'options',
    'optional',
    'fstype',
    'source',
    'superOptions',
  ]);
  if (
    !/^[0-9]+$/.test(record.id ?? '') ||
    !/^[0-9]+$/.test(record.parent ?? '') ||
    record.target !== target ||
    record.root !== root ||
    record.device !== `${mapper.device}:${mapper.minor}` ||
    record.fstype !== 'ext4' ||
    record.source !== plan.mapperPath ||
    !Array.isArray(record.options) ||
    !Array.isArray(record.optional) ||
    record.optional.length ||
    !Array.isArray(record.superOptions) ||
    [...record.options, ...record.superOptions].some((x) => typeof x !== 'string') ||
    new Set(record.options).size !== record.options.length ||
    ['rw', 'nosuid', 'nodev', 'noexec'].some((x) => !record.options.includes(x)) ||
    record.options.includes('ro')
  )
    stop('NS_MOUNT');
}

const NS_UNIT_KEYS = [
  'LoadState',
  'ActiveState',
  'SubState',
  'MainPID',
  'InvocationID',
  'ControlGroup',
  'MemoryMax',
  'MemorySwapMax',
  'TasksMax',
  'Delegate',
  'CPUQuotaPerSecUSec',
  'KillMode',
  'SendSIGKILL',
  'Restart',
  'TimeoutStopUSec',
  'LimitCORE',
  'UMask',
  'User',
  'Group',
  'WorkingDirectory',
  'StandardInput',
  'StandardOutput',
  'StandardError',
  'Slice',
  'Transient',
  'NRestarts',
  'Result',
  'ExecMainCode',
  'ExecMainStatus',
  'PrivateNetwork',
];
const NS_SLICE_KEYS = [
  'LoadState',
  'ActiveState',
  'ControlGroup',
  'Transient',
  'MemoryMax',
  'MemorySwapMax',
  'TasksMax',
  'CPUQuotaPerSecUSec',
];
function namespaceValidateBounds(b, group, memory, pids, cpus) {
  exact(b, ['identity', 'path', 'memory.max', 'memory.swap.max', 'pids.max', 'cpu.max']);
  exact(b.identity, ['dev', 'ino', 'uid', 'gid', 'mode']);
  const cpu = typeof b['cpu.max'] === 'string' ? b['cpu.max'].split(' ') : [];
  if (
    b.path !== `/sys/fs/cgroup${group}` ||
    b.identity.uid !== 0 ||
    b.identity.gid !== 0 ||
    b.identity.mode !== 0o40755 ||
    !Number.isSafeInteger(b.identity.dev) ||
    !Number.isSafeInteger(b.identity.ino) ||
    b.identity.ino < 1 ||
    b['memory.max'] !== String(memory) ||
    b['memory.swap.max'] !== '0' ||
    b['pids.max'] !== String(pids) ||
    cpu.length !== 2 ||
    !cpu.every((x) => /^[1-9][0-9]*$/.test(x)) ||
    Number(cpu[0]) !== cpus * Number(cpu[1])
  )
    stop('NS_BOUNDS');
}

function validateNamespaceRestoreReadback(value, expected, reference, operationBytes) {
  exact(reference, ['schema', 'storageProofSha256']);
  exact(value, [
    'schema',
    'operationSha256',
    'storageProofSha256',
    'plan',
    'readback',
    'migration',
  ]);
  const op = parseStrictJson(operationBytes),
    sha = hash(operationBytes);
  exact(op, [
    'schema',
    'target',
    'toolCommit',
    'toolFileSha256',
    'controllerSha',
    'toolProofSha256',
    'toolInstallationSha256',
    'controllerTree',
    'controllerConfigSha256',
    'expectedBoundarySha256',
    'expectedApi',
    'expectedPostgres',
    'expiresAt',
    'confirmation',
    'candidateReleaseId',
    'expectedLedgerSha256',
    'controllerSourceCiRunId',
    'migrationPlanSha256',
    'migrationSuccessSha256',
  ]);
  if (
    op.schema !== NS_POST_SCHEMA ||
    reference.schema !== NS_EXCLUSION_SCHEMA ||
    !HASH.test(reference.storageProofSha256 ?? '') ||
    value.schema !== 'PHUB_TIMEWEB_DISK_RESTORE_READBACK_V2' ||
    value.operationSha256 !== sha ||
    value.storageProofSha256 !== reference.storageProofSha256 ||
    !same(value.migration, expected) ||
    !same(value.migration, Object.fromEntries(Object.keys(expected).map((k) => [k, op[k]]))) ||
    op.toolCommit !== op.controllerSha ||
    op.expectedLedgerSha256 !== POST_LEDGER ||
    op.confirmation !==
      'BACKUP_RESTORE_API_WORKER_PRIVATE_NAMESPACE_ISOLATED_DOCKERD_11954FFD6D7B_KEEP_API_0D6078BE7A50' ||
    !same(op.target, { hostname: 'lk2.padlhub.su', serverId: 8886471, projectId: 262717 })
  )
    stop('NS_OPERATION');
  const p = value.plan,
    work = `${ROOT}/backups/.disk-restore-${sha}`;
  exact(p, [
    'schema',
    'operationSha256',
    'work',
    'canonical',
    'pendingLock',
    'image',
    'mount',
    'publication',
    'mapperName',
    'mapperPath',
    'luksUuid',
    'filesystemUuid',
    'mountOptions',
    'containerName',
    'restoreImage',
    'expectedLedgerSha256',
    'databaseBytes',
    'restoreDataBytes',
    'imageBytes',
    'memoryBytes',
    'dumpLimitBytes',
    'diskReserveBytes',
    'isolation',
  ]);
  const i = p.isolation;
  exact(i, [
    'strategy',
    'unit',
    'slice',
    'controlRoot',
    'pgdata',
    'dataRoot',
    'execRoot',
    'socket',
    'pidFile',
    'configFile',
    'image',
    'imageTransferLimitBytes',
    'daemonMemoryBytes',
    'daemonPids',
    'daemonNanoCpus',
  ]);
  namespaceImage(i.image);
  const data = Math.max(512 * 1024 ** 2, p.databaseBytes * 3 + 256 * 1024 ** 2),
    runtime = Math.max(512 * 1024 ** 2, i.image.Size * 3 + 256 * 1024 ** 2),
    total = data + runtime;
  const image =
    Math.ceil((total + Math.max(512 * 1024 ** 2, Math.ceil(total / 20))) / (4 * 1024 ** 2)) *
    4 *
    1024 ** 2;
  const derived = {
    strategy: 'SYSTEMD_SUPERVISOR_PRIVATE_ALIAS_V1',
    unit: `phub-disk-runtime-${sha.slice(0, 24)}.service`,
    slice: `phubdiskrestore${sha.slice(0, 24)}.slice`,
    controlRoot: `${work}/runtime-control`,
    pgdata: `${work}/pgdata-mounted/pgdata`,
    dataRoot: '/media/.runtime/docker-data',
    execRoot: '/media/.runtime/docker-exec',
    socket: '/media/.runtime/docker.sock',
    pidFile: '/media/.runtime/dockerd.pid',
    configFile: `${work}/runtime-control/daemon.json`,
    image: i.image,
    imageTransferLimitBytes: i.image.Size * 2 + 512 * 1024 ** 2,
    daemonMemoryBytes: 2 * 1024 ** 3,
    daemonPids: 256,
    daemonNanoCpus: 1000000000,
  };
  if (
    p.schema !== 'PHUB_TIMEWEB_DISK_RESTORE_PLAN_V2' ||
    p.operationSha256 !== sha ||
    p.work !== work ||
    p.canonical !== `${ROOT}/backups/${expected.candidateReleaseId}-api-worker` ||
    p.pendingLock !== `${ROOT}/standard/.disk-lock-${sha}` ||
    p.image !== `${work}/restore.luks` ||
    p.mount !== `${work}/pgdata-mounted` ||
    p.publication !== `${work}/publication` ||
    p.mapperName !== `phub-restore-${sha.slice(0, 24)}` ||
    p.mapperPath !== `/dev/mapper/${p.mapperName}` ||
    p.containerName !==
      `phub-timeweb-restore-${bridge.candidateSha.slice(0, 12)}-${bridge.publicationRunId}-1` ||
    p.restoreImage !== bridge.postgresImage ||
    p.expectedLedgerSha256 !== POST_LEDGER ||
    p.mountOptions !== 'rw,nosuid,nodev,noexec,noatime' ||
    p.memoryBytes !== 2 * 1024 ** 3 ||
    !Number.isSafeInteger(p.databaseBytes) ||
    p.databaseBytes <= 0 ||
    p.databaseBytes > 64 * 1024 ** 3 ||
    p.restoreDataBytes !== data ||
    p.imageBytes !== image ||
    p.diskReserveBytes !== 5 * 1024 ** 3 ||
    p.dumpLimitBytes !== Math.min(64 * 1024 ** 3, p.databaseBytes * 2 + 256 * 1024 ** 2) ||
    p.luksUuid !== diskUuid(`phub-luks-${sha}`) ||
    p.filesystemUuid !== diskUuid(`phub-ext4-${sha}`) ||
    !same(i, derived)
  )
    stop('NS_PLAN');
  const r = value.readback;
  exact(r, [
    'storage',
    'isolation',
    'kernel',
    'container',
    'image',
    'alias',
    'mask',
    'runtimeMounts',
  ]);
  exact(r.image, ['source', 'imported']);
  namespaceImage(r.image.source);
  namespaceImage(r.image.imported, r.image.source);
  if (!same(r.image.source, i.image)) stop('NS_IMAGE_PLAN');
  validateDiskStorageIdentity(r.storage, p, 0o40700);
  validateNamespaceAliasProof(r.alias, p, r.storage);
  validateNamespaceMaskProof(r.mask, p, r.storage);
  exact(r.isolation, ['admission', 'process', 'socket', 'info', 'managed']);
  const a = r.isolation.admission;
  exact(a, [
    'schema',
    'operationSha256',
    'toolFileSha256',
    'sourceDaemon',
    'supervisor',
    'network',
  ]);
  validateNamespaceNetworkProof(a.network);
  exact(a.supervisor, ['unit', 'process', 'bounds', 'slice']);
  const u = a.supervisor.unit,
    cg = a.supervisor.bounds,
    broker = a.supervisor.process,
    daemon = r.isolation.process,
    source = a.sourceDaemon;
  exact(u, NS_UNIT_KEYS);
  exact(cg, ['identity', 'path', 'memory.max', 'memory.swap.max', 'pids.max', 'cpu.max']);
  exact(cg.identity, ['dev', 'ino', 'uid', 'gid', 'mode']);
  namespaceProcess(broker, broker.executable);
  namespaceProcess(daemon, '/usr/bin/dockerd');
  namespaceProcess(source, '/usr/bin/dockerd');
  const cpu = cg['cpu.max'].split(' '),
    tool = `${ROOT}/operator/tools/${op.toolCommit}/control-timeweb-database-backup.py`;
  if (
    a.schema !== 'PHUB_TIMEWEB_PRIVATE_NAMESPACE_RECEIPT_V1' ||
    a.operationSha256 !== sha ||
    a.toolFileSha256 !== op.toolFileSha256 ||
    !/^\/usr\/bin\/python3(?:\.[0-9]+)?$/.test(broker.executable) ||
    !same(broker.cmdline, [
      '/usr/bin/python3',
      '-I',
      '-S',
      '-B',
      tool,
      '--disk-runtime-supervisor',
      DISK_BACKUP_REQUEST,
      sha,
    ]) ||
    !same(daemon.cmdline, ['/usr/bin/dockerd', '--config-file', i.configFile]) ||
    broker.cgroup !== `0::/${i.slice}/${i.unit}` ||
    daemon.cgroup !== broker.cgroup ||
    broker.mountNamespace !== daemon.mountNamespace ||
    source.mountNamespace === broker.mountNamespace ||
    u.LoadState !== 'loaded' ||
    u.ActiveState !== 'active' ||
    u.SubState !== 'running' ||
    u.MainPID !== String(broker.pid) ||
    !/^[a-f0-9]{32}$/.test(u.InvocationID ?? '') ||
    u.ControlGroup !== `/${i.slice}/${i.unit}` ||
    u.MemoryMax !== String(2 * 1024 ** 3) ||
    u.MemorySwapMax !== '0' ||
    u.TasksMax !== '256' ||
    u.Delegate !== 'yes' ||
    u.CPUQuotaPerSecUSec !== '1s' ||
    u.KillMode !== 'control-group' ||
    !Object.entries({
      SendSIGKILL: 'yes',
      Restart: 'no',
      TimeoutStopUSec: '30s',
      LimitCORE: '0',
      UMask: '0077',
      User: 'root',
      Group: 'root',
      WorkingDirectory: p.work,
      StandardInput: 'null',
      StandardOutput: 'null',
      StandardError: 'null',
      PrivateNetwork: 'yes',
      Slice: i.slice,
      Transient: 'yes',
      NRestarts: '0',
      Result: 'success',
      ExecMainCode: '0',
      ExecMainStatus: '0',
    }).every(([k, v]) => u[k] === v) ||
    cg.path !== `/sys/fs/cgroup${u.ControlGroup}` ||
    cg.identity.uid !== 0 ||
    cg.identity.gid !== 0 ||
    cg.identity.mode !== 0o40755 ||
    !Number.isSafeInteger(cg.identity.dev) ||
    !Number.isSafeInteger(cg.identity.ino) ||
    cg.identity.ino < 1 ||
    cg['memory.max'] !== u.MemoryMax ||
    cg['memory.swap.max'] !== '0' ||
    cg['pids.max'] !== '256' ||
    cpu.length !== 2 ||
    !cpu.every((x) => /^[1-9][0-9]*$/.test(x)) ||
    cpu[0] !== cpu[1]
  )
    stop('NS_ISOLATION');
  const sl = a.supervisor.slice;
  exact(sl, ['unit', 'bounds']);
  exact(sl.unit, NS_SLICE_KEYS);
  if (
    !same(sl.unit, {
      LoadState: 'loaded',
      ActiveState: 'active',
      ControlGroup: `/${i.slice}`,
      Transient: 'yes',
      MemoryMax: String(4 * 1024 ** 3),
      MemorySwapMax: '0',
      TasksMax: '384',
      CPUQuotaPerSecUSec: '2s',
    })
  )
    stop('NS_SLICE');
  namespaceValidateBounds(sl.bounds, sl.unit.ControlGroup, 4 * 1024 ** 3, 384, 2);
  const managed = r.isolation.managed;
  exact(managed, ['containerd', 'config', 'configSha256', 'shims']);
  exact(managed.config, ['version', 'root', 'state', 'address', 'disabledPlugins']);
  namespaceProcess(managed.containerd, '/usr/bin/containerd');
  const config = `${i.execRoot}/containerd/containerd.toml`;
  if (
    !same(managed.config, {
      version: 2,
      root: `${i.dataRoot}/containerd/daemon`,
      state: `${i.execRoot}/containerd/daemon`,
      address: `${i.execRoot}/containerd/containerd.sock`,
      disabledPlugins: ['io.containerd.grpc.v1.cri'],
    }) ||
    !HASH.test(managed.configSha256 ?? '') ||
    ![
      canonical(['containerd', '--config', config]),
      canonical(['containerd', '--config', config, '--log-level', 'info']),
    ].includes(canonical(managed.containerd.cmdline)) ||
    !Array.isArray(managed.shims) ||
    managed.shims.length !== 1
  )
    stop('NS_MANAGED');
  for (const child of [managed.containerd, ...managed.shims]) {
    namespaceProcess(child, child.executable);
    if (child.mountNamespace !== broker.mountNamespace || child.cgroup !== broker.cgroup)
      stop('NS_MANAGED_CUSTODY');
  }
  const shim = managed.shims[0];
  if (
    shim.executable !== '/usr/bin/containerd-shim-runc-v2' ||
    !same(shim.cmdline, [
      '/usr/bin/containerd-shim-runc-v2',
      '-namespace',
      `phub-${sha.slice(0, 24)}`,
      '-id',
      r.container.Id,
      '-address',
      managed.config.address,
    ])
  )
    stop('NS_SHIM');
  const socket = r.isolation.socket;
  exact(socket, ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink']);
  if (
    !Number.isSafeInteger(socket.dev) ||
    !Number.isSafeInteger(socket.ino) ||
    socket.ino < 1 ||
    socket.uid !== 0 ||
    socket.gid !== 0 ||
    socket.mode !== 0o140660 ||
    socket.nlink !== 1 ||
    !same(r.isolation.info, {
      DockerRootDir: i.dataRoot,
      Driver: 'vfs',
      CgroupDriver: 'systemd',
      LiveRestoreEnabled: false,
    })
  )
    stop('NS_SOCKET');
  const k = r.kernel;
  exact(k, [
    'containerProcess',
    'containerBounds',
    'containerMembers',
    'brokerMount',
    'daemonMount',
    'containerMount',
    'containerNetworkNamespace',
    'networkSandboxKey',
  ]);
  namespaceProcess(k.containerProcess, k.containerProcess.executable, false);
  if (
    k.containerProcess.mountNamespace === broker.mountNamespace ||
    k.containerProcess.mountNamespace === source.mountNamespace ||
    k.containerProcess.cgroup !== `0::/${i.slice}/docker-${r.container.Id}.scope`
  )
    stop('NS_CONTAINER_NAMESPACE');
  exact(k.containerBounds, ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max']);
  const containerCpu =
    typeof k.containerBounds['cpu.max'] === 'string' ? k.containerBounds['cpu.max'].split(' ') : [];
  if (
    k.containerBounds['memory.max'] !== String(2 * 1024 ** 3) ||
    k.containerBounds['memory.swap.max'] !== '0' ||
    k.containerBounds['pids.max'] !== '128' ||
    containerCpu.length !== 2 ||
    !containerCpu.every((v) => /^[1-9][0-9]*$/.test(v)) ||
    containerCpu[0] !== containerCpu[1] ||
    !Array.isArray(k.containerMembers) ||
    !k.containerMembers.length ||
    k.containerMembers.length > 128 ||
    new Set(k.containerMembers.map((v) => v.pid)).size !== k.containerMembers.length ||
    !k.containerMembers.some((v) => same(v, k.containerProcess))
  )
    stop('NS_CONTAINER_BOUNDS');
  for (const member of k.containerMembers) {
    namespaceProcess(member, member.executable, false);
    if (
      member.mountNamespace !== k.containerProcess.mountNamespace ||
      member.cgroup !== k.containerProcess.cgroup
    )
      stop('NS_CONTAINER_MEMBERS');
  }
  namespaceMount(k.brokerMount, p.mount, '/', p, r.storage.mapper);
  namespaceMount(k.daemonMount, p.mount, '/', p, r.storage.mapper);
  namespaceMount(k.containerMount, '/var/lib/postgresql/data', '/pgdata', p, r.storage.mapper);
  validateNamespaceRuntimeProof(value);
  validateNamespaceContainer(r.container, p, sha);
  if (r.container.State.Pid !== k.containerProcess.pid) stop('NS_CONTAINER_PID');
  return { ...value, requestSha256: sha, id: r.container.Id };
}

export function validateNamespaceRestoreKernelSnapshot(attestation, actual) {
  exact(actual, [
    'selfNamespace',
    'processes',
    'mountinfo',
    'afterMountinfo',
    'socket',
    'sourceImage',
    'privateImage',
    'container',
    'runtime',
    'afterContainer',
    'afterRuntime',
    'afterProcesses',
    'afterSelfNamespace',
    'alias',
    'afterAlias',
    'network',
    'afterNetwork',
    'networkSandboxKey',
    'afterNetworkSandboxKey',
  ]);
  const p = attestation.plan,
    r = attestation.readback,
    i = r.isolation;
  const expected = {
    broker: i.admission.supervisor.process,
    daemon: i.process,
    source: i.admission.sourceDaemon,
    container: r.kernel.containerProcess,
    containerd: i.managed.containerd,
    shim: i.managed.shims[0],
  };
  if (
    !same(actual.processes, expected) ||
    !same(actual.afterProcesses, expected) ||
    actual.selfNamespace !== expected.broker.mountNamespace ||
    actual.afterSelfNamespace !== actual.selfNamespace ||
    !same(actual.socket, i.socket) ||
    !same(actual.sourceImage, r.image.source) ||
    !same(actual.privateImage, r.image.imported) ||
    !same(actual.container, r.container) ||
    !same(actual.afterContainer, r.container)
  )
    stop('NS_INDEPENDENT_DRIFT');
  exact(actual.mountinfo, ['broker', 'daemon', 'source', 'container', 'containerd', 'shim']);
  if (!same(actual.mountinfo, actual.afterMountinfo)) stop('NS_MOUNTINFO_DRIFT');
  if (!same(actual.alias, actual.afterAlias)) stop('NS_ALIAS_DRIFT');
  const network = i.admission.network;
  validateNamespaceNetworkProof(network);
  exact(actual.network, ['source', 'broker', 'daemon', 'containerd', 'shim', 'container']);
  if (
    !same(actual.network, actual.afterNetwork) ||
    actual.network.source !== network.sourceNamespace ||
    actual.network.container !== r.kernel.containerNetworkNamespace ||
    actual.networkSandboxKey !== r.kernel.networkSandboxKey ||
    actual.afterNetworkSandboxKey !== r.kernel.networkSandboxKey ||
    ['broker', 'daemon', 'containerd', 'shim'].some(
      (key) => actual.network[key] !== network.supervisorNamespace,
    )
  )
    stop('NS_NETWORK_DRIFT');

  namespaceRestoreClientOptions(attestation, {
    ...actual.alias,
    selfNamespace: actual.selfNamespace,
    mountinfo: { self: actual.mountinfo.broker, source: actual.mountinfo.source },
  });
  for (const name of ['broker', 'daemon', 'containerd', 'shim']) {
    const rows = parseDiskRestoreMountinfo(actual.mountinfo[name]),
      alias = rows.filter((x) => x.target === '/media');
    if (alias.length !== 1) stop('NS_ALIAS_MOUNT');
    validateNamespaceRuntimeRows(
      attestation,
      rows,
      parseDiskRestoreMountinfo(actual.mountinfo.source),
    );
    namespaceMount(alias[0], '/media', '/', p, r.storage.mapper);
    if (!same(alias[0], r.alias[name === 'broker' ? 'brokerMount' : 'daemonMount']))
      stop('NS_ALIAS_MOUNT');
    const mask = rows.filter((x) => x.target === '/run/containerd');
    if (mask.length !== 1 || rows.some((x) => x.target.startsWith('/run/containerd/')))
      stop('NS_MASK_MOUNT');
    namespaceMount(mask[0], '/run/containerd', '/.runtime/run-containerd', p, r.storage.mapper);
    if (!same(mask[0], r.mask[name === 'broker' ? 'brokerMount' : 'daemonMount']))
      stop('NS_MASK_MOUNT');
  }

  const runtime = actual.runtime;
  exact(runtime, [
    'unit',
    'slice',
    'bounds',
    'sliceBounds',
    'configSha256',
    'members',
    'containerBounds',
    'containerMembers',
  ]);
  if (
    !same(runtime, actual.afterRuntime) ||
    !same(runtime.unit, i.admission.supervisor.unit) ||
    !same(runtime.slice, i.admission.supervisor.slice.unit) ||
    !same(runtime.bounds, i.admission.supervisor.bounds) ||
    !same(runtime.sliceBounds, i.admission.supervisor.slice.bounds) ||
    runtime.configSha256 !== i.managed.configSha256 ||
    !same(runtime.containerBounds, r.kernel.containerBounds) ||
    !same(runtime.containerMembers, r.kernel.containerMembers) ||
    !same(
      runtime.members,
      [expected.broker.pid, expected.daemon.pid, expected.containerd.pid, expected.shim.pid].sort(
        (a, b) => a - b,
      ),
    )
  )
    stop('NS_RUNTIME_DRIFT');
  const mapper = r.storage.mapper,
    device = `${mapper.device}:${mapper.minor}`;
  for (const [name, target, root] of [
    ['broker', p.mount, '/'],
    ['daemon', p.mount, '/'],
    ['container', '/var/lib/postgresql/data', '/pgdata'],
  ]) {
    const entries = parseDiskRestoreMountinfo(actual.mountinfo[name]),
      match = entries.filter((x) => x.target === target);
    if (match.length !== 1 || entries.some((x) => x.target.startsWith(`${target}/`)))
      stop('NS_INDEPENDENT_MOUNT');
    namespaceMount(match[0], target, root, p, mapper);
    if (!same(match[0], r.kernel[`${name}Mount`])) stop('NS_INDEPENDENT_MOUNT');
    if (name !== 'container') {
      const ancestors = entries.filter(
        (x) => p.work === x.target || p.work.startsWith(`${x.target.replace(/\/$/, '')}/`),
      );
      if (!ancestors.length || ancestors.some((x) => x.optional.length))
        stop('NS_PARENT_NOT_PRIVATE');
    }
  }
  if (
    parseDiskRestoreMountinfo(actual.mountinfo.source).some(
      (x) =>
        x.target === p.mount ||
        x.target.startsWith(`${p.mount}/`) ||
        x.source === p.mapperPath ||
        x.device === device,
    )
  )
    stop('NS_HOST_MOUNT_LEAK');
}

function namespaceReadProcess(pid) {
  const path = `/proc/${pid}`,
    stat = () =>
      readFileSync(`${path}/stat`, 'utf8').split(')').slice(-1)[0].trim().split(/\s+/)[19],
    startTicks = stat();
  const status = readFileSync(`${path}/status`, 'utf8');
  const ids = (key) => {
    const v = new RegExp(`^${key}:\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)$`, 'm').exec(status);
    if (!v) stop('NS_PROCESS_OWNER');
    return v.slice(1).map(Number);
  };
  const bytes = readFileSync(`${path}/cmdline`);
  if (!bytes.length || bytes.length > 65536 || bytes.at(-1) !== 0) stop('NS_PROCESS_ARGV');
  const value = {
    pid,
    startTicks,
    executable: readlinkSync(`${path}/exe`),
    cmdline: bytes.subarray(0, -1).toString().split('\0'),
    mountNamespace: statSync(`${path}/ns/mnt`).ino,
    uid: ids('Uid'),
    gid: ids('Gid'),
    cgroup: readFileSync(`${path}/cgroup`, 'utf8').trim(),
  };
  if (stat() !== startTicks || statSync(`${path}/ns/mnt`).ino !== value.mountNamespace)
    stop('NS_PROCESS_DRIFT');
  return value;
}

function validateNamespaceAliasBaseline(value) {
  exact(value, ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink']);
  if (
    !Number.isSafeInteger(value.dev) ||
    value.dev < 1 ||
    !Number.isSafeInteger(value.ino) ||
    value.ino < 1 ||
    value.uid !== 0 ||
    value.gid !== 0 ||
    value.mode !== 0o40755 ||
    !Number.isSafeInteger(value.nlink) ||
    value.nlink < 1
  )
    stop('NS_ALIAS_BASELINE');
}

function validateNamespaceAliasProof(alias, plan, storage) {
  exact(alias, ['baseline', 'mount', 'brokerMount', 'daemonMount']);
  validateNamespaceAliasBaseline(alias.baseline);
  if (!same(alias.mount, storage.mount)) stop('NS_ALIAS_IDENTITY');
  namespaceMount(alias.brokerMount, '/media', '/', plan, storage.mapper);
  namespaceMount(alias.daemonMount, '/media', '/', plan, storage.mapper);
}

function validateNamespaceMaskProof(mask, plan, storage) {
  exact(mask, ['baseline', 'source', 'brokerMount', 'daemonMount']);
  for (const [value, modes] of [
    [mask.baseline, [0o40711, 0o40755]],
    [mask.source, [0o40700]],
  ]) {
    exact(value, ['dev', 'ino', 'uid', 'gid', 'mode']);
    if (
      !Number.isSafeInteger(value.dev) ||
      value.dev < 1 ||
      !Number.isSafeInteger(value.ino) ||
      value.ino < 1 ||
      value.uid !== 0 ||
      value.gid !== 0 ||
      !modes.includes(value.mode)
    )
      stop('NS_MASK_IDENTITY');
  }
  if (mask.source.dev !== storage.mount.dev || mask.source.ino === storage.mount.ino)
    stop('NS_MASK_IDENTITY');
  namespaceMount(
    mask.brokerMount,
    '/run/containerd',
    '/.runtime/run-containerd',
    plan,
    storage.mapper,
  );
  namespaceMount(
    mask.daemonMount,
    '/run/containerd',
    '/.runtime/run-containerd',
    plan,
    storage.mapper,
  );
}

function validateNamespaceNetworkProof(network) {
  exact(network, ['sourceNamespace', 'supervisorNamespace']);
  if (
    !Number.isSafeInteger(network.sourceNamespace) ||
    network.sourceNamespace < 1 ||
    !Number.isSafeInteger(network.supervisorNamespace) ||
    network.supervisorNamespace < 1 ||
    network.sourceNamespace === network.supervisorNamespace
  )
    stop('NS_NETWORK');
}

function validateNamespaceRuntimeProof(attestation) {
  const p = attestation.plan,
    r = attestation.readback,
    k = r.kernel;
  exact(r.runtimeMounts, ['dataRoot', 'network']);
  const data = r.runtimeMounts.dataRoot,
    net = r.runtimeMounts.network,
    prefix = `${p.isolation.execRoot}/netns/`;
  if (
    !Array.isArray(data.optional) ||
    data.optional.length !== 1 ||
    !/^shared:[1-9][0-9]*$/.test(data.optional[0])
  )
    stop('NS_DATA_ROOT_MOUNT');
  namespaceMount(
    { ...data, optional: [] },
    p.isolation.dataRoot,
    '/.runtime/docker-data',
    p,
    r.storage.mapper,
  );
  exact(net, Object.keys(r.alias.brokerMount));
  if (
    data.parent !== r.alias.brokerMount.id ||
    net.parent !== r.alias.brokerMount.id ||
    !/^[0-9]+$/.test(net.id) ||
    !/^[0-9]+:[0-9]+$/.test(net.device) ||
    typeof net.target !== 'string' ||
    !net.target.startsWith(prefix) ||
    !/^[a-f0-9]{12}$/.test(net.target.slice(prefix.length)) ||
    net.root !== `net:[${k.containerNetworkNamespace}]` ||
    net.fstype !== 'nsfs' ||
    net.source !== 'nsfs' ||
    !same(net.options, ['rw']) ||
    !same(net.optional, []) ||
    !same(net.superOptions, ['rw']) ||
    !Number.isSafeInteger(k.containerNetworkNamespace) ||
    k.containerNetworkNamespace < 1 ||
    [
      r.isolation.admission.network.sourceNamespace,
      r.isolation.admission.network.supervisorNamespace,
    ].includes(k.containerNetworkNamespace) ||
    k.networkSandboxKey !== net.target
  )
    stop('NS_NETNS_MOUNT');
}

function validateNamespaceRuntimeRows(attestation, rows, sourceRows) {
  validateNamespaceRuntimeProof(attestation);
  const r = attestation.readback,
    descendants = rows.filter((v) => v.target.startsWith('/media/')),
    expected = [r.runtimeMounts.dataRoot, r.runtimeMounts.network];
  if (
    descendants.length !== 2 ||
    !expected.every((v) => descendants.some((x) => same(x, v))) ||
    new Set(descendants.map((v) => v.id)).size !== 2 ||
    rows.filter((v) => v.optional.includes(r.runtimeMounts.dataRoot.optional[0])).length !== 1 ||
    sourceRows.some((v) => v.optional.includes(r.runtimeMounts.dataRoot.optional[0]))
  )
    stop('NS_RUNTIME_MOUNTS');
}

function namespaceDeviceString(value) {
  if (!Number.isSafeInteger(value) || value < 1) stop('NS_NETNS_IDENTITY');
  const dev = BigInt(value),
    major = ((dev >> 8n) & 4095n) | ((dev >> 32n) & ~4095n),
    minor = (dev & 255n) | ((dev >> 12n) & ~255n);
  return `${major}:${minor}`;
}

export function namespaceRestoreClientOptions(attestation, actual) {
  exact(actual, [
    'selfNamespace',
    'mount',
    'alias',
    'sourceAlias',
    'sourceAliasEmpty',
    'mountinfo',
    'daemonCwd',
    'daemonCwdIdentity',
    'mask',
    'maskSource',
    'sourceMask',
    'networkMountIdentity',
    'containerNetworkIdentity',
  ]);
  const p = attestation?.plan,
    r = attestation?.readback,
    mount = r?.storage?.mount,
    namespace = r?.isolation?.admission?.supervisor?.process?.mountNamespace;
  if (!r?.alias || !r?.mask || !r?.storage || !p?.isolation) stop('NS_CLIENT_CWD');
  validateNamespaceAliasProof(r.alias, p, r.storage);
  validateNamespaceMaskProof(r.mask, p, r.storage);
  if (
    !Number.isSafeInteger(namespace) ||
    namespace < 1 ||
    actual.selfNamespace !== namespace ||
    mount?.uid !== 0 ||
    mount?.gid !== 0 ||
    mount?.mode !== 0o40700 ||
    !Number.isSafeInteger(mount?.dev) ||
    !Number.isSafeInteger(mount?.ino) ||
    mount.ino < 1 ||
    !same(actual.mount, mount) ||
    !same(actual.alias, mount) ||
    !same(actual.mask, r.mask.source) ||
    !same(actual.maskSource, r.mask.source) ||
    !same(actual.sourceMask, r.mask.baseline) ||
    !same(actual.sourceAlias, r.alias.baseline) ||
    actual.sourceAliasEmpty !== true ||
    actual.daemonCwd !== '/media' ||
    !same(actual.daemonCwdIdentity, mount) ||
    p.isolation.strategy !== 'SYSTEMD_SUPERVISOR_PRIVATE_ALIAS_V1' ||
    p.isolation.dataRoot !== '/media/.runtime/docker-data' ||
    p.isolation.execRoot !== '/media/.runtime/docker-exec' ||
    p.isolation.socket !== '/media/.runtime/docker.sock' ||
    p.isolation.pidFile !== '/media/.runtime/dockerd.pid'
  )
    stop('NS_CLIENT_CWD');
  exact(actual.mountinfo, ['self', 'source']);
  exact(actual.networkMountIdentity, ['dev', 'ino']);
  exact(actual.containerNetworkIdentity, ['dev', 'ino']);
  if (
    !same(actual.networkMountIdentity, actual.containerNetworkIdentity) ||
    actual.networkMountIdentity.ino !== r.kernel.containerNetworkNamespace ||
    namespaceDeviceString(actual.networkMountIdentity.dev) !== r.runtimeMounts.network.device
  )
    stop('NS_NETNS_IDENTITY');
  const rows = parseDiskRestoreMountinfo(actual.mountinfo.self),
    alias = rows.filter((x) => x.target === '/media'),
    canonical = rows.filter((x) => x.target === p.mount);
  if (
    alias.length !== 1 ||
    canonical.length !== 1 ||
    rows.some((x) => x.target.startsWith(`${p.mount}/`)) ||
    rows
      .filter((x) => x.target === '/' || p.work.startsWith(`${x.target.replace(/\/$/, '')}/`))
      .some((x) => x.optional.length)
  )
    stop('NS_ALIAS_MOUNT');
  namespaceMount(alias[0], '/media', '/', p, r.storage.mapper);
  validateNamespaceRuntimeRows(
    attestation,
    rows,
    parseDiskRestoreMountinfo(actual.mountinfo.source),
  );
  namespaceMount(canonical[0], p.mount, '/', p, r.storage.mapper);
  if (!same(alias[0], r.alias.brokerMount)) stop('NS_ALIAS_MOUNT');
  const mask = rows.filter((x) => x.target === '/run/containerd');
  if (mask.length !== 1 || rows.some((x) => x.target.startsWith('/run/containerd/')))
    stop('NS_MASK_MOUNT');
  namespaceMount(mask[0], '/run/containerd', '/.runtime/run-containerd', p, r.storage.mapper);
  if (!same(mask[0], r.mask.brokerMount)) stop('NS_MASK_MOUNT');
  const device = `${r.storage.mapper.device}:${r.storage.mapper.minor}`;
  if (
    parseDiskRestoreMountinfo(actual.mountinfo.source).some(
      (x) =>
        x.target === '/media' ||
        x.target.startsWith('/media/') ||
        x.target === '/run/containerd' ||
        x.target.startsWith('/run/containerd/') ||
        x.target === p.mount ||
        x.target.startsWith(`${p.mount}/`) ||
        x.source === p.mapperPath ||
        x.device === device,
    )
  )
    stop('NS_HOST_MOUNT_LEAK');
  return { host: 'unix:///media/.runtime/docker.sock', cwd: '/media' };
}

function inspectNamespaceRestoreKernel(value) {
  const p = value.plan,
    r = value.readback;
  const processes = () => ({
    broker: namespaceReadProcess(r.isolation.admission.supervisor.process.pid),
    daemon: namespaceReadProcess(r.isolation.process.pid),
    source: namespaceReadProcess(r.isolation.admission.sourceDaemon.pid),
    container: namespaceReadProcess(r.container.State.Pid),
    containerd: namespaceReadProcess(r.isolation.managed.containerd.pid),
    shim: namespaceReadProcess(r.isolation.managed.shims[0].pid),
  });
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: '/root',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    DOCKER_CONFIG: '/proc/self/phub-nonexistent-docker-config',
  };
  const show = (name, keys) => {
    const raw = execFileSync(
      '/usr/bin/systemctl',
      ['show', name, ...keys.map((k) => `--property=${k}`)],
      { env, timeout: 10000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString();
    const entries = raw
      .trim()
      .split('\n')
      .map((line) => {
        const i = line.indexOf('=');
        if (i < 0) stop('NS_UNIT_FIELDS');
        return [line.slice(0, i), line.slice(i + 1)];
      });
    if (entries.length !== keys.length || new Set(entries.map((x) => x[0])).size !== keys.length)
      stop('NS_UNIT_FIELDS');
    return Object.fromEntries(entries);
  };
  const bounds = (group) => {
    const path = `/sys/fs/cgroup${group}`,
      st = lstatSync(path);
    return {
      path,
      identity: Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode'].map((k) => [k, st[k]])),
      ...Object.fromEntries(
        ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max'].map((k) => [
          k,
          readFileSync(`${path}/${k}`, 'utf8').trim(),
        ]),
      ),
    };
  };
  const group = `/${p.isolation.slice}/${p.isolation.unit}`;
  const members = (path) => {
    let ids = readFileSync(`${path}/cgroup.procs`, 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
    for (const entry of readdirSync(path, { withFileTypes: true }))
      if (entry.isDirectory()) ids.push(...members(`${path}/${entry.name}`));
    if (ids.some((v) => !Number.isSafeInteger(v) || v < 1) || new Set(ids).size !== ids.length)
      stop('NS_CGROUP_MEMBERS');
    return ids.sort((a, b) => a - b);
  };
  const runtime = () => ({
    unit: show(p.isolation.unit, NS_UNIT_KEYS),
    slice: show(p.isolation.slice, NS_SLICE_KEYS),
    bounds: bounds(group),
    sliceBounds: bounds(`/${p.isolation.slice}`),
    configSha256: hash(read(`${p.isolation.execRoot}/containerd/containerd.toml`)),
    members: members(`/sys/fs/cgroup${group}`),
    containerBounds: Object.fromEntries(
      ['memory.max', 'memory.swap.max', 'pids.max', 'cpu.max'].map((k) => [
        k,
        readFileSync(
          `/sys/fs/cgroup/${p.isolation.slice}/docker-${r.container.Id}.scope/${k}`,
          'utf8',
        ).trim(),
      ]),
    ),
    containerMembers: members(
      `/sys/fs/cgroup/${p.isolation.slice}/docker-${r.container.Id}.scope`,
    ).map(namespaceReadProcess),
  });
  const beforeRuntime = runtime();
  const before = processes(),
    selfNamespace = statSync('/proc/self/ns/mnt').ino;
  const mountSnapshot = (values) =>
    Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, readFileSync(`/proc/${v.pid}/mountinfo`, 'utf8')]),
    );
  const beforeMountinfo = mountSnapshot(before);
  const identity = (st) =>
    Object.fromEntries(['dev', 'ino', 'uid', 'gid', 'mode'].map((key) => [key, st[key]]));
  const aliasSnapshot = () => {
    const path = `/proc/${r.isolation.admission.sourceDaemon.pid}/root/media`,
      source = lstatSync(path);
    return {
      mount: identity(lstatSync(p.mount)),
      alias: identity(lstatSync('/media')),
      mask: identity(lstatSync('/run/containerd')),
      maskSource: identity(lstatSync('/media/.runtime/run-containerd')),
      sourceMask: identity(
        lstatSync(`/proc/${r.isolation.admission.sourceDaemon.pid}/root/run/containerd`),
      ),
      sourceAlias: { ...identity(source), nlink: source.nlink },
      sourceAliasEmpty: readdirSync(path).length === 0,
      daemonCwd: readlinkSync(`/proc/${r.isolation.process.pid}/cwd`),
      daemonCwdIdentity: identity(statSync(`/proc/${r.isolation.process.pid}/cwd`)),
      networkMountIdentity: Object.fromEntries(
        ['dev', 'ino'].map((k) => [k, statSync(r.runtimeMounts.network.target)[k]]),
      ),
      containerNetworkIdentity: Object.fromEntries(
        ['dev', 'ino'].map((k) => [k, statSync(`/proc/${r.container.State.Pid}/ns/net`)[k]]),
      ),
    };
  };
  const networkSnapshot = () =>
    Object.fromEntries(
      Object.entries(processes()).map(([name, value]) => [
        name,
        statSync(`/proc/${value.pid}/ns/net`).ino,
      ]),
    );
  const beforeNetwork = networkSnapshot();
  const beforeAlias = aliasSnapshot();
  const connection = namespaceRestoreClientOptions(value, {
    ...beforeAlias,
    selfNamespace,
    mountinfo: {
      self: readFileSync('/proc/self/mountinfo', 'utf8'),
      source: readFileSync(`/proc/${before.source.pid}/mountinfo`, 'utf8'),
    },
  });
  const privateRead = (args) =>
    parseStrictJson(
      execFileSync('/usr/bin/docker', ['--host', connection.host, ...args], {
        env: { ...env, DOCKER_HOST: connection.host },
        cwd: connection.cwd,
        timeout: 10000,
        maxBuffer: 256 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  const imageFormat =
    '{"Id":{{json .Id}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"RepoDigests":{{json .RepoDigests}},"Size":{{json .Size}},"RootFS":{{json .RootFS}},"Env":{{json .Config.Env}}}';
  const sourceImage = parseStrictJson(
    docker(['image', 'inspect', '--format', imageFormat, bridge.postgresImage]),
  );
  const privateImage = privateRead([
    'image',
    'inspect',
    '--format',
    imageFormat,
    p.isolation.image.Id,
  ]);
  const raw = privateRead(['inspect', r.container.Id]);
  if (!Array.isArray(raw) || raw.length !== 1) stop('NS_CONTAINER_COUNT');
  const row = raw[0],
    socket = lstatSync(p.isolation.socket);
  const projectContainer = (row) => ({
    Id: row.Id,
    Config: Object.fromEntries(Object.keys(r.container.Config).map((k) => [k, row.Config[k]])),
    HostConfig: Object.fromEntries(
      Object.keys(r.container.HostConfig).map((k) => [k, row.HostConfig[k]]),
    ),
    Mounts: row.Mounts,
    State: Object.fromEntries(Object.keys(r.container.State).map((k) => [k, row.State[k]])),
    Image: row.Image,
  });
  const container = projectContainer(row);
  const afterRaw = privateRead(['inspect', r.container.Id]);
  if (!Array.isArray(afterRaw) || afterRaw.length !== 1) stop('NS_CONTAINER_COUNT');
  validateNamespaceRestoreKernelSnapshot(value, {
    selfNamespace,
    processes: before,
    mountinfo: beforeMountinfo,
    afterMountinfo: mountSnapshot(processes()),
    socket: Object.fromEntries(
      ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink'].map((k) => [k, socket[k]]),
    ),
    sourceImage,
    privateImage,
    container,
    afterContainer: projectContainer(afterRaw[0]),
    runtime: beforeRuntime,
    afterRuntime: runtime(),
    afterProcesses: processes(),
    afterSelfNamespace: statSync('/proc/self/ns/mnt').ino,
    alias: beforeAlias,
    afterAlias: aliasSnapshot(),
    network: beforeNetwork,
    afterNetwork: networkSnapshot(),
    networkSandboxKey: row.NetworkSettings?.SandboxKey,
    afterNetworkSandboxKey: afterRaw[0].NetworkSettings?.SandboxKey,
  });
}

function readDiskRestoreExclusion(expected, reference) {
  const operationBytes = read(DISK_BACKUP_REQUEST),
    op = parseStrictJson(operationBytes);
  // The enrolled script is the independently proven standalone source, never a caller path.
  if (!SHA.test(op.controllerSha ?? '') || op.controllerSha !== expected.controllerSha)
    stop('DISK_TOOL');
  const tool = `${ROOT}/operator/tools/${op.controllerSha}/control-timeweb-database-backup.py`;
  const sourceTool = `${SOURCE}/scripts/control-timeweb-database-backup.py`;
  const sourceBytes = read(sourceTool, 0o644),
    installedBytes = read(tool, 0o755);
  validateDiskRestoreToolBytes(installedBytes, sourceBytes, op.toolFileSha256);
  let output;
  try {
    output = execFileSync(
      '/usr/bin/python3',
      ['-I', '-S', '-B', tool, '--attest-disk', DISK_BACKUP_REQUEST],
      {
        encoding: 'utf8',
        timeout: 30000,
        maxBuffer: 256 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', HOME: '/root', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
      },
    );
  } catch {
    stop('DISK_READBACK_UNKNOWN');
  }
  const value = validateDiskRestoreReadback(
    parseStrictJson(output),
    expected,
    reference,
    operationBytes,
  );
  if (
    !read(DISK_BACKUP_REQUEST).equals(operationBytes) ||
    !read(tool, 0o755).equals(installedBytes) ||
    !read(sourceTool, 0o644).equals(sourceBytes)
  )
    stop('DISK_REQUEST_DRIFT');
  return value;
}

function inspectDiskRestoreKernel(row, attestation) {
  const pid = row.State.Pid;
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2 ** 31 - 1) stop('DISK_PID');
  const hostNamespace = statSync('/proc/self/ns/mnt').ino;
  const containerNamespace = statSync(`/proc/${pid}/ns/mnt`).ino;
  validateDiskRestoreKernelSnapshot(row, attestation, {
    hostNamespace,
    containerNamespace,
    hostMountinfo: readFileSync('/proc/self/mountinfo', 'utf8'),
    containerMountinfo: readFileSync(`/proc/${pid}/mountinfo`, 'utf8'),
    afterHostNamespace: statSync('/proc/self/ns/mnt').ino,
    afterContainerNamespace: statSync(`/proc/${pid}/ns/mnt`).ino,
  });
}

function productionOps(op, owner, ignoredRestore = null) {
  const candidate = `${op.candidateSha}-${op.publicationRunId}-1`,
    tx = `${ROOT}/backups/${candidate}-migration`;
  const path = (name) => `${tx}/${name}`,
    name = `phub-timeweb-migration-${op.candidateSha.slice(0, 12)}-${op.publicationRunId}-1`;
  let plan,
    marker,
    lockIdentities,
    roleName,
    requireLocks = false;
  const image = () => {
    const values = parseStrictJson(docker(['image', 'inspect', MIGRATOR_IMAGE]));
    const v = values[0];
    if (
      values.length !== 1 ||
      v.Os !== 'linux' ||
      v.Architecture !== 'amd64' ||
      !v.RepoDigests?.includes(MIGRATOR_IMAGE) ||
      v.Config?.Labels?.['org.opencontainers.image.revision'] !== op.candidateSha ||
      v.Config.User !== 'appuser' ||
      v.Config.WorkingDir !== '/app' ||
      v.Config.Entrypoint !== null ||
      !same(v.Config.Cmd, ['node', 'apps/migrator/dist/main.js']) ||
      !/^sha256:[a-f0-9]{64}$/.test(v.Id)
    )
      stop('IMAGE');
    return v;
  };
  const spec = (kind) => ({
    kind,
    name: kind === 'migration' ? name : `${name}-role-${kind}`,
    imageId: plan?.imageId ?? image().Id,
    runtimeRole: roleName,
    env: envValues(kind, image().Config.Env),
  });
  const lookup = (kind, imageId, operationSha) => {
    const s = spec(kind),
      found = ids(['--filter', `name=^/${s.name}$`]);
    if (found.length > 1) stop('NAME');
    if (!found.length) return null;
    const row = inspect(found[0]);
    validateMigrationContainer(row, row.Id, operationSha, row.State.Status, { ...s, imageId });
    return row;
  };
  const assertMarker = (p, optional = false) => {
    if (!present(p)) {
      if (optional) return;
      stop('LOCK_MISSING');
    }
    const info = secure(p, 0o600);
    if (
      !read(p).equals(marker) ||
      (lockIdentities?.[p] && !same(lockIdentities[p], { device: info.dev, inode: info.ino }))
    )
      stop('LOCK_DRIFT');
  };
  const load = (p, bytes, operationSha) => {
    plan = p;
    marker = encoded({
      schema: 'PHUB_TIMEWEB_API_WORKER_MIGRATION_LOCK_V1',
      transaction: tx,
      planSha256: hash(bytes),
      operationSha256: operationSha,
    });
    if (present(path('ownership.json'))) {
      lockIdentities = parseStrictJson(read(path('ownership.json')));
      exact(lockIdentities, [ACTIVE, PROVISION]);
    }
    const runtimeEnv = envValues('runtime', image().Config.Env).find((v) =>
      v.startsWith('DATABASE_URL='),
    );
    try {
      roleName = decodeURIComponent(new URL(runtimeEnv?.slice(13)).username);
    } catch {
      stop('ENV');
    }
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(roleName)) stop('ENV');
    if (
      present(path('role-proof.json')) &&
      parseStrictJson(read(path('role-proof.json'))).runtime.currentRoleName !== roleName
    )
      stop('ROLE_DRIFT');
  };
  const ops = {
    time: () => Date.now(),
    receiptPath: path('migration-receipt.json'),
    assertSource: sourceAttest,
    assertUnused: () => {
      if (
        [ACTIVE, PROVISION, tx].some(present) ||
        ids(['--filter', `name=^/${name}(?:-role-(?:runtime|migrator))?$`]).length ||
        docker(['ps', '-q', '--filter', 'label=com.docker.compose.service=migrator']).trim()
      )
        stop('EXCLUSION');
    },
    authority: async (operation) => {
      const run = await githubPublic(`actions/runs/${operation.controllerSourceCiRunId}`);
      const jobs = await githubPublic(
        `actions/runs/${operation.controllerSourceCiRunId}/attempts/1/jobs?per_page=100`,
      );
      if (jobs.total_count !== jobs.jobs?.length) stop('CI');
      verifySourceCi(run, jobs.jobs, operation.controllerSha);
      secure(`${ROOT}/releases/${candidate}`, 0o700);
      await candidateAuthority(operation, `${ROOT}/releases/${candidate}`);
    },
    secrets: () => secretSet(RUNTIME),
    image: () => image().Id,
    snapshot: () => {
      const operationSha = hash(read(REQUEST));
      const rows = ids([]).map(inspect),
        excluded = [];
      let api, worker, pg;
      for (const row of rows) {
        if (ignoredRestore && row.Id === ignoredRestore.id) {
          if (ignoredRestore.schema === 'PHUB_TIMEWEB_DISK_RESTORE_READBACK_V1') {
            inspectDiskRestoreKernel(row, ignoredRestore);
            continue;
          }
          validateLegacyBackupRestoreMounts(row);
          const h = row.HostConfig;
          if (
            row.Name !==
              `/phub-timeweb-restore-${op.candidateSha.slice(0, 12)}-${op.publicationRunId}-1` ||
            row.Config.Image !== bridge.postgresImage ||
            row.Config.Labels?.['phub.backup-operation'] !== ignoredRestore.operationSha256 ||
            h.NetworkMode !== 'none' ||
            h.ReadonlyRootfs !== true ||
            h.Privileged !== false ||
            h.AutoRemove !== false ||
            Object.keys(h.PortBindings ?? {}).length ||
            (h.Binds ?? []).length ||
            (h.Devices ?? []).length ||
            !same(h.CapDrop, ['ALL']) ||
            (h.CapAdd ?? []).length ||
            !['created', 'running', 'exited'].includes(row.State.Status)
          )
            stop('BACKUP_RESTORE_CUSTODY');
          continue;
        }
        if (
          ['migration', 'runtime', 'migrator'].some(
            (kind) => row.Name === `/${kind === 'migration' ? name : `${name}-role-${kind}`}`,
          )
        ) {
          const kind = row.Config.Labels?.['phub.migration-kind'];
          validateMigrationContainer(row, row.Id, operationSha, row.State.Status, spec(kind));
          continue;
        }
        const service = row.Config.Labels?.['com.docker.compose.service'];
        if (service === 'migrator' && row.State.Running) stop('ACTIVE_MIGRATOR');
        const project = row.Config.Labels?.['com.docker.compose.project'];
        if (project === 'phub-timeweb-beta' && ['api', 'worker'].includes(service)) {
          if (row.State.Status !== 'running' || row.State.Health?.Status !== 'healthy')
            stop('UNHEALTHY');
          if (service === 'api') {
            if (api) stop('COUNT');
            api = snapshotRow(row);
          } else {
            if (worker) stop('COUNT');
            worker = snapshotRow(row);
          }
        } else {
          excluded.push(snapshotRow(row));
          if (row.Id === bridge.postgresId) {
            if (
              row.Config.Image !== bridge.postgresImage ||
              row.State.Status !== 'running' ||
              row.State.Health?.Status !== 'healthy'
            )
              stop('POSTGRES');
            pg = identity(row);
          }
        }
      }
      if (!api || !worker || !pg) stop('COUNT');
      return {
        api,
        worker,
        postgres: pg,
        controllerConfigSha256: hash(read('/etc/phub/timeweb-beta-standard-delivery.json')),
        excluded: excluded.sort((a, b) => a.identity.id.localeCompare(b.identity.id)),
      };
    },
    ledger: () =>
      parseStrictJson(
        docker([
          'exec',
          bridge.postgresId,
          '/bin/sh',
          '-eu',
          '-c',
          `export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000'; exec psql -X --no-password --username="$POSTGRES_USER" --dbname="\${POSTGRES_DB:-$POSTGRES_USER}" --no-psqlrc -At --set=ON_ERROR_STOP=1 --command="select coalesce(json_agg(json_build_object('filename',filename,'checksum',checksum) order by filename),'[]'::json)::text from public.schema_migrations"`,
        ]).trim(),
      ),
    target: () =>
      parseStrictJson(
        docker([
          'exec',
          bridge.postgresId,
          '/bin/sh',
          '-eu',
          '-c',
          `export PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=5000'; exec psql -X --no-password --username="$POSTGRES_USER" --dbname="\${POSTGRES_DB:-$POSTGRES_USER}" --no-psqlrc -At --set=ON_ERROR_STOP=1 --command="select json_build_object('databaseName',current_database(),'systemIdentifier',(select system_identifier::text from pg_catalog.pg_control_system()))::text"`,
        ]).trim(),
      ),
    backup: (operation) => {
      const directory = `${ROOT}/backups/${operation.controllerSha}-${operation.controllerSourceCiRunId}-1-web`;
      const proof = backupProof(directory, operation.expectedApi),
        v = parseStrictJson(read(proof.path));
      if (
        v.restoreImage !== bridge.postgresImage ||
        v.sourceLedgerSha256 !== PRE_LEDGER ||
        v.restoredLedgerSha256 !== PRE_LEDGER
      )
        stop('BACKUP');
      return proof;
    },
    prepare: (bytes) => {
      mkdirSync(tx, { mode: 0o700 });
      syncParent(tx);
      durable(path('preparation.json'), bytes, true);
      const capsule = readApiWorkerMigrationCapsule(bytes);
      load(capsule.plan, capsule.planBytes, hash(capsule.operationBytes));
      durable(path('plan.json'), capsule.planBytes, true);
    },
    preparation: () => read(path('preparation.json')),
    loadPlan: (p, bytes, operationSha) => {
      if (present(path('plan.json')) && !read(path('plan.json')).equals(bytes)) stop('PLAN_DRIFT');
      load(p, bytes, operationSha);
    },
    claim: (bytes, operationSha) => {
      load(parseStrictJson(bytes), bytes, operationSha);
      durable(ACTIVE, marker, true);
      durable(PROVISION, marker, true);
      requireLocks = true;
      lockIdentities = Object.fromEntries(
        [ACTIVE, PROVISION].map((p) => {
          const s = secure(p, 0o600);
          return [p, { device: s.dev, inode: s.ino }];
        }),
      );
      durable(path('ownership.json'), encoded(lockIdentities), true);
    },
    assertOwned: () => {
      owner.assertOwned();
      assertMarker(ACTIVE, !requireLocks);
      assertMarker(PROVISION, !requireLocks);
      if (
        !read(path('preparation.json')).equals(
          encodeApiWorkerMigrationCapsule(read(REQUEST), encoded(plan)),
        )
      )
        stop('CAPSULE_DRIFT');
    },
    writeReceipt: (v) => {
      secure(tx, 0o700);
      durable(path('migration-receipt.json'), encoded(v));
    },
    receipt: () => {
      const value = present(path('migration-receipt.json'))
        ? parseStrictJson(read(path('migration-receipt.json')))
        : null;
      requireLocks = !!value && !['PREPARING', 'ABORTED', 'RECONCILED'].includes(value.status);
      return value;
    },
    create: (kind, imageId, operationSha, runtimeRole) => {
      roleName = runtimeRole ?? roleName;
      const s = spec(kind);
      if (lookup(kind, imageId, operationSha)) stop('EXISTING_CONTAINER');
      let id;
      try {
        id = docker(
          migrationCreateArgs(
            s.name,
            operationSha,
            `${RUNTIME}/${kind === 'runtime' ? 'api' : 'migrator'}.env`,
            kind,
            runtimeRole,
          ),
        ).trim();
      } catch (error) {
        const found = lookup(kind, imageId, operationSha);
        if (!found || found.State.Status !== 'created') throw error;
        id = found.Id;
      }
      if (!HASH.test(id ?? '')) stop('CREATE');
      validateMigrationContainer(inspect(id), id, operationSha, 'created', s);
      return id;
    },
    start: (id, kind) => {
      const s = spec(kind);
      validateMigrationContainer(inspect(id), id, hash(read(REQUEST)), 'created', s);
      if (Date.now() >= Date.parse(op.expiresAt)) stop('EXPIRED');
      docker(['start', id]);
    },
    wait: (id, kind) => {
      const exit = docker(['wait', id], 900000).trim();
      const s = spec(kind);
      const row = inspect(id);
      validateMigrationContainer(row, id, hash(read(REQUEST)), 'exited', s);
      if (exit !== '0' || row.State.ExitCode !== 0) stop('EXIT');
    },
    logs: (id) => {
      const bytes = docker(['logs', id]);
      if (Buffer.byteLength(bytes) > 65536) stop('PROBE_LOGS');
      return parseStrictJson(bytes);
    },
    lookup,
    writeRoleProof: (bytes) => durable(path('role-proof.json'), bytes, true),
    readRoleProof: () => read(path('role-proof.json')),
    attestRoleContainers: (proof) => {
      roleName = proof.runtime.currentRoleName;
      for (const kind of ['runtime', 'migrator']) {
        const row = lookup(kind, plan.imageId, plan.operationSha256);
        if (
          row?.Id !== proof[`${kind}ContainerId`] ||
          row.State.Status !== 'exited' ||
          row.State.ExitCode !== 0 ||
          !same(ops.logs(row.Id), proof[kind])
        )
          stop('PROBE_DRIFT');
      }
    },
    attestStoppedProbes: () => {
      for (const kind of ['runtime', 'migrator']) {
        const row = lookup(kind, plan.imageId, plan.operationSha256);
        if (row && !['created', 'exited'].includes(row.State.Status)) stop('PROBE_RUNNING');
      }
    },
    successProof: () =>
      present(path('migration-success.json')) ? read(path('migration-success.json')) : null,
    writeSuccess: (bytes) => durable(path('migration-success.json'), bytes, true),
    release: () => {
      validateMigrationReleaseState(present(ACTIVE), present(PROVISION));
      for (const p of [PROVISION, ACTIVE]) {
        if (!present(p)) continue;
        assertMarker(p);
        const before = lstatSync(p);
        const bytes = read(p),
          after = lstatSync(p);
        if (before.ino !== after.ino || before.dev !== after.dev || !bytes.equals(marker))
          stop('LOCK_DRIFT');
        unlinkSync(p);
        syncParent(p);
      }
    },
  };
  return ops;
}
export async function runManualApiWorkerMigration(mode, requestPath) {
  if (
    !['deploy', 'reconcile'].includes(mode) ||
    requestPath !== REQUEST ||
    process.getuid?.() !== 0
  )
    stop('ENTRY');
  assertNoAmbientDockerOverrides();
  assertNoAmbientComposeOverrides();
  secure(`${ROOT}/standard`, 0o700);
  const bytes = read(REQUEST),
    op = validateApiWorkerMigrationOperation(
      parseStrictJson(bytes),
      mode === 'deploy' ? Date.now() : undefined,
    );
  const owner = acquireApiWorkerExecutor(`${ROOT}/standard/api-worker-executor.lock`);
  try {
    return await runMigrationAdapter(mode, bytes, productionOps(op, owner));
  } finally {
    owner.close();
  }
}

export function validateMigrationProofBundle(bundle, expected) {
  exact(expected, [
    'controllerSha',
    'controllerTree',
    'controllerSourceCiRunId',
    'candidateReleaseId',
    'migrationPlanSha256',
    'migrationSuccessSha256',
  ]);
  exact(bundle, ['preparation', 'plan', 'role', 'success', 'receipt']);
  const capsule = readApiWorkerMigrationCapsule(bundle.preparation),
    plan = validateMigrationPlan(capsule.plan, capsule.operationBytes);
  if (
    !capsule.planBytes.equals(bundle.plan) ||
    hash(bundle.plan) !== expected.migrationPlanSha256 ||
    plan.controllerSha !== expected.controllerSha ||
    plan.controllerTree !== expected.controllerTree ||
    plan.controllerSourceCiRunId !== expected.controllerSourceCiRunId ||
    plan.candidate !== expected.candidateReleaseId ||
    hash(bundle.success) !== expected.migrationSuccessSha256
  )
    stop('PROOF_TUPLE');
  const success = parseStrictJson(bundle.success);
  exact(success, [
    'schema',
    'status',
    'planSha256',
    'operationSha256',
    'containerId',
    'roleProofSha256',
    'observedAt',
  ]);
  const role = parseStrictJson(bundle.role);
  exact(role, [
    'schema',
    'planSha256',
    'operationSha256',
    'observedAt',
    'target',
    'runtime',
    'migrator',
    'runtimeContainerId',
    'migratorContainerId',
  ]);
  const receipt = validateMigrationReceipt(
    parseStrictJson(bundle.receipt),
    expected.migrationPlanSha256,
    plan.operationSha256,
  );
  if (
    success.schema !== 'PHUB_TIMEWEB_API_WORKER_MIGRATION_SUCCESS_V1' ||
    success.status !== 'SUCCESS' ||
    success.planSha256 !== expected.migrationPlanSha256 ||
    success.operationSha256 !== plan.operationSha256 ||
    !HASH.test(success.containerId ?? '') ||
    success.roleProofSha256 !== hash(bundle.role) ||
    role.schema !== 'PHUB_TIMEWEB_MIGRATION_ROLE_PROOF_V1' ||
    role.planSha256 !== expected.migrationPlanSha256 ||
    role.operationSha256 !== plan.operationSha256 ||
    !HASH.test(role.runtimeContainerId ?? '') ||
    !HASH.test(role.migratorContainerId ?? '') ||
    new Set([success.containerId, role.runtimeContainerId, role.migratorContainerId]).size !== 3 ||
    receipt.status !== 'RECONCILED' ||
    receipt.reconciledStatus !== 'SUCCESS' ||
    receipt.containerId !== success.containerId ||
    receipt.successSha256 !== expected.migrationSuccessSha256
  )
    stop('PROOF');
  for (const value of [role.observedAt, success.observedAt, receipt.observedAt])
    if (
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value ||
      Date.parse(value) > Date.now()
    )
      stop('PROOF_TIME');
  if (
    Date.parse(role.observedAt) > Date.parse(success.observedAt) ||
    Date.parse(success.observedAt) > Date.parse(receipt.observedAt)
  )
    stop('PROOF_TIME');
  exact(role.target, ['systemIdentifier', 'databaseName']);
  if (
    !/^[0-9]+$/.test(role.target.systemIdentifier ?? '') ||
    typeof role.target.databaseName !== 'string' ||
    !role.target.databaseName
  )
    stop('ROLE_TARGET');
  validateMigrationRoleReadback(role.runtime, 'runtime', role.target);
  validateMigrationRoleReadback(
    role.migrator,
    'migrator',
    role.target,
    role.runtime.currentRoleName,
  );
  return {
    operation: capsule.operation,
    operationBytes: capsule.operationBytes,
    plan,
    planBytes: bundle.plan,
    role,
    success,
  };
}
// Called by the enrolled Python producer after it proves source custody. Reads only; no lock claim/release or Docker mutation.
export async function attestMigrationBackupProof(expected, ignoredRestore = null) {
  assertNoAmbientDockerOverrides();
  assertNoAmbientComposeOverrides();
  if (expected?.candidateReleaseId !== `${bridge.candidateSha}-${bridge.publicationRunId}-1`)
    stop('BACKUP_TUPLE');
  let backupReferenceKind = null;
  if (ignoredRestore !== null) {
    // The fixed request chooses the branch. Caller shape cannot downgrade DISK to legacy.
    backupReferenceKind = validateMigrationBackupRestoreReference(
      read(DISK_BACKUP_REQUEST),
      expected,
      ignoredRestore,
    );
  }
  const tx = `${ROOT}/backups/${expected.candidateReleaseId}-migration`;
  const names = {
    preparation: 'preparation.json',
    plan: 'plan.json',
    role: 'role-proof.json',
    success: 'migration-success.json',
    receipt: 'migration-receipt.json',
  };
  const custody = {};
  const fileIdentity = (info) =>
    Object.fromEntries(
      ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].map((key) => [
        key,
        info[key],
      ]),
    );
  const bundle = Object.fromEntries(
    Object.entries(names).map(([key, name]) => {
      const path = `${tx}/${name}`,
        before = fileIdentity(secure(path, 0o600)),
        bytes = read(path),
        after = fileIdentity(secure(path, 0o600));
      if (!same(before, after)) stop('PROOF_FILE_DRIFT');
      custody[key] = { ...after, sha256: hash(bytes) };
      return [key, bytes];
    }),
  );
  const proof = validateMigrationProofBundle(bundle, expected);
  sourceAttest(proof.operation);
  const namespaceReference = backupReferenceKind === 'namespace';
  const diskReference = ['disk', 'namespace'].includes(backupReferenceKind) ? ignoredRestore : null;
  const diskReadback = diskReference ? readDiskRestoreExclusion(expected, diskReference) : null;
  if (namespaceReference) inspectNamespaceRestoreKernel(diskReadback);
  const ops = productionOps(
    proof.operation,
    { assertOwned() {} },
    namespaceReference ? null : (diskReadback ?? ignoredRestore),
  );
  await ops.loadPlan(proof.plan, proof.planBytes, proof.plan.operationSha256);
  if (
    !same(await ops.snapshot(), proof.plan.runtime) ||
    !same(await ops.secrets(), proof.plan.secretSet) ||
    !same(await ops.target(), proof.role.target) ||
    (await ops.image()) !== proof.plan.imageId
  )
    stop('BACKUP_RUNTIME_DRIFT');
  if (diskReadback) {
    const again = readDiskRestoreExclusion(expected, diskReference);
    if (namespaceReference) inspectNamespaceRestoreKernel(again);
    if (!same(diskReadback, again)) stop('DISK_READBACK_DRIFT');
  }
  validateApiWorkerMigrationLedger(await ops.ledger(), POST_LEDGER);
  await ops.attestRoleContainers(proof.role);
  const row = await ops.lookup('migration', proof.plan.imageId, proof.plan.operationSha256);
  if (
    row?.Id !== proof.success.containerId ||
    row.State.Status !== 'exited' ||
    row.State.ExitCode !== 0
  )
    stop('BACKUP_CONTAINER');
  for (const [key, name] of Object.entries(names))
    if (
      !same(
        fileIdentity(secure(`${tx}/${name}`, 0o600)),
        Object.fromEntries(Object.entries(custody[key]).filter(([field]) => field !== 'sha256')),
      )
    )
      stop('PROOF_FILE_DRIFT');
  return {
    schema: 'PHUB_TIMEWEB_MIGRATION_BACKUP_ATTESTATION_V1',
    containerId: row.Id,
    imageId: proof.plan.imageId,
    proofSha256: hash(canonical({ files: custody, container: snapshotRow(row) })),
  };
}
