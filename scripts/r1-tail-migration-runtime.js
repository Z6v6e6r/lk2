// Fixed R1 tail host binding. Reuses enrolled executor, secure files and owner/ACL backup custody.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  linkSync,
  lstatSync,
  fstatSync,
  readFileSync,
  constants,
  mkdirSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseStrictJson } from './strict-json.js';
import { acquireApiWorkerExecutor } from './timeweb-api-worker-upgrade.js';
import {
  upgradeGit as git,
  upgradeDocker as docker,
  readUpgradeFile as read,
  secureUpgradePath as secure,
  writeUpgradeAtomic as durable,
  githubPublic,
  normalizeUpgradeHardlink,
} from './timeweb-api-web-upgrade.js';
import {
  assertNoAmbientComposeOverrides,
  assertNoAmbientDockerOverrides,
} from './render-timeweb-beta-release-env.js';
import { describeTimewebRuntimeSecretSet } from './provision-timeweb-beta-runtime-secrets.js';
import { readControllerSourceAuthority } from './verify-source-ci.js';
import {
  migrationCreateArgs,
  readApiWorkerMigrationCapsule,
  createClosedApplicationProductionEffects,
  closedApplicationProductionPaths,
} from './timeweb-api-worker-migration.js';
import {
  createClosedApplicationProductionBinding,
  attestClosedApplicationPrevious,
  readClosedApplicationBackupProof,
} from './timeweb-closed-application-runtime.js';
import {
  validateClosedApplicationOperation,
  validateClosedApplicationPlan,
  validateClosedApplicationReceipt,
  validateClosedApplicationState,
  validateClosedApplicationRoleReadback,
  closedApplicationSchemas,
  CLOSED_APPLICATION_POSTGRES_CONTAINER as PG_ID,
} from './timeweb-closed-application-profile.js';
import { closedApplicationMigrationBinding } from './timeweb-closed-application-backup.js';
import {
  R1_TAIL,
  R1_TAIL_ARGUMENT,
  r1Encode,
  r1Hash,
  r1Same,
  r1Exact,
  r1Stop,
  r1LedgerCount,
} from './r1-tail-migration-profile.js';
import {
  validateR1TailOperation,
  runR1TailAdapter,
  r1TailPaths,
  R1_TAIL_ROOT as ROOT,
  R1_TAIL_REQUEST,
} from './r1-tail-migration-controller.js';
import {
  R1_TAIL_STATE_SQL,
  validateR1TailState,
  R1_TAIL_SAFE_ROLES_SQL,
} from './r1-tail-migration-state.js';
import {
  R1_TAIL_ACL_SQL,
  r1TailPreparationPlan,
  validateR1TailPreparation,
  r1TailAclTransaction,
} from './r1-tail-migration-acl.js';
import { attestR1TailSource } from './r1-tail-migration-source.js';
import { createR1TailLockCustody } from './r1-tail-migration-locks.js';
import {
  validateR1TailBackupOperation,
  validateR1TailBackupReceipt,
  r1TailBackupDirectory,
  r1TailBackupDefinition,
  r1TailBackupBindingHash,
} from './r1-tail-migration-backup.js';
const SOURCE = `${ROOT}/standard/source`,
  RUNTIME = '/etc/phub/timeweb-beta';
const ACTIVE = `${ROOT}/standard/active`,
  PROVISION = '/etc/phub/.timeweb-beta.provision.lock';
const PREFETCH_REQUEST = `${ROOT}/operator/r1-tail108-119-prefetch.json`;
const BACKUP_REQUEST = `${ROOT}/operator/database-backup-restore.json`;
const HASH = /^[a-f0-9]{64}$/;
const present = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
};
const deps = { git, read, secure, present };
const noMutation = { assertOwned: () => r1Stop('READ_ONLY') };
function mkdir(path) {
  if (!present(path)) {
    mkdirSync(path, { mode: 0o700 });
    const fd = openSync(dirname(path), 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  secure(path, 0o700);
}
function sql(text, readOnly = true) {
  try {
    const out = execFileSync(
      '/usr/bin/docker',
      [
        'exec',
        '-i',
        PG_ID,
        '/bin/sh',
        '-eu',
        '-c',
        `export PGOPTIONS='-c default_transaction_read_only=${readOnly ? 'on' : 'off'} -c statement_timeout=15000 -c lock_timeout=2000'; exec psql -X --no-password --username="$POSTGRES_USER" --dbname="\${POSTGRES_DB:-$POSTGRES_USER}" --no-psqlrc -qAt --set=ON_ERROR_STOP=1 --file=-`,
      ],
      {
        input: text,
        encoding: 'utf8',
        timeout: 35000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C',
          DOCKER_HOST: 'unix:///var/run/docker.sock',
          DOCKER_CONFIG: '/proc/self/phub-nonexistent-docker-config',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();
    return out ? parseStrictJson(out) : null;
  } catch {
    r1Stop('DATABASE_PROOF_UNKNOWN');
  }
}
const inspect = (id) => {
  const rows = parseStrictJson(docker(['container', 'inspect', id]));
  if (!Array.isArray(rows) || rows.length !== 1) r1Stop('INSPECT');
  return rows[0];
};
const ids = () => {
  const values = docker(['ps', '-aq', '--no-trunc']).trim().split('\n').filter(Boolean);
  if (values.some((id) => !HASH.test(id)) || new Set(values).size !== values.length)
    r1Stop('CONTAINER_IDS');
  return values;
};
const identity = (row) => ({
  id: row.Id,
  image: row.Config.Image,
  imageId: row.Image,
  releaseId: row.Config.Labels?.['phub.release-id'] ?? null,
  revision: row.Config.Labels?.['org.opencontainers.image.revision'] ?? null,
  restarts: row.RestartCount,
  startedAt: row.State.StartedAt,
});
function runtime(op) {
  const name = r1TailPaths(op).containerName;
  const all = ids()
    .map(inspect)
    .filter((row) => row.Name !== `/${name}` && row.Name !== `/${name}-role`);
  for (const row of all)
    if (row.Config.Labels?.['com.docker.compose.service'] === 'migrator' && row.State.Running)
      r1Stop('FOREIGN_MIGRATOR');
  for (const [service, expected] of [
    ['api', op.expectedApi],
    ['worker', op.expectedWorker],
    ['postgres', op.expectedPostgres],
  ]) {
    const rows = all.filter(
      (row) =>
        row.Config.Labels?.['com.docker.compose.project'] === 'phub-timeweb-beta' &&
        row.Config.Labels?.['com.docker.compose.service'] === service,
    );
    if (
      rows.length !== 1 ||
      rows[0].State.Status !== 'running' ||
      rows[0].State.Health?.Status !== 'healthy' ||
      !r1Same(identity(rows[0]), expected)
    )
      r1Stop('RUNTIME_IDENTITY');
  }
  if (op.expectedPostgres.id !== PG_ID) r1Stop('POSTGRES_TARGET');
  // Config is hashed in memory; env values never enter the capsule, logs or output.
  return {
    controllerConfigSha256: r1Hash(read('/etc/phub/timeweb-beta-standard-delivery.json')),
    containers: all
      .map((row) => ({ id: row.Id, fingerprint: r1Hash(r1Encode(row)) }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
function image(op) {
  const ref = `ghcr.io/z6v6e6r/phub-migrator@${op.publishedMigrator.imageId}`;
  const rows = parseStrictJson(docker(['image', 'inspect', ref]));
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row.Id !== op.publishedMigrator.imageId ||
    row.Os !== 'linux' ||
    row.Architecture !== 'amd64' ||
    !row.RepoDigests?.includes(ref) ||
    row.Config.User !== 'appuser' ||
    row.Config.WorkingDir !== '/app' ||
    row.Config.Labels?.['org.opencontainers.image.revision'] !== op.publishedMigrator.sourceSha ||
    !r1Same(row.Config.Cmd, ['node', 'apps/migrator/dist/main.js']) ||
    !(row.Config.Entrypoint === null || r1Same(row.Config.Entrypoint, ['docker-entrypoint.sh']))
  )
    r1Stop('IMAGE_IDENTITY');
  const index = parseStrictJson(docker(['image', 'inspect', op.publishedMigrator.image]));
  if (index.length !== 1 || !index[0].RepoDigests?.includes(op.publishedMigrator.image))
    r1Stop('IMAGE_INDEX_MISSING');
  return row;
}
async function authority(op) {
  await readControllerSourceAuthority(op, git, githubPublic);
  const run = await githubPublic(`actions/runs/${op.publishedMigrator.publicationRunId}`);
  if (
    String(run.id) !== op.publishedMigrator.publicationRunId ||
    run.head_sha !== op.controllerSha ||
    run.head_branch !== 'main' ||
    run.run_attempt !== 1 ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.event !== 'workflow_dispatch' ||
    run.path !== '.github/workflows/publish-timeweb-amd64-images.yaml'
  )
    r1Stop('PUBLICATION_AUTHORITY');
  const path = `${ROOT}/releases/${op.controllerSha}-${op.publishedMigrator.publicationRunId}-1/release-manifest.json`;
  const bytes = read(path),
    manifest = parseStrictJson(bytes),
    matches = manifest.images?.filter((row) => row.component === 'migrator') ?? [];
  if (
    r1Hash(bytes) !== op.publishedMigrator.manifestSha256 ||
    manifest.schemaVersion !== 'PHUB_TIMEWEB_RELEASE_MANIFEST_V2' ||
    manifest.gitCommit !== op.controllerSha ||
    manifest.gitTree !== op.controllerTree ||
    String(manifest.publication?.runId) !== op.publishedMigrator.publicationRunId ||
    manifest.publication?.runAttempt !== 1 ||
    matches.length !== 1 ||
    matches[0].revision !== op.controllerSha ||
    `ghcr.io/z6v6e6r/phub-migrator@${matches[0].digest}` !== op.publishedMigrator.image ||
    matches[0].runtimeDigest !== op.publishedMigrator.imageId
  )
    r1Stop('MANIFEST');
}
function previousCapsule(tail, kind = 'subject_link_0104', dependencies = deps) {
  const root = tail.previousMigrationSuccess.path.slice(0, -'/migration-success.json'.length);
  const current = readApiWorkerMigrationCapsule(dependencies.read(root + '/preparation.json'));
  const op = validateClosedApplicationOperation(current.operation);
  if (
    op.migrationProfile !== 'subject_link_0104' ||
    r1Hash(current.operationBytes) !== tail.previousMigrationSuccess.operationSha256 ||
    r1Hash(dependencies.read(root + '/migration-success.json')) !==
      tail.previousMigrationSuccess.sha256 ||
    closedApplicationProductionPaths(op).transactionRoot !== root
  )
    r1Stop('PREDECESSOR_BINDING');
  if (kind === 'subject_link_0104') return current;
  const pointer = op.previousMigrationSuccess,
    otherRoot = pointer.path.slice(0, -'/migration-success.json'.length);
  const other = readApiWorkerMigrationCapsule(dependencies.read(otherRoot + '/preparation.json'));
  if (
    other.operation.migrationProfile !== 'game_start_0103' ||
    r1Hash(other.operationBytes) !== pointer.operationSha256 ||
    r1Hash(dependencies.read(pointer.path)) !== pointer.sha256
  )
    r1Stop('PREDECESSOR_BINDING');
  return other;
}
// Pure fs/Git authority for the backup helper's new-source retained-predecessor read only.
export function attestR1TailPredecessorBackupSource(backup, tail, dependencies = deps) {
  attestR1TailSource(tail, dependencies);
  const previous = previousCapsule(tail, backup.migrationIntent?.migrationProfile, dependencies);
  if (
    !r1Same(
      closedApplicationMigrationBinding(previous.operation),
      closedApplicationMigrationBinding(backup.migrationIntent),
    )
  )
    r1Stop('PREDECESSOR_BACKUP_BINDING');
  return true;
}
function terminalPython(flag, path) {
  try {
    return parseStrictJson(
      execFileSync(
        '/usr/bin/python3',
        [
          '-I',
          '-S',
          '-B',
          `${SOURCE}/scripts/control-timeweb-database-backup.py`,
          flag,
          R1_TAIL_REQUEST,
          path,
        ],
        {
          timeout: 120000,
          maxBuffer: 8 * 1024 * 1024,
          env: { PATH: '/usr/bin:/bin', HOME: '/root', LANG: 'C.UTF-8' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    );
  } catch {
    r1Stop('BACKUP_TERMINAL_UNKNOWN');
  }
}
function predecessor(tail) {
  const capsule = previousCapsule(tail),
    op = capsule.operation,
    paths = closedApplicationProductionPaths(op);
  const plan = validateClosedApplicationPlan(capsule.plan, capsule.operationBytes),
    planSha = r1Hash(capsule.planBytes),
    opSha = r1Hash(capsule.operationBytes);
  if (
    !read(paths.requestPath).equals(capsule.operationBytes) ||
    !read(paths.transactionRoot + '/plan.json').equals(capsule.planBytes)
  )
    r1Stop('PREDECESSOR_CAPSULE');
  const bytes = read(tail.previousMigrationSuccess.path),
    success = parseStrictJson(bytes),
    schemas = closedApplicationSchemas('subject_link_0104');
  const receipt = validateClosedApplicationReceipt(
    'subject_link_0104',
    parseStrictJson(read(paths.transactionRoot + '/migration-receipt.json')),
    planSha,
    opSha,
  );
  if (
    success.schema !== schemas.success ||
    success.status !== 'SUCCESS' ||
    success.planSha256 !== planSha ||
    success.operationSha256 !== opSha ||
    success.ledgerSha256 !== R1_TAIL.checkpoints['108'] ||
    !r1Same(success.backup, plan.backup) ||
    receipt.status !== 'RECONCILED' ||
    receipt.reconciledStatus !== 'SUCCESS' ||
    receipt.successSha256 !== r1Hash(bytes) ||
    receipt.containerId !== success.containerId
  )
    r1Stop('PREDECESSOR_SUCCESS');
  const terminal = (args) => {
    const backupPath = args.at(-1);
    return r1Encode(terminalPython('--attest-r1-predecessor-backup', backupPath));
  };
  const oldDeps = { ...deps, terminal };
  attestClosedApplicationPrevious(op, oldDeps);
  const effects = createClosedApplicationProductionEffects(
    op,
    noMutation,
    createClosedApplicationProductionBinding(op),
  );
  effects.loadPlan(plan, capsule.planBytes, opSha);
  for (const [name, key, phase] of [
    ['bootstrap', 'bootstrapSha256', 'bootstrap'],
    ['cleanup', 'cleanupSha256', 'cleanup'],
  ]) {
    const proofBytes = read(`${paths.transactionRoot}/${name}.json`),
      proof = parseStrictJson(proofBytes);
    if (
      r1Hash(proofBytes) !== success[key] ||
      proof.operationSha256 !== opSha ||
      proof.sqlSha256 !== plan.inputs[`${name}Sha256`]
    )
      r1Stop('PREDECESSOR_ACL_PROOF');
    validateClosedApplicationState(op, proof.state, phase);
    if (name === 'cleanup' && r1Hash(r1Encode(proof.state)) !== success.stateSha256)
      r1Stop('PREDECESSOR_STATE');
  }
  for (const [phase, key, kind] of [
    ['pre', 'migratorPreSha256', 'migrator'],
    ['bootstrap', 'migratorBootstrapSha256', 'migrator-post'],
  ]) {
    const proofBytes = read(`${paths.transactionRoot}/migrator-${phase}.json`),
      proof = parseStrictJson(proofBytes);
    if (
      r1Hash(proofBytes) !== success[key] ||
      proof.operationSha256 !== opSha ||
      proof.planSha256 !== planSha ||
      proof.phase !== phase
    )
      r1Stop('PREDECESSOR_ROLE');
    validateClosedApplicationRoleReadback(op, proof.readback, phase, op.expectedDatabaseTarget);
    const row = effects.lookup(kind, plan.imageId, opSha);
    if (
      !row ||
      row.Id !== proof.containerId ||
      row.State.Status !== 'exited' ||
      row.State.ExitCode !== 0 ||
      !r1Same(effects.logs(row.Id), proof.readback)
    )
      r1Stop('PREDECESSOR_CONTAINER');
  }
  const row = effects.lookup('migration', plan.imageId, opSha);
  if (
    !row ||
    row.Id !== success.containerId ||
    row.State.Status !== 'exited' ||
    row.State.ExitCode !== 0 ||
    !r1Same(
      readClosedApplicationBackupProof(op, { fresh: false, retained: true }, oldDeps),
      plan.backup,
    )
  )
    r1Stop('PREDECESSOR_CUSTODY');
  return true;
}
export function attestR1TailBackupSource(backup, dependencies = deps) {
  validateR1TailBackupOperation(backup);
  return attestR1TailSource(backup.migrationIntent, dependencies);
}
export function readR1TailBackupDatabaseState(backup) {
  attestR1TailBackupSource(backup);
  const state = sql(R1_TAIL_STATE_SQL);
  return validateR1TailState(
    backup.migrationIntent,
    state,
    'cleaned',
    backup.migrationIntent.fromCount,
  );
}
function readBackup(op, fresh) {
  const raw = read(op.backup.operationPath),
    backup = validateR1TailBackupOperation(parseStrictJson(raw)),
    dir = r1TailBackupDirectory(backup);
  const receipt = read(dir + '/database-backup-receipt.json'),
    preimage = read(dir + '/preimage-proof.json');
  const proof = validateR1TailBackupReceipt(op, raw, receipt, preimage, { fresh });
  const terminal = terminalPython('--attest-r1-tail-backup', op.backup.operationPath);
  if (
    terminal.schema !== r1TailBackupDefinition(op.fromCount).terminalSchema ||
    terminal.operationSha256 !== proof.operationSha256 ||
    terminal.receiptSha256 !== proof.sha256 ||
    terminal.preimageSha256 !== proof.preimageSha256 ||
    terminal.storageCleanupVerified !== true ||
    terminal.reconciled !== true ||
    terminal.sourceLedgerSha256 !== proof.sourceLedgerSha256 ||
    terminal.migrationBindingSha256 !== r1TailBackupBindingHash(op)
  )
    r1Stop('BACKUP_TERMINAL');
  return proof;
}
function migrationCommand(op) {
  return [
    'node',
    'apps/migrator/dist/main.js',
    R1_TAIL_ARGUMENT,
    Buffer.from(
      JSON.stringify({
        ...op.expectedDatabaseTarget,
        fromCount: op.fromCount,
        catalogVariant: op.catalogVariant,
        catalogsSha256: op.catalogsSha256,
      }),
    ).toString('base64'),
  ];
}
const ROLE_SOURCE = `import {Client}from'pg';let c;try{const u=new URL(process.env.DATABASE_URL);if(u.search||u.hash||decodeURIComponent(u.username)!=='phub_migrator'||u.pathname!=='/phub_beta')throw Error();c=new Client({connectionString:u.toString(),connectionTimeoutMillis:5000,options:'-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000'});await c.connect();const r=(await c.query(\`select current_database()='phub_beta'and (select system_identifier::text from pg_catalog.pg_control_system())='7679125609183186977'and current_setting('server_version_num')::int/10000=16 and current_setting('transaction_read_only')='on'and current_user='phub_migrator'and session_user=current_user and current_setting('role')='none' and (${R1_TAIL_SAFE_ROLES_SQL}) and (select count(*)=2 and bool_and(relowner='phub_migrator'::regrole and relrowsecurity and relforcerowsecurity)from pg_class where oid in('notifications.intents'::regclass,'notifications.deliveries'::regclass))as ok\`)).rows;if(r.length!==1||r[0].ok!==true)throw Error();process.stdout.write('R1_TAIL_ROLE_VERIFIED\\n');}catch{process.stderr.write('R1_TAIL_ROLE_UNKNOWN\\n');process.exitCode=1;}finally{await c?.end().catch(()=>{});}`;
function containerArgs(op, operationSha, kind) {
  const legacy = `phub-timeweb-migration-${op.controllerSha.slice(0, 12)}-${op.publishedMigrator.publicationRunId}-1${kind === 'role' ? '-role-migrator' : ''}`;
  const args = migrationCreateArgs(
    legacy,
    operationSha,
    `${RUNTIME}/migrator.env`,
    kind === 'role' ? 'migrator' : 'migration',
    'phub_runtime',
  );
  const imageIndex = args.findIndex((value) =>
    /^ghcr\.io\/z6v6e6r\/phub-migrator@sha256:/.test(value),
  );
  if (imageIndex < 0) r1Stop('CREATE_TEMPLATE');
  args.splice(
    imageIndex,
    args.length - imageIndex,
    op.publishedMigrator.image,
    ...(kind === 'role' ? ['--input-type=module', '-e', ROLE_SOURCE] : migrationCommand(op)),
  );
  args[args.indexOf('--name') + 1] =
    r1TailPaths(op).containerName + (kind === 'role' ? '-role' : '');
  return args;
}
function validateContainer(op, row, kind, operationSha) {
  const h = row?.HostConfig,
    c = row?.Config,
    name = r1TailPaths(op).containerName + (kind === 'role' ? '-role' : '');
  const pinned = op.publishedMigrator,
    index = pinned.image.split('@')[1];
  const expectedEnv = [
    ...image(op).Config.Env,
    ...read(`${RUNTIME}/migrator.env`)
      .toString()
      .split('\n')
      .filter((line) => line && !line.startsWith('#')),
  ];
  const envMap = new Map();
  for (const value of expectedEnv) {
    const i = value.indexOf('=');
    if (i < 1) r1Stop('ENV');
    envMap.set(value.slice(0, i), value);
  }
  if (
    !HASH.test(row?.Id ?? '') ||
    row.Name !== `/${name}` ||
    ![pinned.imageId, index].includes(row.Image) ||
    ![pinned.image, `ghcr.io/z6v6e6r/phub-migrator@${pinned.imageId}`].includes(c?.Image) ||
    c.User !== 'appuser' ||
    c.WorkingDir !== '/app' ||
    !(
      r1Same(c.Entrypoint, kind === 'role' ? ['node'] : null) ||
      (kind !== 'role' && r1Same(c.Entrypoint, ['docker-entrypoint.sh']))
    ) ||
    !r1Same(
      c.Cmd,
      kind === 'role' ? ['--input-type=module', '-e', ROLE_SOURCE] : migrationCommand(op),
    ) ||
    c.Labels?.['phub.migration-operation'] !== operationSha ||
    c.Labels?.['phub.migration-kind'] !== (kind === 'role' ? 'migrator' : 'migration') ||
    c.Labels?.['com.docker.compose.project'] !== 'phub-timeweb-beta' ||
    c.Labels?.['com.docker.compose.service'] !==
      (kind === 'role' ? 'migration-role-probe' : 'migrator') ||
    !r1Same([...(c.Env ?? [])].sort(), [...envMap.values()].sort()) ||
    h.NetworkMode !== 'phub-timeweb-beta' ||
    !r1Same(Object.keys(row.NetworkSettings?.Networks ?? {}), ['phub-timeweb-beta']) ||
    h.RestartPolicy?.Name !== 'no' ||
    h.RestartPolicy?.MaximumRetryCount !== 0 ||
    h.ReadonlyRootfs !== true ||
    h.Privileged !== false ||
    h.AutoRemove !== false ||
    h.PublishAllPorts !== false ||
    !r1Same(h.CapDrop, ['ALL']) ||
    (h.CapAdd ?? []).length ||
    !r1Same(h.SecurityOpt, ['no-new-privileges:true']) ||
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
    (row.Mounts ?? []).length ||
    c.Volumes !== null ||
    row.RestartCount !== 0
  )
    r1Stop('CONTAINER_CUSTODY');
  return row;
}
function lookup(op, kind, operationSha) {
  const name = r1TailPaths(op).containerName + (kind === 'role' ? '-role' : '');
  const rows = ids()
    .map(inspect)
    .filter((row) => row.Name === `/${name}`);
  if (rows.length > 1) r1Stop('CONTAINER_COUNT');
  return rows.length ? validateContainer(op, rows[0], kind, operationSha) : null;
}
function createEffects(op, owner) {
  const paths = r1TailPaths(op),
    raw = read(R1_TAIL_REQUEST),
    operationSha = r1Hash(raw);
  let plan,
    planBytes,
    marker,
    custody,
    allowPartial = false;
  const path = (name) => paths.root + '/' + name;
  const syncParent = (target) => {
    const fd = openSync(dirname(target), 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const initializeCustody = () =>
    createR1TailLockCustody(paths.root, marker, owner, {
      present,
      read,
      durable,
      link: linkSync,
      unlink: unlinkSync,
      syncParent,
      normalize: normalizeUpgradeHardlink,
      rawRead: (target) => {
        secure(dirname(target));
        const before = lstatSync(target);
        const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = fstatSync(fd);
          if (
            !opened.isFile() ||
            opened.uid !== 0 ||
            opened.gid !== 0 ||
            (opened.mode & 0o777) !== 0o600 ||
            ![1, 2].includes(opened.nlink) ||
            opened.dev !== before.dev ||
            opened.ino !== before.ino ||
            opened.size > 4096
          )
            r1Stop('LOCK_METADATA');
          const bytes = readFileSync(fd),
            after = fstatSync(fd);
          if (
            ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'nlink'].some(
              (key) => opened[key] !== after[key],
            )
          )
            r1Stop('LOCK_READ_DRIFT');
          return bytes;
        } finally {
          closeSync(fd);
        }
      },
      info: (target) => {
        secure(dirname(target));
        const st = lstatSync(target);
        if (
          st.isSymbolicLink() ||
          !st.isFile() ||
          st.uid !== 0 ||
          st.gid !== 0 ||
          (st.mode & 0o777) !== 0o600 ||
          ![1, 2].includes(st.nlink)
        )
          r1Stop('LOCK_METADATA');
        return st;
      },
      stage: (target, bytes) => {
        const staged = target + '.incoming-' + randomBytes(12).toString('hex');
        durable(staged, bytes, true);
        return staged;
      },
    });
  const assertOwned = () => {
    owner.assertOwned();
    if (!read(R1_TAIL_REQUEST).equals(raw)) r1Stop('REQUEST_DRIFT');
    custody.assert(!allowPartial);
  };
  const assertFullOwned = () => {
    assertOwned();
    custody.assert(true);
  };
  const load = (p, bytes, sha) => {
    plan = p;
    planBytes = bytes;
    if (sha !== operationSha || !read(path('plan.json')).equals(bytes)) r1Stop('PLAN_CUSTODY');
    validateR1TailPreparation(plan.preparation, plan.preimage.security);
    marker = r1Encode({
      schema: 'PHUB_R1_TAIL_LOCK_V1',
      transaction: paths.root,
      operationSha256: operationSha,
      planSha256: r1Hash(bytes),
    });
    custody = initializeCustody();
    custody.load();
    if (!read(path('request.json')).equals(raw)) r1Stop('REQUEST_CAPSULE_DRIFT');
  };
  return {
    time: Date.now,
    assertSource: (operation) => attestR1TailSource(operation, deps),
    assertPrevious: predecessor,
    assertAuthority: authority,
    runtime: () => runtime(op),
    secrets: () => describeTimewebRuntimeSecretSet(RUNTIME),
    image: () => image(op).Id,
    state: () => sql(R1_TAIL_STATE_SQL),
    validateState: (value, phase, count) => validateR1TailState(op, value, phase, count),
    backup: (_op, fresh) => readBackup(op, fresh),
    assertOwned,
    reconcileOwnership: (record) => {
      allowPartial = ['PREPARED', 'SUCCESS', 'PARTIAL', 'ABORTED'].includes(record.status);
      custody.assert(!allowPartial);
    },
    assertTerminalOwned: () => {
      allowPartial = true;
      assertOwned();
    },
    releaseTerminal: () => {
      assertOwned();
      custody.release();
    },
    assertStoppedProbes: () => {
      const row = lookup(op, 'role', operationSha);
      if (row && !['created', 'exited'].includes(row.State.Status)) r1Stop('ROLE_PROBE_RUNNING');
    },
    attestRoleProof: () => {
      const value = parseStrictJson(read(path('role-proof.json'))),
        row = lookup(op, 'role', operationSha);
      if (
        value.operationSha256 !== operationSha ||
        value.sourceSha256 !== r1Hash(ROLE_SOURCE) ||
        !row ||
        row.Id !== value.containerId ||
        row.State.Status !== 'exited' ||
        row.State.ExitCode !== 0 ||
        docker(['logs', row.Id]).trim() !== 'R1_TAIL_ROLE_VERIFIED'
      )
        r1Stop('ROLE_PROOF');
    },
    attestTerminal: (record) => {
      const cleanup = read(path('cleanup.json'));
      if (r1Hash(cleanup) !== record.stateSha256) r1Stop('CLEANUP_PROOF_DRIFT');
      validateR1TailState(op, parseStrictJson(cleanup), 'cleaned', record.count);
      if (
        record.status === 'SUCCESS' &&
        present(paths.success) &&
        !read(paths.success).equals(r1Encode(record))
      )
        r1Stop('SUCCESS_DRIFT');
    },
    assertUnused: () => {
      if (
        [ACTIVE, PROVISION, paths.root].some(present) ||
        lookup(op, 'migration', operationSha) ||
        lookup(op, 'role', operationSha)
      )
        r1Stop('ATTEMPT_USED');
    },
    preparationPlan: r1TailPreparationPlan,
    prepare: (bytes, prepared) => {
      mkdir(paths.root);
      durable(path('request.json'), bytes, true);
      durable(path('plan.json'), prepared, true);
      durable(
        path('preparation.json'),
        r1Encode({ operation: bytes.toString('base64'), plan: prepared.toString('base64') }),
        true,
      );
      plan = parseStrictJson(prepared);
      planBytes = prepared;
    },
    preparation: () => parseStrictJson(read(path('preparation.json'))),
    loadPlan: load,
    claim: (bytes, sha) => {
      marker = r1Encode({
        schema: 'PHUB_R1_TAIL_LOCK_V1',
        transaction: paths.root,
        operationSha256: sha,
        planSha256: r1Hash(bytes),
      });
      custody = initializeCustody();
      custody.claim(() => {
        if (Date.now() >= Date.parse(op.expiresAt)) r1Stop('EXPIRED');
      });
    },
    writeReceipt: (bytes) => durable(path('migration-receipt.json'), bytes),
    receipt: () => read(path('migration-receipt.json')),
    writeProof: (name, bytes) => {
      if (!['bootstrap', 'cleanup'].includes(name)) r1Stop('PROOF_PATH');
      const target = path(name + '.json');
      if (present(target)) {
        if (!read(target).equals(bytes)) r1Stop('PROOF_DRIFT');
      } else durable(target, bytes, true);
    },
    bootstrap: (preparation) => {
      assertFullOwned();
      if (Date.now() >= Date.parse(op.expiresAt)) r1Stop('EXPIRED');
      sql(r1TailAclTransaction(preparation, 'bootstrap', plan.preimage.security), false);
    },
    cleanup: (preparation, state) => {
      assertOwned();
      if (r1Same(state.security, preparation.preimage)) return;
      assertFullOwned();
      sql(r1TailAclTransaction(preparation, 'cleanup', state.security), false);
    },
    roleProof: () => {
      assertOwned();
      if (lookup(op, 'role', operationSha)) r1Stop('ROLE_PROBE_USED');
      const id = docker(containerArgs(op, operationSha, 'role')).trim();
      if (!HASH.test(id)) r1Stop('ROLE_CONTAINER_ID');
      validateContainer(op, inspect(id), 'role', operationSha);
      assertOwned();
      if (Date.now() >= Date.parse(op.expiresAt)) r1Stop('EXPIRED');
      docker(['start', id]);
      const exit = docker(['wait', id]).trim(),
        row = validateContainer(op, inspect(id), 'role', operationSha);
      if (
        exit !== '0' ||
        row.State.Status !== 'exited' ||
        row.State.ExitCode !== 0 ||
        docker(['logs', id]).trim() !== 'R1_TAIL_ROLE_VERIFIED'
      )
        r1Stop('ROLE_PROOF');
      durable(
        path('role-proof.json'),
        r1Encode({
          containerId: id,
          operationSha256: operationSha,
          sourceSha256: r1Hash(ROLE_SOURCE),
        }),
        true,
      );
    },
    create: () => {
      assertFullOwned();
      if (Date.now() >= Date.parse(op.expiresAt)) r1Stop('EXPIRED');
      const id = docker(containerArgs(op, operationSha, 'migration')).trim();
      validateContainer(op, inspect(id), 'migration', operationSha);
      return id;
    },
    start: (id) => {
      assertFullOwned();
      validateContainer(op, inspect(id), 'migration', operationSha);
      if (Date.now() >= Date.parse(op.expiresAt)) r1Stop('EXPIRED');
      docker(['start', id]);
    },
    wait: (id) => {
      docker(['wait', id], { timeout: R1_TAIL.budgets.attemptMs + 60000 });
    },
    lookup: () => {
      const row = lookup(op, 'migration', operationSha);
      return row ? { id: row.Id, status: row.State.Status, exitCode: row.State.ExitCode } : null;
    },
    success: (bytes) => {
      if (present(paths.success)) {
        if (!read(paths.success).equals(bytes)) r1Stop('SUCCESS_DRIFT');
      } else durable(paths.success, bytes, true);
    },
    release: () => {
      allowPartial = true;
      assertOwned();
      custody.release();
    },
    assertResume: () => {
      const previousRoot = r1TailPaths({ attemptId: op.resume.attemptId }).root;
      const previousBytes = read(previousRoot + '/request.json'),
        previous = validateR1TailOperation(parseStrictJson(previousBytes));
      const terminalBytes = read(previousRoot + '/migration-receipt.json'),
        terminal = parseStrictJson(terminalBytes);
      const capsule = parseStrictJson(read(previousRoot + '/preparation.json'));
      r1Exact(capsule, ['operation', 'plan']);
      const previousPlanBytes = Buffer.from(capsule.plan, 'base64');
      const previousPlan = parseStrictJson(previousPlanBytes),
        cleanupBytes = read(previousRoot + '/cleanup.json'),
        cleanup = parseStrictJson(cleanupBytes);
      if (
        previous.attemptId !== op.resume.attemptId ||
        capsule.operation !== previousBytes.toString('base64') ||
        previousPlanBytes.toString('base64') !== capsule.plan ||
        !read(previousRoot + '/plan.json').equals(previousPlanBytes) ||
        terminal.schema !== 'PHUB_R1_TAIL_RECEIPT_V1' ||
        terminal.operationSha256 !== r1Hash(previousBytes) ||
        terminal.planSha256 !== r1Hash(previousPlanBytes) ||
        previousPlan.operationSha256 !== r1Hash(previousBytes) ||
        terminal.stateSha256 !== r1Hash(cleanupBytes) ||
        previous.expectedSecretsSha256 !== op.expectedSecretsSha256
      )
        r1Stop('RESUME_CAPSULE');
      validateR1TailPreparation(previousPlan.preparation, previousPlan.preimage.security);
      validateR1TailState(previous, cleanup, 'cleaned', op.fromCount);
      if (!r1Same(cleanup.security, previousPlan.preparation.preimage)) r1Stop('RESUME_CLEANUP');

      if (
        r1Hash(previousBytes) !== op.resume.operationSha256 ||
        r1Hash(terminalBytes) !== op.resume.receiptSha256 ||
        terminal.status !== 'PARTIAL' ||
        terminal.count !== op.fromCount ||
        previous.fromCount >= op.fromCount ||
        !r1Same(previous.publishedMigrator, op.publishedMigrator) ||
        previous.catalogsSha256 !== op.catalogsSha256 ||
        previous.previousMigrationSuccess.sha256 !== op.previousMigrationSuccess.sha256 ||
        !r1Same(previous.expectedApi, op.expectedApi) ||
        !r1Same(previous.expectedWorker, op.expectedWorker) ||
        !r1Same(previous.expectedPostgres, op.expectedPostgres)
      )
        r1Stop('RESUME_BINDING');
      const row = lookup(previous, 'migration', r1Hash(previousBytes));
      if (
        !row ||
        row.Id !== terminal.containerId ||
        row.State.Status !== 'exited' ||
        row.State.ExitCode === 0
      )
        r1Stop('RESUME_CONTAINER');
      readBackup(previous, false);
    },
  };
}
function prefetchPaths(op) {
  return { root: `${ROOT}/standard/r1-tail-prefetch/${op.attemptId}`, request: PREFETCH_REQUEST };
}
function validatePrefetch(value, at) {
  r1Exact(value, ['schema', 'migrationIntent', 'expiresAt', 'confirmation']);
  validateR1TailOperation(value.migrationIntent);
  const expiry = Date.parse(value.expiresAt);
  if (
    value.schema !== 'PHUB_R1_TAIL_PREFETCH_V1' ||
    value.confirmation !== 'PREFETCH_R1_TAIL_ONLY_NO_DATABASE_WRITE' ||
    !Number.isFinite(expiry) ||
    new Date(expiry).toISOString() !== value.expiresAt ||
    (at !== undefined && (expiry - at < 1200000 || expiry - at > 3600000))
  )
    r1Stop('PREFETCH_AUTHORITY');
  return value;
}
function prefetchBinding(op) {
  const { backup: _, expiresAt: __, confirmation: ___, ...binding } = op;
  return binding;
}
function readPrefetch(op) {
  const paths = prefetchPaths(op),
    raw = read(paths.root + '/request.json'),
    request = validatePrefetch(parseStrictJson(raw));
  const intentBytes = read(paths.root + '/intent.json'),
    intent = parseStrictJson(intentBytes),
    receiptBytes = read(paths.root + '/receipt.json'),
    receipt = parseStrictJson(receiptBytes);
  r1Exact(intent, [
    'schema',
    'requestSha256',
    'migrationBindingSha256',
    'runtimeSha256',
    'secretSetSha256',
    'retainedImageIds',
  ]);
  r1Exact(receipt, [
    'schema',
    'requestSha256',
    'intentSha256',
    'migrationBindingSha256',
    'imageId',
  ]);
  if (
    !r1Same(prefetchBinding(op), prefetchBinding(request.migrationIntent)) ||
    intent.schema !== 'PHUB_R1_TAIL_PREFETCH_INTENT_V1' ||
    intent.requestSha256 !== r1Hash(raw) ||
    intent.migrationBindingSha256 !== r1TailBackupBindingHash(op) ||
    receipt.schema !== 'PHUB_R1_TAIL_PREFETCH_RECEIPT_V1' ||
    receipt.requestSha256 !== r1Hash(raw) ||
    receipt.intentSha256 !== r1Hash(intentBytes) ||
    receipt.migrationBindingSha256 !== r1TailBackupBindingHash(op) ||
    receipt.imageId !== op.publishedMigrator.imageId ||
    !Array.isArray(intent.retainedImageIds) ||
    intent.retainedImageIds.some((id) => !/^sha256:[a-f0-9]{64}$/.test(id)) ||
    !r1Same(intent.retainedImageIds, [...new Set(intent.retainedImageIds)].sort())
  )
    r1Stop('PREFETCH_PROOF');
  return {
    intent,
    reference: {
      requestSha256: r1Hash(raw),
      receiptSha256: r1Hash(receiptBytes),
      migratorImage: op.publishedMigrator.image,
      imageId: op.publishedMigrator.imageId,
    },
  };
}
export async function attestR1TailMigratorPrefetchForBackup(backup) {
  attestR1TailBackupSource(backup);
  const op = backup.migrationIntent,
    proof = readPrefetch(op);
  if (
    [ACTIVE, PROVISION, r1TailPaths(op).root].some(present) ||
    !r1Same(proof.reference, backup.migratorPrefetch) ||
    r1Hash(r1Encode(runtime(op))) !== proof.intent.runtimeSha256 ||
    r1Hash(r1Encode(describeTimewebRuntimeSecretSet(RUNTIME))) !== proof.intent.secretSetSha256 ||
    image(op).Id !== proof.reference.imageId
  )
    r1Stop('PREFETCH_BACKUP_DRIFT');
  const images = docker(['image', 'ls', '-aq', '--no-trunc']).trim().split('\n');
  if (!proof.intent.retainedImageIds.every((id) => images.includes(id)))
    r1Stop('PREFETCH_RETAINED_IMAGE');
  predecessor(op);
  readR1TailBackupDatabaseState(backup);
  return proof.reference;
}
export function attestR1TailRetainedBackupSource(backup, tail, dependencies = deps) {
  attestR1TailSource(tail, dependencies);
  validateR1TailBackupOperation(backup);
  let consumer = tail;
  if (!r1Same(prefetchBinding(backup.migrationIntent), prefetchBinding(tail))) {
    if (!tail.resume) r1Stop('RETAINED_BACKUP_CONSUMER');
    const root = r1TailPaths({ attemptId: tail.resume.attemptId }).root;
    const raw = dependencies.read(root + '/request.json');
    consumer = validateR1TailOperation(parseStrictJson(raw));
    const terminalBytes = dependencies.read(root + '/migration-receipt.json'),
      terminal = parseStrictJson(terminalBytes);
    if (
      r1Hash(raw) !== tail.resume.operationSha256 ||
      r1Hash(terminalBytes) !== tail.resume.receiptSha256 ||
      terminal.status !== 'PARTIAL' ||
      terminal.count !== tail.fromCount ||
      !r1Same(prefetchBinding(consumer), prefetchBinding(backup.migrationIntent))
    )
      r1Stop('RETAINED_BACKUP_RESUME');
  }
  if (consumer.backup.operationPath !== r1TailBackupDirectory(backup) + '/backup-operation.json')
    r1Stop('RETAINED_BACKUP_PATH');
  return true;
}
export async function runR1TailPrefetch(mode, requestPath) {
  if (
    !['prefetch', 'attest-prefetch', 'reconcile-prefetch'].includes(mode) ||
    requestPath !== PREFETCH_REQUEST ||
    process.getuid?.() !== 0
  )
    r1Stop('PREFETCH_ENTRY');
  assertNoAmbientComposeOverrides();
  assertNoAmbientDockerOverrides();
  secure(`${ROOT}/standard`, 0o700);
  const raw = read(requestPath),
    request = validatePrefetch(parseStrictJson(raw), mode === 'prefetch' ? Date.now() : undefined),
    op = request.migrationIntent;
  const owner = acquireApiWorkerExecutor(`${ROOT}/standard/api-worker-executor.lock`),
    paths = prefetchPaths(op);
  try {
    owner.assertOwned();
    attestR1TailSource(op, deps);
    predecessor(op);
    if ([ACTIVE, PROVISION, r1TailPaths(op).root].some(present)) r1Stop('PREFETCH_EXCLUSION');
    const runtimeSha256 = r1Hash(r1Encode(runtime(op))),
      secretSetSha256 = r1Hash(r1Encode(describeTimewebRuntimeSecretSet(RUNTIME)));
    if (runtimeSha256 !== op.expectedRuntimeSha256 || secretSetSha256 !== op.expectedSecretsSha256)
      r1Stop('PREFETCH_PREIMAGE');
    validateR1TailState(op, sql(R1_TAIL_STATE_SQL), 'cleaned', op.fromCount);
    if (mode === 'prefetch') {
      if (present(paths.root)) r1Stop('PREFETCH_USE_RECONCILE');
      await authority(op);
      mkdir(`${ROOT}/standard/r1-tail-prefetch`);
      mkdir(paths.root);
      const retainedImageIds = [
        ...new Set(docker(['image', 'ls', '-aq', '--no-trunc']).trim().split('\n').filter(Boolean)),
      ].sort();
      if (retainedImageIds.some((id) => !/^sha256:[a-f0-9]{64}$/.test(id)))
        r1Stop('PREFETCH_IMAGE_INVENTORY');
      durable(paths.root + '/request.json', raw, true);
      durable(
        paths.root + '/intent.json',
        r1Encode({
          schema: 'PHUB_R1_TAIL_PREFETCH_INTENT_V1',
          requestSha256: r1Hash(raw),
          migrationBindingSha256: r1TailBackupBindingHash(op),
          runtimeSha256,
          secretSetSha256,
          retainedImageIds,
        }),
        true,
      );
      owner.assertOwned();
      if (Date.now() >= Date.parse(request.expiresAt)) r1Stop('PREFETCH_EXPIRED');
      docker(['pull', op.publishedMigrator.image], { timeout: 300000 });
      owner.assertOwned();
      if (Date.now() >= Date.parse(request.expiresAt)) r1Stop('PREFETCH_EXPIRED');
      docker(['pull', `ghcr.io/z6v6e6r/phub-migrator@${op.publishedMigrator.imageId}`], {
        timeout: 300000,
      });
    }
    // Neither reconciliation nor attestation repeats an image pull.
    const intentBytes = read(paths.root + '/intent.json'),
      intent = parseStrictJson(intentBytes);
    if (
      !read(paths.root + '/request.json').equals(raw) ||
      intent.runtimeSha256 !== runtimeSha256 ||
      intent.secretSetSha256 !== secretSetSha256 ||
      image(op).Id !== op.publishedMigrator.imageId ||
      r1Hash(r1Encode(runtime(op))) !== runtimeSha256 ||
      r1Hash(r1Encode(describeTimewebRuntimeSecretSet(RUNTIME))) !== secretSetSha256
    )
      r1Stop('PREFETCH_DRIFT');
    const receipt = r1Encode({
      schema: 'PHUB_R1_TAIL_PREFETCH_RECEIPT_V1',
      requestSha256: r1Hash(raw),
      intentSha256: r1Hash(intentBytes),
      migrationBindingSha256: r1TailBackupBindingHash(op),
      imageId: op.publishedMigrator.imageId,
    });
    owner.assertOwned();
    if (present(paths.root + '/receipt.json')) {
      if (!read(paths.root + '/receipt.json').equals(receipt)) r1Stop('PREFETCH_RECEIPT_DRIFT');
    } else if (mode === 'attest-prefetch') r1Stop('PREFETCH_RECEIPT_MISSING');
    else durable(paths.root + '/receipt.json', receipt, true);
    return {
      status: 'R1_TAIL_PREFETCH_VERIFIED',
      ...readPrefetch(op).reference,
      databaseMutated: false,
      runtimeMutated: false,
    };
  } finally {
    owner.close();
  }
}
export async function runR1TailHost(mode, requestPath) {
  if (
    !['deploy', 'reconcile'].includes(mode) ||
    requestPath !== R1_TAIL_REQUEST ||
    process.getuid?.() !== 0
  )
    r1Stop('ENTRY');
  assertNoAmbientComposeOverrides();
  assertNoAmbientDockerOverrides();
  secure(`${ROOT}/standard`, 0o700);
  const raw = read(requestPath),
    op = validateR1TailOperation(parseStrictJson(raw));
  const owner = acquireApiWorkerExecutor(`${ROOT}/standard/api-worker-executor.lock`);
  try {
    return await runR1TailAdapter(mode, raw, createEffects(op, owner));
  } finally {
    owner.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(
      JSON.stringify(
        await (
          ['prefetch', 'attest-prefetch', 'reconcile-prefetch'].includes(process.argv[2])
            ? runR1TailPrefetch
            : runR1TailHost
        )(...process.argv.slice(2)),
      ) + '\n',
    );
  } catch (error) {
    const code = /^R1_TAIL_[A-Z0-9_]+$/.test(error?.message ?? '')
      ? error.message
      : 'R1_TAIL_UNEXPECTED_FAILURE';
    process.stdout.write(JSON.stringify({ status: 'STOP', code, replayAllowed: false }) + '\n');
    process.exitCode = 1;
  }
}
