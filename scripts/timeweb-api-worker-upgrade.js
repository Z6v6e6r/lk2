import {
  NOTIFICATION_ROLLOUT_SCHEMA,
  assertNotificationRuntimeOff,
  validateNotificationManifest,
  attestNotificationSource,
  NOTIFICATION_OBSERVATION_POLICY,
  NOTIFICATION_OBSERVATION_POLICY_SHA256,
  validateNotificationObservation,
} from './timeweb-notification-profile.js';
import { readNotificationMigrationProof } from './timeweb-api-worker-migration.js';
// One explicit API+Worker mode of the enrolled controller, frozen to the reviewed Android bridge.
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  mkdirSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
  constants,
  fstatSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { parseStrictJson } from './strict-json.js';
import {
  readControllerSourceAuthority,
  assertControllerPromotionGitConfig,
} from './verify-source-ci.js';
import {
  secureUpgradePath as secure,
  readUpgradeFile as read,
  upgradeGit as git,
  upgradeDocker as docker,
  validateUpgradeCandidateAuthority as candidateAuthority,
  assertUpgradeImagePresent as imagePresent,
  validateUpgradeBackup as backupProof,
  readUpgradeMonitoring as monitoring,
  readInstalledApiBaseline,
  githubPublic,
  writeUpgradeAtomic as durable,
} from './timeweb-api-web-upgrade.js';
import {
  describeTimewebRuntimeSecretSet as secretSet,
  validateTimewebFcmSecretDelta,
  transitionPreparedTimewebRuntimeSecrets,
} from './provision-timeweb-beta-runtime-secrets.js';
import {
  timewebFcmCredentialSource,
  assertNoAmbientComposeOverrides,
  assertNoAmbientDockerOverrides,
} from './render-timeweb-beta-release-env.js';

const ROOT = '/opt/phub/timeweb-beta',
  SOURCE = `${ROOT}/standard/source`;
const REQUEST = `${ROOT}/operator/api-worker-upgrade.json`,
  LOCK = `${ROOT}/standard/active`;
const RUNTIME = '/etc/phub/timeweb-beta',
  PROVISION_LOCK = '/etc/phub/.timeweb-beta.provision.lock';
const COMPOSE = `${SOURCE}/deploy/timeweb/compose.beta.yaml`;
const HASH = /^[a-f0-9]{64}$/;
const hash = (v) => createHash('sha256').update(v).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code) => {
  throw new Error(`API_WORKER_${code}`);
};
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
function pathPresent(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
import {
  API_WORKER_BRIDGE,
  exact,
  validateApiWorkerOperation,
  validateApiWorkerControllerDelta,
  parseApiWorkerControllerDiff,
  API_WORKER_CI_DOWNLOAD_PATCH,
  API_WORKER_CI_READER_PATCH,
  API_WORKER_CONTROLLER_PROMOTION_PATCH,
  API_WORKER_ANDROID_CHAT_TEST_PATCH,
  sameApiWorkerDeploymentIdentity,
  validateApiWorkerLedger,
  validateApiWorkerReceipt,
  assertPlan,
} from './timeweb-api-worker-contract.js';
export {
  API_WORKER_BRIDGE,
  validateApiWorkerOperation,
  validateApiWorkerControllerDelta,
  parseApiWorkerControllerDiff,
  API_WORKER_CI_DOWNLOAD_PATCH,
  API_WORKER_CI_READER_PATCH,
  API_WORKER_CONTROLLER_PROMOTION_PATCH,
  API_WORKER_ANDROID_CHAT_TEST_PATCH,
  sameApiWorkerDeploymentIdentity,
  validateApiWorkerLedger,
  validateApiWorkerReceipt,
  validateInstalledApiWorkerEvidence,
} from './timeweb-api-worker-contract.js';
export function apiWorkerComposeArgs(baseline, overlay, action, service) {
  if (!['api', 'worker'].includes(service) || !['pull', 'up'].includes(action)) fail('STAGE');
  return [
    'compose',
    '--env-file',
    baseline,
    '--env-file',
    overlay,
    '-f',
    COMPOSE,
    ...(service === 'worker' ? ['--profile', 'background'] : []),
    ...(action === 'pull' ? ['pull', service] : ['up', '-d', '--no-deps', service]),
  ];
}
export function apiWorkerSmokeArgs(service, image) {
  if (
    !['api', 'worker'].includes(service) ||
    !new RegExp(`^ghcr\\.io/z6v6e6r/phub-${service}@sha256:[a-f0-9]{64}$`).test(image)
  )
    fail('SMOKE');
  return [
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--entrypoint',
    'node',
    image,
    '--check',
    `/app/apps/${service}/dist/main.js`,
  ];
}
export async function runApiWorkerTransition(ops) {
  let intent = false;
  try {
    await ops.preflight();
    await ops.pullAndSmoke();
    await ops.journal('PREPARED');
    intent = true;
    await ops.journal('WORKER_STOP_INTENT');
    await ops.containWorker();
    await ops.journal('WORKER_STOPPED');
    if (ops.secretMode === 'preserve') {
      await ops.installSecrets();
      await ops.journal('SECRETS_VERIFIED');
    } else {
      await ops.journal('SECRET_SWAP_INTENT');
      await ops.installSecrets();
      await ops.journal('SECRETS_ACTIVE');
    }
    await ops.journal('API_INTENT');
    await ops.activate('api');
    await ops.journal('API_ACTIVE');
    await ops.journal('WORKER_INTENT');
    await ops.activate('worker');
    await ops.journal('WORKER_ACTIVE');
    await ops.journal('OBSERVING');
    await ops.observe();
    await ops.attestCandidate();
    await ops.journal('BASELINE_INTENT');
    await ops.installBaseline();
    await ops.journal('GATE_RELEASE_INTENT');
    await ops.releaseFence();
    await ops.journal('SUCCESS');
  } catch (error) {
    if (intent) await recoverApiWorkerTransition(ops);
    else {
      await ops.attestPrevious();
      await ops.journal('ABORTED');
    }
    throw error;
  }
}
export async function recoverApiWorkerTransition(ops) {
  try {
    await ops.journal('ROLLBACK_INTENT');
    // Failure to contain Worker blocks every secret/API mutation; never resume an uncontained sender.
    await ops.containWorker();
    await ops.journal('WORKER_CONTAINED');
    await ops.restoreSecrets();
    await ops.journal(
      ops.secretMode === 'preserve' ? 'PREVIOUS_SECRETS_VERIFIED' : 'PREVIOUS_SECRETS',
    );
    await ops.restore('api');
    await ops.restore('worker');
    await ops.removeCandidateBaseline();
    await ops.attestPrevious();
    await ops.journal('ROLLED_BACK');
  } catch {
    await ops.journal('ROLLBACK_FAILED');
    fail('ROLLBACK_FAILED');
  }
}
export async function recoverApiWorkerPhase(phase, ops) {
  if (['PREPARING', 'PREPARED'].includes(phase)) {
    await ops.attestPrevious();
    await ops.journal('ABORTED');
    return 'ABORTED';
  }
  if (
    ![
      'WORKER_STOP_INTENT',
      'WORKER_STOPPED',
      'SECRET_SWAP_INTENT',
      'SECRETS_ACTIVE',
      ...(ops.secretMode === 'preserve' ? ['SECRETS_VERIFIED', 'PREVIOUS_SECRETS_VERIFIED'] : []),
      'API_INTENT',
      'API_ACTIVE',
      'WORKER_INTENT',
      'WORKER_ACTIVE',
      'OBSERVING',
      'BASELINE_INTENT',
      'GATE_RELEASE_INTENT',
      'ROLLBACK_INTENT',
      'WORKER_CONTAINED',
      'PREVIOUS_SECRETS',
      'ROLLBACK_FAILED',
    ].includes(phase)
  )
    fail('RECOVERY_PHASE');
  await recoverApiWorkerTransition(ops);
  return 'ROLLED_BACK';
}
// One persistent READ COMMITTED/READ ONLY session holds the canonical operator advisory locks.
// New tenant creation and out-of-band SQL are excluded by the operation contract, not by this lock.
export function openApiWorkerDatabaseFence(container, spawnChild = spawn, notificationPostgres) {
  if (
    notificationPostgres
      ? container !== notificationPostgres.id
      : container !== API_WORKER_BRIDGE.postgresId
  )
    fail('POSTGRES');
  const shell =
    'export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000"; exec psql -X --no-password --username="$POSTGRES_USER" --dbname="${POSTGRES_DB:-$POSTGRES_USER}" --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1';
  const child = spawnChild(
    '/usr/bin/docker',
    ['exec', '-i', container, '/bin/sh', '-eu', '-c', shell],
    { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let pending = null,
    buffer = Buffer.alloc(0),
    alive = true,
    started = false;
  const stop = () => {
    alive = false;
    if (pending) {
      const current = pending;
      pending = null;
      clearTimeout(current.timer);
      current.reject(new Error('API_WORKER_DATABASE_FENCE_LOST'));
    }
  };
  child.on('error', stop);
  child.on('exit', stop);
  child.stdin.on('error', stop);
  child.stdout.on('error', stop);
  child.stderr.on('error', stop);
  child.stderr.on('data', () => {});
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 131072) {
      stop();
      child.kill();
      return;
    }
    while (buffer.includes(10)) {
      const split = buffer.indexOf(10),
        line = buffer.subarray(0, split);
      buffer = buffer.subarray(split + 1);
      if (!line.length) continue;
      try {
        const value = parseStrictJson(line);
        exact(value, ['nonce', 'result']);
        if (!pending || value.nonce !== pending.nonce) fail('DATABASE_PROTOCOL');
        const current = pending;
        pending = null;
        clearTimeout(current.timer);
        current.resolve(value.result);
      } catch {
        stop();
        child.kill();
        return;
      }
    }
  });
  const query = (sql) =>
    new Promise((resolve, reject) => {
      if (!alive || pending) {
        reject(new Error('API_WORKER_DATABASE_FENCE_LOST'));
        return;
      }
      const nonce = randomBytes(12).toString('hex');
      const timer = setTimeout(() => {
        stop();
        child.kill();
      }, 8000);
      pending = { nonce, resolve, reject, timer };
      child.stdin.write(
        `${!started ? 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY;\n' : ''}SELECT json_build_object('nonce','${nonce}','result',( ${sql} ))::text;\n`,
      );
      started = true;
    });
  return {
    query,
    assertAlive: () => {
      if (!alive) fail('DATABASE_FENCE_LOST');
    },
    commit: () =>
      new Promise((resolve, reject) => {
        if (!alive || pending) {
          reject(new Error('API_WORKER_DATABASE_FENCE_LOST'));
          return;
        }
        let done = false;
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            child.kill();
            reject(new Error('API_WORKER_DATABASE_COMMIT_UNKNOWN'));
          }
        }, 8000);
        child.once('exit', (code) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          code === 0 ? resolve() : reject(new Error('API_WORKER_DATABASE_COMMIT_UNKNOWN'));
        });
        child.stdin.end('COMMIT;\n\\q\n');
      }),
    close: () => {
      child.kill();
    },
  };
}
export const API_WORKER_GATE_LOCK_SQL = `SELECT json_build_object('locksAcquired',coalesce(bool_and(runtime_lock AND provider_lock),false),'tenantCount',count(*),'tenantFingerprint',md5(coalesce(string_agg(id::text,',' ORDER BY id),''))) FROM (SELECT id,pg_try_advisory_xact_lock(hashtextextended('notification-runtime:'||id::text,0)) runtime_lock,pg_try_advisory_xact_lock(hashtextextended('android-push-provider:'||id::text||':ru.padlhub.app:SANDBOX',0)) provider_lock FROM identity.tenants ORDER BY id) locks`;
export const API_WORKER_DATABASE_SQL = `SELECT json_build_object(
 'backendPid',pg_backend_pid(),'transactionStartedAt',(SELECT xact_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()),'readOnly',current_setting('transaction_read_only'),
 'superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),'bypassRls',(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user),
 'tenantCount',(SELECT count(*) FROM identity.tenants),'tenantFingerprint',(SELECT md5(coalesce(string_agg(id::text,',' ORDER BY id),'')) FROM identity.tenants),
 'androidEnabledTenants',(SELECT count(*) FROM notifications.tenant_runtime_settings WHERE android_push_enabled),
 'activeProviders',(SELECT count(*) FROM integration.notification_provider_accounts WHERE channel='PUSH' AND platform='ANDROID' AND provider='FCM' AND app_id='ru.padlhub.app' AND environment='SANDBOX' AND status='ACTIVE'),
 'liveLeases',(SELECT count(*) FROM notifications.deliveries d JOIN integration.notification_endpoints e ON e.tenant_id=d.tenant_id AND e.id=d.endpoint_id JOIN integration.notification_provider_accounts a ON a.tenant_id=e.tenant_id AND a.id=e.provider_account_id WHERE d.channel='PUSH' AND d.state='SENDING' AND d.lease_expires_at>now() AND a.platform='ANDROID' AND a.provider='FCM' AND a.app_id='ru.padlhub.app' AND a.environment='SANDBOX'),
 'ledger',(SELECT coalesce(json_agg(json_build_object('filename',filename,'checksum',checksum) ORDER BY filename),'[]'::json) FROM public.schema_migrations))`;
export function validateApiWorkerDatabase(value, packaged, initial, operation) {
  exact(value, [
    'backendPid',
    'transactionStartedAt',
    'readOnly',
    'superuser',
    'bypassRls',
    'tenantCount',
    'tenantFingerprint',
    'androidEnabledTenants',
    'activeProviders',
    'liveLeases',
    'ledger',
  ]);
  if (
    !Number.isSafeInteger(value.backendPid) ||
    value.backendPid < 1 ||
    !Number.isFinite(Date.parse(value.transactionStartedAt)) ||
    value.readOnly !== 'on' ||
    value.superuser !== true ||
    value.bypassRls !== true ||
    !Number.isSafeInteger(value.tenantCount) ||
    value.tenantCount < 1 ||
    !/^[a-f0-9]{32}$/.test(value.tenantFingerprint ?? '') ||
    value.androidEnabledTenants !== 0 ||
    value.activeProviders !== 0 ||
    value.liveLeases !== 0
  )
    fail('DATABASE_SAFETY');
  validateApiWorkerLedger(value.ledger, packaged, operation);
  if (
    initial &&
    ['backendPid', 'transactionStartedAt', 'tenantCount', 'tenantFingerprint'].some(
      (k) => value[k] !== initial[k],
    )
  )
    fail('DATABASE_DRIFT');
  return value;
}

function inspectService(service) {
  const ids = docker([
    'ps',
    '-aq',
    '--no-trunc',
    '--filter',
    'label=com.docker.compose.project=phub-timeweb-beta',
    '--filter',
    `label=com.docker.compose.service=${service}`,
  ])
    .trim()
    .split('\n')
    .filter(Boolean);
  if (ids.length !== 1) fail('SERVICE_COUNT');
  const v = JSON.parse(docker(['container', 'inspect', ids[0]]))[0];
  return {
    identity: {
      id: v.Id,
      image: v.Config.Image,
      imageId: v.Image,
      releaseId: v.Config.Labels['phub.release-id'] ?? null,
      revision: v.Config.Labels['org.opencontainers.image.revision'] ?? null,
      restarts: v.RestartCount,
      startedAt: v.State.StartedAt,
    },
    status: v.State.Status,
    health: v.State.Health?.Status ?? null,
    mounts: v.Mounts,
    configHash: v.Config.Labels['com.docker.compose.config-hash'] ?? null,
  };
}
function excluded() {
  const ids = docker(['ps', '-q', '--no-trunc']).trim().split('\n').filter(Boolean);
  return ids
    .map((id) => JSON.parse(docker(['container', 'inspect', id]))[0])
    .filter(
      (v) =>
        !(
          v.Config.Labels['com.docker.compose.project'] === 'phub-timeweb-beta' &&
          ['api', 'worker'].includes(v.Config.Labels['com.docker.compose.service'])
        ),
    )
    .map((v) => {
      if (v.Config.Labels['com.docker.compose.service'] === 'migrator') fail('ACTIVE_MIGRATOR');
      return {
        id: v.Id,
        image: v.Config.Image,
        imageId: v.Image,
        restarts: v.RestartCount,
        startedAt: v.State.StartedAt,
        status: v.State.Status,
        health: v.State.Health?.Status ?? null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
function credentialMetadata(directory = RUNTIME) {
  const path = timewebFcmCredentialSource(directory);
  if (path !== '/etc/phub/timeweb-beta-fcm/fcm-service-account.json') fail('FCM_CREDENTIAL');
  return Object.fromEntries(
    [dirname(path), path].map((p) => {
      secure(dirname(p));
      const s = lstatSync(p);
      return [
        p,
        {
          device: s.dev,
          inode: s.ino,
          uid: s.uid,
          gid: s.gid,
          mode: s.mode,
          links: s.nlink,
          size: s.size,
          mtime: s.mtimeMs,
          ctime: s.ctimeMs,
        },
      ];
    }),
  );
}
export function validateApiWorkerMount(
  mounts,
  source = '/etc/phub/timeweb-beta-fcm/fcm-service-account.json',
) {
  const value = mounts.filter((v) => v.Destination === '/run/phub/fcm-service-account.json');
  if (
    value.length !== 1 ||
    value[0].Type !== 'bind' ||
    value[0].Source !== source ||
    value[0].RW !== false
  )
    fail('WORKER_MOUNT');
}
export function overlay(plan, side, service) {
  const value = plan[side][service];
  return `PHUB_RELEASE_ID=${service === 'worker' ? (side === 'previous' ? plan.previous.api.releaseId : plan.candidate.api.releaseId) : value.releaseId}\n${service.toUpperCase()}_IMAGE_DIGEST=${value.image.split('@')[1]}\n${service === 'worker' ? `TIMEWEB_FCM_CREDENTIAL_SOURCE=${plan.schema === 'PHUB_TIMEWEB_NOTIFICATION_0105_ROLLOUT_PLAN_V2' ? plan.fcmCredentialSource : side === 'previous' ? '/dev/null' : '/etc/phub/timeweb-beta-fcm/fcm-service-account.json'}\n` : ''}`;
}
function releaseFile(path, bytes) {
  if (!read(path).equals(Buffer.from(bytes))) fail('LOCK_DRIFT');
  unlinkSync(path);
  const fd = openSync(dirname(path), 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
async function probe(service) {
  const response = await fetch(
    `http://172.30.26.${service === 'api' ? '12:3000' : '14:3002'}/health/ready`,
    { redirect: 'error', signal: AbortSignal.timeout(10000) },
  );
  const value = parseStrictJson(await response.text());
  if (response.status !== 200 || value.status !== 'ready') fail('READINESS');
}
export async function probeNotificationPublicReadiness() {
  const result = {};
  for (const [service, url] of [
    ['Api', 'https://lk2.padlhub.su/health/ready'],
    ['Web', 'https://lk2.padlhub.su/'],
  ]) {
    const started = performance.now();
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    const body = await response.text();
    if (
      response.status !== 200 ||
      (service === 'Api'
        ? parseStrictJson(body).status !== 'ready'
        : !body.includes('<div id="phub-app"></div>'))
    )
      fail('PUBLIC_READINESS');
    result['public' + service + 'Ms'] = performance.now() - started;
  }
  return result;
}
export async function observeNotificationRollout({
  attest,
  operationSha256,
  planSha256,
  probePublic = probeNotificationPublicReadiness,
  now = Date.now,
  sleep = delay,
}) {
  const startedAt = new Date(now()).toISOString(),
    samples = [];
  for (let i = 0; i < 61; i++) {
    await attest();
    const timings = await probePublic();
    samples.push({ observedAt: new Date(now()).toISOString(), ...timings });
    if (i < 60) await sleep(15000);
  }
  const value = {
    schema: 'PHUB_TIMEWEB_NOTIFICATION_0105_OBSERVATION_V2',
    operationSha256,
    planSha256,
    observationPolicy: NOTIFICATION_OBSERVATION_POLICY,
    startedAt,
    completedAt: new Date(now()).toISOString(),
    samples,
    providerActivation: false,
    deviceDelivery: false,
  };
  return validateNotificationObservation(value, operationSha256, planSha256);
}
async function waitService(service, expected, profile) {
  for (let i = 0; i < 45; i++) {
    const value = inspectService(service);
    if (
      value.identity.image !== expected.image ||
      value.identity.revision !== expected.revision ||
      value.identity.releaseId !== expected.releaseId ||
      value.identity.imageId !== localImageId(expected.image) ||
      (profile !== 'beta' && value.identity.restarts !== 0)
    )
      fail('RUNTIME_IDENTITY');
    if (value.status === 'running' && value.health === 'healthy') {
      await probe(service);
      return value;
    }
    await delay(2000);
  }
  fail('READINESS_TIMEOUT');
}
function localImageId(image) {
  const v = JSON.parse(docker(['image', 'inspect', image]))[0];
  if (!/^sha256:[a-f0-9]{64}$/.test(v.Id ?? '')) fail('IMAGE_ID');
  return v.Id;
}
export function acquireApiWorkerExecutor(
  path,
  expectedUid = 0,
  expectedGid = 0,
  run = execFileSync,
) {
  let fd,
    created = false;
  try {
    fd = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  }
  try {
    const identity = fstatSync(fd),
      at = lstatSync(path);
    if (
      !identity.isFile() ||
      identity.uid !== expectedUid ||
      identity.gid !== expectedGid ||
      identity.nlink !== 1 ||
      (identity.mode & 0o777) !== 0o600 ||
      identity.size !== 0 ||
      identity.dev !== at.dev ||
      identity.ino !== at.ino
    )
      fail('EXECUTOR_SECURITY');
    if (created) {
      fsyncSync(fd);
      const parent = openSync(dirname(path), 'r');
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    }
    run('/usr/bin/flock', ['--nonblock', '3'], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
      stdio: ['ignore', 'pipe', 'pipe', fd],
      timeout: 10000,
    });
    const assertOwned = () => {
      const current = lstatSync(path);
      if (
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        current.nlink !== 1 ||
        current.uid !== expectedUid ||
        current.gid !== expectedGid ||
        (current.mode & 0o777) !== 0o600
      )
        fail('EXECUTOR_DRIFT');
    };
    assertOwned();
    return { assertOwned, close: () => closeSync(fd) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
export function validateApiWorkerBackupLedger(receipt, packaged) {
  validateApiWorkerLedger(packaged, packaged);
  const expected = hash(`${JSON.stringify(packaged.map((v) => [v.filename, v.checksum]))}\n`);
  if (
    receipt.sourceLedgerSha256 !== expected ||
    receipt.restoredLedgerSha256 !== expected ||
    receipt.restoreImage !== API_WORKER_BRIDGE.postgresImage
  )
    fail('BACKUP_LEDGER');
}
export function encodeApiWorkerCapsule(operationBytes, planBytes) {
  return `${JSON.stringify({ schema: 'PHUB_TIMEWEB_API_WORKER_CAPSULE_V1', operation: operationBytes.toString('base64'), plan: planBytes.toString('base64') })}\n`;
}
export function readApiWorkerCapsule(bytes) {
  const v = parseStrictJson(bytes);
  exact(v, ['schema', 'operation', 'plan']);
  if (v.schema !== 'PHUB_TIMEWEB_API_WORKER_CAPSULE_V1') fail('CAPSULE');
  const decode = (key) => {
    if (typeof v[key] !== 'string') fail('CAPSULE');
    const out = Buffer.from(v[key], 'base64');
    if (out.toString('base64') !== v[key]) fail('CAPSULE');
    return out;
  };
  const operationBytes = decode('operation'),
    planBytes = decode('plan'),
    op = validateApiWorkerOperation(parseStrictJson(operationBytes)),
    plan = parseStrictJson(planBytes);
  assertPlan(plan, op, operationBytes);
  return { operationBytes, planBytes, op, plan };
}

// Only a fully reconciled V2 operation can be re-read after its final lock unlink.
// This grants no write/restart authority; the caller still reattests runtime and evidence.
export function readNotificationTerminalCapsule(
  requestBytes,
  capsuleBytes,
  planBytes,
  operationBytes,
  receiptBytes,
) {
  const capsule = readApiWorkerCapsule(capsuleBytes);
  const receipt = validateApiWorkerReceipt(
    parseStrictJson(receiptBytes),
    hash(capsule.planBytes),
    capsule.op,
  );
  if (
    capsule.op.schema !== NOTIFICATION_ROLLOUT_SCHEMA ||
    !capsule.operationBytes.equals(requestBytes) ||
    !capsule.operationBytes.equals(operationBytes) ||
    !capsule.planBytes.equals(planBytes) ||
    receipt.status !== 'RECONCILED'
  )
    fail('TERMINAL_CUSTODY');
  return capsule;
}

function readOrphanAudits(transaction) {
  const operations = new Set();
  return readdirSync(transaction)
    .filter((name) => name.startsWith('orphan-abort-'))
    .map((name) => {
      const path = `${transaction}/${name}`,
        audit = parseStrictJson(read(path));
      exact(audit, [
        'schema',
        'status',
        'reconciledStatus',
        'runtimeMutated',
        'operationSha256',
        'planSha256',
        'capsuleSha256',
        'preparation',
        'observedAt',
      ]);
      const bytes = Buffer.from(audit.preparation, 'base64'),
        capsule = readApiWorkerCapsule(bytes);
      if (
        audit.schema !== 'PHUB_TIMEWEB_API_WORKER_ORPHAN_ABORT_V1' ||
        audit.status !== 'RECONCILED' ||
        audit.reconciledStatus !== 'ABORTED' ||
        audit.runtimeMutated !== false ||
        bytes.toString('base64') !== audit.preparation ||
        name !== `orphan-abort-${hash(bytes)}.json` ||
        audit.capsuleSha256 !== hash(bytes) ||
        audit.operationSha256 !== hash(capsule.operationBytes) ||
        audit.planSha256 !== hash(capsule.planBytes) ||
        !Number.isFinite(Date.parse(audit.observedAt)) ||
        new Date(audit.observedAt).toISOString() !== audit.observedAt ||
        operations.has(audit.operationSha256)
      )
        fail('ORPHAN_AUDIT');
      operations.add(audit.operationSha256);
      return { path, bytes, capsule };
    });
}

// The live adapter has no target/path/clock/test hooks. All authority is a secure exact operation.
async function runApiWorkerOwned(mode, requestPath, owner) {
  if (
    !['deploy', 'recover', 'reconcile'].includes(mode) ||
    requestPath !== REQUEST ||
    process.getuid?.() !== 0
  )
    fail('ENTRY');
  if (mode !== 'recover') {
    assertNoAmbientComposeOverrides();
    assertNoAmbientDockerOverrides();
  }
  secure(SOURCE);
  if (!secure(SOURCE + '/.git').isDirectory()) fail('CONTROLLER_GIT_CUSTODY');
  assertControllerPromotionGitConfig(git);
  if (
    git(['rev-parse', '--show-toplevel']) !== SOURCE ||
    git(['rev-parse', '--absolute-git-dir']) !== SOURCE + '/.git' ||
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']) !== SOURCE + '/.git'
  )
    fail('CONTROLLER_GIT_CUSTODY');
  let transaction,
    capsule,
    orphanBytes,
    detachedReconcile = false;
  if (mode !== 'deploy' && !pathPresent(LOCK)) {
    const requestBytes = read(REQUEST),
      request = validateApiWorkerOperation(parseStrictJson(requestBytes));
    transaction = `${ROOT}/backups/${request.candidateSha}-${request.publicationRunId}-1-api-worker`;
    secure(transaction, 0o700);
    if (mode === 'reconcile' && request.schema === NOTIFICATION_ROLLOUT_SCHEMA) {
      capsule = readNotificationTerminalCapsule(
        requestBytes,
        read(`${transaction}/preparation.json`),
        read(`${transaction}/plan.json`),
        read(`${transaction}/operation.json`),
        read(`${transaction}/rollout-receipt.json`),
      );
      if (pathPresent(PROVISION_LOCK)) fail('LOCK_DRIFT');
      detachedReconcile = true;
    } else {
      if (mode !== 'recover') fail('LOCK_POINTER');
      const audits = readOrphanAudits(transaction),
        completed = audits.find((audit) => audit.capsule.operationBytes.equals(requestBytes)),
        capsulePath = `${transaction}/preparation.json`;
      if (completed) {
        // This orphan was terminally aborted before cleanup. Do not repeat runtime assertions
        // or make a new claim about current runtime; release only its exact residual capsule.
        owner.assertOwned();
        if (pathPresent(capsulePath)) releaseFile(capsulePath, completed.bytes);
        return { status: 'RECONCILED', receipt: completed.path };
      }
      orphanBytes = read(capsulePath);
      capsule = readApiWorkerCapsule(orphanBytes);
      if (!capsule.operationBytes.equals(requestBytes)) fail('ORPHAN_CAPSULE');
    }
  } else if (mode !== 'deploy') {
    const pointer = read(LOCK).toString();
    if (
      !/^\/opt\/phub\/timeweb-beta\/backups\/[a-f0-9]{40}-[1-9][0-9]*-1-api-worker\/plan\.json\n$/.test(
        pointer,
      )
    )
      fail('LOCK_POINTER');
    transaction = dirname(pointer.trim());
    capsule = readApiWorkerCapsule(read(`${transaction}/preparation.json`));
    const receiptPath = `${transaction}/rollout-receipt.json`;
    const earlyReceipt = existsSync(receiptPath)
      ? validateApiWorkerReceipt(
          parseStrictJson(read(receiptPath)),
          hash(capsule.planBytes),
          capsule.op,
        )
      : null;
    if (
      mode === 'recover' &&
      earlyReceipt &&
      !['PREPARING', 'PREPARED', 'ABORTED', 'ROLLED_BACK', 'SUCCESS', 'RECONCILED'].includes(
        earlyReceipt.status,
      )
    ) {
      const actual = inspectService('worker'),
        old = capsule.plan.previous.worker,
        next = capsule.plan.candidate.worker;
      if (!(
        same(actual.identity, old) ||
        [old, next].some(
          (expected) =>
            actual.identity.image === expected.image &&
            actual.identity.revision === expected.revision &&
            actual.identity.releaseId === expected.releaseId &&
            actual.identity.imageId === localImageId(expected.image),
        )
      ))
        fail('FOREIGN_SERVICE');
      owner.assertOwned();
      if (actual.status !== 'exited') docker(['stop', '--time', '60', actual.identity.id]);
      if (inspectService('worker').status !== 'exited') fail('WORKER_NOT_CONTAINED');
    }
  }
  const opBytes = capsule?.operationBytes ?? read(REQUEST),
    op = validateApiWorkerOperation(
      parseStrictJson(opBytes),
      mode === 'deploy' ? Date.now() : undefined,
    );
  const profile = op.profile ?? 'production';
  const notification = op.schema === NOTIFICATION_ROLLOUT_SCHEMA;
  if (notification) attestNotificationSource(op, { git, read, secure, present: pathPresent });
  const config = parseStrictJson(read('/etc/phub/timeweb-beta-standard-delivery.json').toString());
  if (
    config.schema !== 1 ||
    config.enabled !== true ||
    config.controllerSha !== op.controllerSha ||
    git(['rev-parse', 'HEAD']) !== op.controllerSha ||
    git(['status', '--porcelain', '--untracked-files=no']) !== ''
  )
    fail('CONTROLLER');
  for (const path of git(['ls-files', '-z']).split('\0').filter(Boolean))
    secure(`${SOURCE}/${path}`);
  git(['merge-base', '--is-ancestor', op.candidateSha, op.controllerSha]);
  if (git(['rev-parse', `${op.candidateSha}^{tree}`]) !== op.candidateTree) fail('TREE');
  if (notification) {
    if (
      git([
        'diff',
        '--no-renames',
        '--raw',
        '--abbrev=40',
        '-z',
        op.candidateSha,
        op.controllerSha,
      ]) !== ''
    )
      fail('SOURCE_DIVERGENCE');
  } else {
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
  }
  const id = `${op.candidateSha}-${op.publicationRunId}-1`,
    directory = `${ROOT}/releases/${id}`;
  transaction ??= `${ROOT}/backups/${id}-api-worker`;
  if (transaction !== `${ROOT}/backups/${id}-api-worker`) fail('TRANSACTION');
  secure(directory, 0o700);
  if (mode === 'deploy') {
    await readControllerSourceAuthority(op, git, githubPublic);
    secure(`${ROOT}/backups`, 0o700);
    if (!pathPresent(transaction)) {
      mkdirSync(transaction, { mode: 0o700 });
      const parent = openSync(dirname(transaction), 'r');
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    }
  }
  if (!secure(transaction, 0o700).isDirectory()) fail('TRANSACTION_DIRECTORY');
  const historicalAborts = readOrphanAudits(transaction);
  if (
    mode === 'deploy' &&
    historicalAborts.some((audit) => audit.capsule.operationBytes.equals(opBytes))
  )
    fail('ORPHAN_ABORTED');
  const planPath = `${transaction}/plan.json`,
    journalPath = `${transaction}/rollout-receipt.json`;
  const candidateDir = notification
      ? RUNTIME
      : `/etc/phub/timeweb-beta-candidates/${id}/timeweb-beta`,
    backupDir = `/etc/phub/timeweb-beta-backups/${op.expectedCurrentSecretSetReleaseId}--replaced-by--${id}`;
  let plan, baseline;
  const rolloutMonitoring = () => {
    if (!notification) return monitoring(transaction, profile);
  };
  if (mode === 'deploy') {
    if (existsSync(`${transaction}/preparation.json`)) {
      capsule = readApiWorkerCapsule(read(`${transaction}/preparation.json`));
      if (!capsule.operationBytes.equals(opBytes) || existsSync(`${transaction}/operation.json`))
        fail('ORPHAN_CAPSULE');
    }
    if (
      existsSync(LOCK) ||
      existsSync(PROVISION_LOCK) ||
      existsSync(planPath) ||
      existsSync(journalPath) ||
      existsSync(backupDir)
    )
      fail('TRANSACTION_EXISTS');
    for (const side of ['previous', 'candidate'])
      for (const service of ['api', 'worker'])
        if (existsSync(`${transaction}/${side}-${service}.env`)) fail('TRANSACTION_EXISTS');
    baseline = readInstalledApiBaseline(op.expectedApi.releaseId);
    if (baseline.secretSetReleaseId !== op.expectedCurrentSecretSetReleaseId)
      fail('SECRET_BASELINE');
    const manifest = await candidateAuthority(op, directory),
      current = excluded();
    for (const service of ['api', 'worker']) {
      const actual = inspectService(service);
      if (
        !sameApiWorkerDeploymentIdentity(
          actual.identity,
          op[service === 'api' ? 'expectedApi' : 'expectedWorker'],
          profile,
        ) ||
        actual.status !== 'running' ||
        actual.health !== 'healthy'
      )
        fail('PREIMAGE');
      imagePresent(actual.identity.image, actual.identity.revision);
      if (notification && service === 'worker')
        validateApiWorkerMount(actual.mounts, op.expectedFcmSource);
    }
    secure(candidateDir, 0o700);
    if (notification) {
      validateNotificationManifest(op, manifest);
      if (timewebFcmCredentialSource(RUNTIME) !== op.expectedFcmSource) fail('FCM_SOURCE');
      for (const service of ['web', 'realtime']) {
        const actual = inspectService(service);
        if (
          actual.identity.image !==
            `ghcr.io/z6v6e6r/phub-${service}@${baseline.values[service.toUpperCase() + '_IMAGE_DIGEST']}` ||
          actual.status !== 'running' ||
          actual.health !== 'healthy'
        )
          fail('UNCHANGED_BASELINE_DRIFT');
      }
    } else {
      secure(dirname(backupDir), 0o700);
      validateTimewebFcmSecretDelta(RUNTIME, candidateDir);
    }
    const previousSecrets = secretSet(RUNTIME),
      candidateSecrets = secretSet(candidateDir);
    if (
      candidateSecrets.releaseId !== (notification ? op.expectedCurrentSecretSetReleaseId : id) ||
      !same(candidateSecrets.files, op.candidateSecretHashes)
    )
      fail('PREPARED_SECRETS');
    if (notification) readNotificationMigrationProof(op, { fresh: false });
    else backupProof(transaction, op.expectedApi, profile);
    rolloutMonitoring();
    const packagedLedger = readdirSync(`${SOURCE}/packages/database/migrations`)
      .filter((v) => v.endsWith('.sql'))
      .sort()
      .map((filename) => ({
        filename,
        checksum: hash(read(`${SOURCE}/packages/database/migrations/${filename}`, 0o644)),
      }));
    plan = {
      schema: notification
        ? 'PHUB_TIMEWEB_NOTIFICATION_0105_ROLLOUT_PLAN_V2'
        : 'PHUB_TIMEWEB_API_WORKER_PLAN_V1',
      operationSha256: hash(opBytes),
      controllerSha: op.controllerSha,
      ...(op.controllerPromotion === undefined
        ? {}
        : { controllerPromotionSha256: op.controllerPromotion.sha256 }),
      manifestSha256: op.manifestSha256,
      artifactDigest: op.artifactDigest,
      composeSha256: hash(read(COMPOSE, 0o644)),
      baselineSha256: hash(baseline.bytes),
      baselinePath: baseline.path,
      previous: { api: op.expectedApi, worker: op.expectedWorker },
      candidate: Object.fromEntries(
        ['api', 'worker'].map((service) => [
          service,
          {
            image: `ghcr.io/z6v6e6r/phub-${service}@${manifest.images.find((v) => v.component === service).digest}`,
            releaseId: service === 'api' ? id : null,
            revision: op.candidateSha,
          },
        ]),
      ),
      excluded: current,
      previousSecrets,
      candidateSecrets,
      credential:
        notification && op.expectedFcmSource === '/dev/null'
          ? null
          : credentialMetadata(candidateDir),
      ...(notification
        ? {
            migrationProof: readNotificationMigrationProof(op, { fresh: false }),
            migratorImage: op.migratorImage,
            fcmCredentialSource: op.expectedFcmSource,
            observationPolicy: NOTIFICATION_OBSERVATION_POLICY,
          }
        : {}),
      packagedLedger,
      unchangedImages: Object.fromEntries(
        (notification
          ? ['WEB_IMAGE_DIGEST', 'REALTIME_IMAGE_DIGEST']
          : ['WEB_IMAGE_DIGEST', 'REALTIME_IMAGE_DIGEST', 'MIGRATOR_IMAGE_DIGEST']
        ).map((k) => [k, baseline.values[k]]),
      ),
      createdAt: new Date().toISOString(),
    };
    assertPlan(plan, op, opBytes);
    if (capsule) {
      const fresh = { ...plan, createdAt: capsule.plan.createdAt };
      if (!same(fresh, capsule.plan)) fail('ORPHAN_DRIFT');
      plan = capsule.plan;
    }
  } else {
    plan = capsule.plan;
    assertPlan(plan, op, opBytes);
    baseline = { path: plan.baselinePath, bytes: read(plan.baselinePath) };
    if (existsSync(planPath) && !read(planPath).equals(capsule.planBytes)) fail('PLAN_DRIFT');
    if (
      existsSync(`${transaction}/operation.json`) &&
      !read(`${transaction}/operation.json`).equals(opBytes)
    )
      fail('OPERATION_DRIFT');
  }
  const planBytes =
      mode === 'deploy' && !capsule ? Buffer.from(`${JSON.stringify(plan)}\n`) : capsule.planBytes,
    planSha256 = hash(planBytes);
  const provisionBytes = `${JSON.stringify({ schema: 'PHUB_TIMEWEB_RUNTIME_SWAP_LOCK_V1', planSha256, targetDir: RUNTIME, candidateDir, backupDir, previous: plan.previousSecrets, candidate: plan.candidateSecrets })}\n`;
  const pointer = `${planPath}\n`;
  const assertOrphanEmpty = () => {
    owner.assertOwned();
    const materialized = [
      LOCK,
      PROVISION_LOCK,
      planPath,
      journalPath,
      backupDir,
      `${transaction}/operation.json`,
      `${directory}/installed-components.env`,
      `${transaction}/observation.json`,
      `${transaction}/timeweb-monitor-readback.json`,
      `${transaction}/alert-test-readback.json`,
      ...['previous', 'candidate'].flatMap((side) =>
        ['api', 'worker'].flatMap((service) => [
          `${transaction}/${side}-${service}.env`,
          `${transaction}/${side}-${service}.config-hash`,
          `${transaction}/${side}-${service}.identity.json`,
        ]),
      ),
    ];
    if (materialized.some(pathPresent)) fail('ORPHAN_STATE');
    if (!read(`${transaction}/preparation.json`).equals(orphanBytes)) fail('ORPHAN_DRIFT');
  };
  if (orphanBytes) assertOrphanEmpty();
  let fence,
    initialDatabase,
    installedBaselineSha256,
    currentPhase = existsSync(journalPath)
      ? (parseStrictJson(read(journalPath)).reconciledStatus ??
        parseStrictJson(read(journalPath)).status)
      : 'PREPARING';
  const immutableAttest = () => {
    owner.assertOwned();
    if (
      hash(read(COMPOSE, 0o644)) !== plan.composeSha256 ||
      hash(read(plan.baselinePath)) !== plan.baselineSha256 ||
      !same(excluded(), plan.excluded)
    )
      fail('EXCLUDED_DRIFT');
  };
  const fixedAttest = () => {
    immutableAttest();
    if (notification) {
      for (const name of ['api.env', 'worker.env'])
        assertNotificationRuntimeOff(read(`${RUNTIME}/${name}`));
      attestNotificationSource(op, { git, read, secure, present: pathPresent });
      if (
        !same(secretSet(RUNTIME), plan.previousSecrets) ||
        timewebFcmCredentialSource(RUNTIME) !== plan.fcmCredentialSource ||
        !same(readNotificationMigrationProof(op, { fresh: false }), plan.migrationProof)
      )
        fail('NOTIFICATION_CUSTODY');
    }
    const candidateAt = existsSync(candidateDir) ? candidateDir : RUNTIME;
    if (
      !same(secretSet(candidateAt), plan.candidateSecrets) ||
      !(notification && plan.fcmCredentialSource === '/dev/null'
        ? plan.credential === null
        : same(credentialMetadata(candidateAt), plan.credential))
    )
      fail('CANDIDATE_CUSTODY');
  };
  const database = async () => {
    if (mode === 'deploy' && Date.now() >= Date.parse(op.expiresAt)) fail('OPERATION_EXPIRED');
    const value = await fence.query(API_WORKER_DATABASE_SQL);
    validateApiWorkerDatabase(value, plan.packagedLedger, initialDatabase, op);
    initialDatabase ??= value;
    return value;
  };
  const validateObservation = () =>
    validateNotificationObservation(
      parseStrictJson(read(`${transaction}/observation.json`)),
      hash(opBytes),
      planSha256,
    );
  const journal = async (status) => {
    if (notification && status === 'SUCCESS') validateObservation();
    durable(
      journalPath,
      `${JSON.stringify({ schema: notification ? 'PHUB_TIMEWEB_NOTIFICATION_0105_ROLLOUT_RECEIPT_V2' : 'PHUB_TIMEWEB_API_WORKER_RECEIPT_V1', status, planSha256, observedAt: new Date().toISOString(), ...(status === 'SUCCESS' ? { installedBaselineSha256, observationSha256: hash(read(`${transaction}/observation.json`)), ...(notification ? { observationPolicySha256: NOTIFICATION_OBSERVATION_POLICY_SHA256 } : { providerReadbackSha256: hash(read(`${transaction}/timeweb-monitor-readback.json`)), alertReadbackSha256: hash(read(`${transaction}/alert-test-readback.json`)) }) } : {}) })}\n`,
    );
    currentPhase = status;
  };
  const swap = (direction) => {
    fixedAttest();
    if (notification) return;
    transitionPreparedTimewebRuntimeSecrets({
      direction,
      targetDir: RUNTIME,
      candidateDir,
      backupDir,
      previous: plan.previousSecrets,
      candidate: plan.candidateSecrets,
      planSha256,
    });
    fixedAttest();
  };
  const known = (service) => {
    const actual = inspectService(service),
      old = plan.previous[service];
    if (!(
      same(actual.identity, old) ||
      ['previous', 'candidate'].some((side) => {
        const expected = plan[side][service],
          cfg = `${transaction}/${side}-${service}.config-hash`;
        return (
          actual.identity.image === expected.image &&
          actual.identity.imageId === localImageId(expected.image) &&
          actual.identity.releaseId === expected.releaseId &&
          actual.identity.revision === expected.revision &&
          existsSync(cfg) &&
          read(cfg).toString() === `${actual.configHash}\n`
        );
      })
    ))
      fail('FOREIGN_SERVICE');
    return actual;
  };
  const compose = (side, service) => {
    fixedAttest();
    const path = `${transaction}/${side}-${service}.env`;
    if (!read(path).equals(Buffer.from(overlay(plan, side, service)))) fail('OVERLAY');
    const args = apiWorkerComposeArgs(plan.baselinePath, path, 'up', service),
      base = args.slice(0, args.indexOf('up'));
    const configBase = service === 'api' ? [...base, '--profile', 'background'] : base;
    const model = parseStrictJson(docker([...configBase, 'config', '--format', 'json']));
    const mounts = model.services.worker.volumes;
    validateApiWorkerMount(
      mounts.map((v) => ({
        Destination: v.target,
        Source: v.source,
        RW: v.read_only !== true,
        Type: v.type,
      })),
      notification
        ? plan.fcmCredentialSource
        : side === 'candidate' && service === 'worker'
          ? '/etc/phub/timeweb-beta-fcm/fcm-service-account.json'
          : '/dev/null',
    );
    if (model.services.api.volumes?.some((v) => v.target === '/run/phub/fcm-service-account.json'))
      fail('API_CREDENTIAL_MOUNT');
    const output = docker([...configBase, 'config', '--hash', service]).trim();
    const cfg = output.split(/\s+/);
    if (cfg.length !== 2 || cfg[0] !== service || !HASH.test(cfg[1])) fail('COMPOSE_HASH');
    const cfgPath = `${transaction}/${side}-${service}.config-hash`,
      bytes = `${cfg[1]}\n`;
    if (existsSync(cfgPath)) {
      if (read(cfgPath).toString() !== bytes) fail('COMPOSE_HASH_DRIFT');
    } else durable(cfgPath, bytes, true);
    owner.assertOwned();
    docker(args);
  };
  const descriptorPath = `${directory}/installed-components.env`;
  const descriptor = () => {
    const values = Object.fromEntries(
      baseline.bytes
        .toString()
        .trimEnd()
        .split('\n')
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    );
    for (const key of Object.keys(values))
      if (
        key.startsWith('PHUB_CANONICAL_') ||
        key.startsWith('PHUB_PUBLICATION_') ||
        key.endsWith('_RUNTIME_DIGEST') ||
        ['PHUB_RELEASE_SOURCE_SHA', 'PHUB_RELEASE_SOURCE_TREE'].includes(key)
      )
        delete values[key];
    Object.assign(values, {
      PHUB_TIMEWEB_RELEASE_ENV_SCHEMA: 'PHUB_TIMEWEB_INSTALLED_COMPONENT_ENV_V1',
      PHUB_COMPONENT_ROLLOUT_KIND: notification ? 'API_WORKER_NOTIFICATION_0105' : 'API_WORKER',
      PHUB_RELEASE_ID: id,
      PHUB_RUNTIME_SECRET_SET_RELEASE_ID: notification ? plan.previousSecrets.releaseId : id,
      ...(notification ? { MIGRATOR_IMAGE_DIGEST: op.migratorImage.split('@')[1] } : {}),
      PHUB_COMPONENT_ROLLOUT_RECEIPT: journalPath,
      API_IMAGE_DIGEST: plan.candidate.api.image.split('@')[1],
      WORKER_IMAGE_DIGEST: plan.candidate.worker.image.split('@')[1],
    });
    return Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}\n`)
      .join('');
  };
  const ops = {
    ...(notification ? { secretMode: 'preserve' } : {}),
    journal,
    preflight: async () => {
      fixedAttest();
      await database();
      if (notification) {
        if (!same(readNotificationMigrationProof(op, { fresh: false }), plan.migrationProof))
          fail('MIGRATION_PROOF');
      } else backupProof(transaction, op.expectedApi, profile);
      let backupReceipt = null;
      try {
        backupReceipt = parseStrictJson(read(`${transaction}/database-backup-receipt.json`));
      } catch {
        // Beta degraded proof path (operator-authorized): no fresh transaction receipt exists.
        // Production never reaches this branch: backupProof() fails first.
      }
      if (!notification && backupReceipt !== null)
        validateApiWorkerBackupLedger(backupReceipt, plan.packagedLedger);
      if (notification) {
        await ops.attestPrevious();
        await probeNotificationPublicReadiness();
      } else rolloutMonitoring();
    },
    pullAndSmoke: async () => {
      for (const service of ['api', 'worker']) {
        await database();
        const path = `${transaction}/candidate-${service}.env`;
        docker(apiWorkerComposeArgs(plan.baselinePath, path, 'pull', service));
        imagePresent(plan.candidate[service].image, op.candidateSha);
        docker(apiWorkerSmokeArgs(service, plan.candidate[service].image));
        await database();
        fixedAttest();
      }
    },
    containWorker: async () => {
      owner.assertOwned();
      const actual = known('worker');
      if (actual.status !== 'exited') docker(['stop', '--time', '60', actual.identity.id]);
      const stopped = known('worker');
      if (stopped.status !== 'exited') fail('WORKER_NOT_CONTAINED');
      fixedAttest();
    },
    installSecrets: async () => {
      await database();
      if (!same(known('api').identity, plan.previous.api)) fail('PREIMAGE');
      swap('install');
      await database();
    },
    restoreSecrets: async () => swap('restore'),
    activate: async (service) => {
      await database();
      known(service);
      if (notification) {
        readNotificationMigrationProof(op, { fresh: false });
        rolloutMonitoring();
      }
      if (!same(secretSet(RUNTIME), plan.candidateSecrets)) fail('SECRET_DRIFT');
      compose('candidate', service);
      const active = await waitService(service, plan.candidate[service], profile);
      durable(
        `${transaction}/candidate-${service}.identity.json`,
        `${JSON.stringify(active.identity)}\n`,
        true,
      );
      if (service === 'worker')
        validateApiWorkerMount(
          inspectService('worker').mounts,
          notification ? plan.fcmCredentialSource : undefined,
        );
      await database();
      fixedAttest();
    },
    restore: async (service) => {
      known(service);
      if (!same(secretSet(RUNTIME), plan.previousSecrets)) fail('SECRET_RESTORE');
      imagePresent(plan.previous[service].image, plan.previous[service].revision);
      compose('previous', service);
      await waitService(service, plan.previous[service], profile);
    },
    attestPrevious: async () => {
      immutableAttest();
      if (!['PREPARING', 'PREPARED', 'ABORTED'].includes(currentPhase)) fixedAttest();
      if (!same(secretSet(RUNTIME), plan.previousSecrets)) fail('SECRET_RESTORE');
      for (const service of ['api', 'worker']) {
        const actual = await waitService(service, plan.previous[service], profile);
        if (
          ['PREPARING', 'PREPARED', 'ABORTED'].includes(currentPhase) &&
          !sameApiWorkerDeploymentIdentity(actual.identity, plan.previous[service], profile)
        )
          fail('PREIMAGE');
      }
      const worker = inspectService('worker');
      if (
        notification ||
        !sameApiWorkerDeploymentIdentity(worker.identity, plan.previous.worker, profile)
      )
        validateApiWorkerMount(
          worker.mounts,
          notification ? plan.fcmCredentialSource : '/dev/null',
        );
    },
    attestCandidate: async () => {
      fixedAttest();
      await database();
      if (!same(secretSet(RUNTIME), plan.candidateSecrets)) fail('SECRET_DRIFT');
      for (const service of ['api', 'worker']) {
        const actual = await waitService(service, plan.candidate[service], profile);
        if (
          !sameApiWorkerDeploymentIdentity(
            actual.identity,
            parseStrictJson(read(`${transaction}/candidate-${service}.identity.json`)),
            profile,
          )
        )
          fail('OBSERVATION_IDENTITY');
      }
      validateApiWorkerMount(
        inspectService('worker').mounts,
        notification ? plan.fcmCredentialSource : undefined,
      );
      if (notification) rolloutMonitoring();
    },
    observe: async () => {
      if (notification) {
        const value = await observeNotificationRollout({
          attest: ops.attestCandidate,
          operationSha256: hash(opBytes),
          planSha256,
        });
        durable(`${transaction}/observation.json`, `${JSON.stringify(value)}\n`, true);
        validateObservation();
        return;
      }
      const started = Date.now(),
        samples = [];
      for (let i = 0; i < 61; i++) {
        await ops.attestCandidate();
        if (!notification) monitoring(transaction);
        samples.push(new Date().toISOString());
        if (i < 60) await delay(15000);
      }
      const observed = notification ? rolloutMonitoring() : monitoring(transaction);
      durable(`${transaction}/timeweb-monitor-readback.json`, observed.provider, true);
      durable(`${transaction}/alert-test-readback.json`, observed.alerts, true);
      durable(
        `${transaction}/observation.json`,
        `${JSON.stringify({ schema: 'PHUB_TIMEWEB_API_WORKER_OBSERVATION_V1', startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString(), samples, providerActivation: false, deviceDelivery: false })}\n`,
        true,
      );
    },
    installBaseline: async () => {
      await ops.attestCandidate();
      if (notification) await probeNotificationPublicReadiness();
      const bytes = descriptor();
      durable(descriptorPath, bytes, true);
      installedBaselineSha256 = hash(bytes);
    },
    removeCandidateBaseline: async () => {
      if (existsSync(descriptorPath)) releaseFile(descriptorPath, descriptor());
    },
    releaseFence: async () => {
      await database();
      await fence.commit();
    },
  };
  try {
    if (orphanBytes) {
      assertOrphanEmpty();
      await ops.attestPrevious();
      assertOrphanEmpty();
      await ops.attestPrevious();
      assertOrphanEmpty();
      const auditPath = `${transaction}/orphan-abort-${hash(orphanBytes)}.json`,
        audit = {
          schema: 'PHUB_TIMEWEB_API_WORKER_ORPHAN_ABORT_V1',
          status: 'RECONCILED',
          reconciledStatus: 'ABORTED',
          runtimeMutated: false,
          operationSha256: hash(opBytes),
          planSha256,
          capsuleSha256: hash(orphanBytes),
          preparation: orphanBytes.toString('base64'),
          observedAt: new Date().toISOString(),
        };
      // The durable audit terminates this never-owned orphan at the attested point.
      // Capsule removal is retryable cleanup, not another runtime assertion.
      durable(auditPath, `${JSON.stringify(audit)}\n`, true);
      releaseFile(`${transaction}/preparation.json`, orphanBytes);
      return { status: 'RECONCILED', receipt: auditPath };
    }
    if (mode === 'deploy' || (mode === 'reconcile' && currentPhase === 'SUCCESS')) {
      const pg = JSON.parse(
        docker([
          'container',
          'inspect',
          notification ? op.expectedPostgres.id : API_WORKER_BRIDGE.postgresId,
        ]),
      )[0];
      if (
        pg.Config.Image !==
          (notification ? op.expectedPostgres.image : API_WORKER_BRIDGE.postgresImage) ||
        pg.State.Status !== 'running' ||
        pg.State.Health?.Status !== 'healthy'
      )
        fail('POSTGRES');
      if (
        notification &&
        !same(
          {
            id: pg.Id,
            image: pg.Config.Image,
            imageId: pg.Image,
            releaseId: pg.Config.Labels?.['phub.release-id'] ?? null,
            revision: pg.Config.Labels?.['org.opencontainers.image.revision'] ?? null,
            restarts: pg.RestartCount,
            startedAt: pg.State.StartedAt,
          },
          op.expectedPostgres,
        )
      )
        fail('POSTGRES_IDENTITY');
      fence = openApiWorkerDatabaseFence(
        notification ? op.expectedPostgres.id : API_WORKER_BRIDGE.postgresId,
        spawn,
        notification ? op.expectedPostgres : undefined,
      );
      const locks = await fence.query(API_WORKER_GATE_LOCK_SQL);
      exact(locks, ['locksAcquired', 'tenantCount', 'tenantFingerprint']);
      if (locks.locksAcquired !== true || locks.tenantCount < 1) fail('GATE_LOCKS');
      const db = await database();
      if (db.tenantCount !== locks.tenantCount || db.tenantFingerprint !== locks.tenantFingerprint)
        fail('TENANT_DRIFT');
    }
    if (mode === 'deploy') {
      // One atomic capsule precedes the shared pointer. It contains every recovery preimage.
      if (!capsule)
        durable(
          `${transaction}/preparation.json`,
          encodeApiWorkerCapsule(opBytes, planBytes),
          true,
        );
      durable(LOCK, pointer, true);
      durable(`${transaction}/operation.json`, opBytes, true);
      durable(planPath, planBytes, true);
      for (const side of ['previous', 'candidate'])
        for (const service of ['api', 'worker'])
          durable(`${transaction}/${side}-${service}.env`, overlay(plan, side, service), true);
      await journal('PREPARING');
      if (!notification) durable(PROVISION_LOCK, provisionBytes, true);
      await runApiWorkerTransition(ops);
    } else {
      if (!detachedReconcile && !read(LOCK).equals(Buffer.from(pointer))) fail('LOCK_DRIFT');
      const receipt = existsSync(journalPath)
        ? validateApiWorkerReceipt(parseStrictJson(read(journalPath)), planSha256, op)
        : { status: 'PREPARING' };
      const preparation = ['PREPARING', 'PREPARED'].includes(receipt.status);
      if (existsSync(PROVISION_LOCK)) {
        if (!read(PROVISION_LOCK).equals(Buffer.from(provisionBytes))) fail('LOCK_DRIFT');
      } else if (
        !notification &&
        !preparation &&
        !['ABORTED', 'RECONCILED'].includes(receipt.status)
      )
        fail('LOCK_DRIFT');
      if (mode === 'recover') await recoverApiWorkerPhase(receipt.status, ops);
      else {
        const terminal =
          receipt.status === 'RECONCILED' ? receipt.reconciledStatus : receipt.status;
        if (!['SUCCESS', 'ROLLED_BACK', 'ABORTED'].includes(terminal)) fail('RECONCILE');
        if (terminal === 'SUCCESS') {
          await ops.attestCandidate();
          if (hash(read(descriptorPath)) !== receipt.installedBaselineSha256) fail('INSTALLED');
          if (notification) {
            await probeNotificationPublicReadiness();
            validateObservation();
            if (hash(read(`${transaction}/observation.json`)) !== receipt.observationSha256)
              fail('OBSERVATION_HASH');
          }
        } else await ops.attestPrevious();
        if (detachedReconcile) return { status: 'RECONCILED', receipt: journalPath };
        durable(
          journalPath,
          `${JSON.stringify({ ...receipt, status: 'RECONCILED', reconciledStatus: terminal, observedAt: new Date().toISOString() })}
`,
        );
        if (existsSync(PROVISION_LOCK)) releaseFile(PROVISION_LOCK, provisionBytes);
        releaseFile(LOCK, pointer);
      }
    }
    // Only reconciliation releases shared locks after terminal runtime/evidence readback.
    return { status: parseStrictJson(read(journalPath)).status, receipt: journalPath };
  } finally {
    fence?.close();
  }
}

export async function runManualApiWorkerUpgrade(mode, requestPath) {
  if (
    !['deploy', 'recover', 'reconcile'].includes(mode) ||
    requestPath !== REQUEST ||
    process.getuid?.() !== 0
  )
    fail('ENTRY');
  secure(`${ROOT}/standard`, 0o700);
  const owner = acquireApiWorkerExecutor(`${ROOT}/standard/api-worker-executor.lock`);
  try {
    return await runApiWorkerOwned(mode, requestPath, owner);
  } finally {
    owner.close();
  }
}
