// LK2 production deploy helper: one entry point for the manual critical API/Worker/Web
// upgrade. It never publishes, migrates or edits runtime secrets; it stages the exact
// canonical artifact, takes the fresh canonical backup, builds the V5 request from the
// last accepted operation, and runs the enrolled controller.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  rmSync,
} from 'node:fs';
const requireStat = (path) => lstatSync(path);

export const ROOT = '/opt/phub/timeweb-beta';
export const SOURCE = ROOT + '/standard/source';
export const CONFIG = '/etc/phub/timeweb-beta-standard-delivery.json';
export const TOOLS = ROOT + '/operator/tools';
export const V5_REQUEST = ROOT + '/operator/api-web-upgrade.json';
export const BACKUP_REQUEST = ROOT + '/operator/database-backup-restore.json';
export const LOCK = ROOT + '/standard/active';
export const CONFIRMATION_PREFIX =
  'UPGRADE_CANONICAL_PRODUCTION_API_WORKER_WEB_OWNER_SKIPPED_ALERT_DRILL_PROVIDER_READBACK_REPEAT_RESTORE_';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const hashFile = (path) => sha256(readFileSync(path));
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const releaseId = (sha, runId) => sha + '-' + runId + '-1';
export const toolDir = (sha) => TOOLS + '/' + sha;
export const confirmationFor = (candidateSha, baselineHash) =>
  CONFIRMATION_PREFIX +
  candidateSha.slice(0, 12).toUpperCase() +
  '_FROM_' +
  baselineHash.slice(0, 12).toUpperCase() +
  '_KEEP_DATA_AND_ACCOUNTS';

// The controller requires candidate <= controller; a newer candidate needs enrollment first.
export function pinVerdict({ controllerSha, candidateSha, headSha, configSha, clean }) {
  if (headSha !== configSha) return 'controller_config_mismatch';
  if (headSha !== controllerSha) return 'controller_head_mismatch';
  if (!clean) return 'controller_checkout_dirty';
  if (controllerSha === candidateSha) return 'ok';
  return 'enroll_required';
}

// A leaked self-bind mount of the backups root makes the canonical backup's
// renameat2(lock -> retired-lock) fail with EXDEV and leaves the operation unusable.
export function mountLeaks(mountInfo, backupsPath) {
  const rows = mountInfo
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' '))
    .filter((fields) => fields.length > 4 && fields[4] === backupsPath);
  return { count: rows.length, sameRoot: new Set(rows.map((fields) => fields[3])).size <= 1 };
}

export function planVerdict(input) {
  const blockers = [];
  if (input.mount.count > 1) blockers.push('mount_leak');
  if (!input.mount.sameRoot) blockers.push('mount_foreign');
  if (input.pin !== 'ok') blockers.push(input.pin);
  if (!input.artifactPresent) blockers.push('artifact_missing');
  if (input.artifactPresent && input.artifactDigestMismatch) blockers.push('artifact_digest');
  if (!input.backupPresent) blockers.push('backup_required');
  if (input.backupPresent && !input.backupFresh) blockers.push('backup_stale');
  if (input.backupPresent && input.backupExpired) blockers.push('backup_expired');
  if (input.lockPresent) blockers.push('lock_present');
  return { verdict: blockers.length === 0 ? 'GO' : 'NO-GO', blockers };
}

export function buildV5Request({
  template,
  baseline,
  backupOperationSha256,
  candidateSha,
  candidateTree,
  publicationRunId,
  artifactId,
  sourceCiRunId,
  artifactDigest,
  manifestSha256,
  expiresAt,
  legacyBaselineHash,
  ownerDirectedScopeSha256,
}) {
  const op = { ...template };
  op.candidateSha = candidateSha;
  op.controllerSha = candidateSha;
  op.candidateTree = candidateTree;
  op.publicationRunId = String(publicationRunId);
  op.sourceCiRunId = String(sourceCiRunId ?? template.sourceCiRunId);
  op.artifactId = String(artifactId);
  op.artifactDigest = artifactDigest;
  op.manifestSha256 = manifestSha256;
  op.backupOperationSha256 = backupOperationSha256;
  op.canonicalBaseline = baseline;
  op.expectedApi = {
    id: baseline.containers.api.id,
    image: baseline.containers.api.image,
    releaseId: baseline.containers.api.releaseId,
  };
  op.expectedWeb = {
    id: baseline.containers.web.id,
    image: baseline.containers.web.image,
    releaseId: baseline.containers.web.releaseId,
  };
  op.expectedWorker = {
    id: baseline.containers.worker.id,
    image: baseline.containers.worker.image,
    releaseId: baseline.containers.worker.releaseId,
  };
  op.expiresAt = expiresAt;
  op.confirmation = confirmationFor(candidateSha, legacyBaselineHash(baseline));
  for (const key of Object.keys(op.ownerDecisions)) {
    op.ownerDecisions[key] = {
      ...op.ownerDecisions[key],
      scopeSha256: ownerDirectedScopeSha256(op),
    };
  }
  return op;
}

function run(command, args, options = {}) {
  const result = execFileSync(command, args, { encoding: 'utf8', ...options });
  return typeof result === 'string' ? result.trim() : result;
}

function git(dir, args) {
  return run('/usr/bin/git', ['-C', dir, ...args]);
}

export function mountCheck(backupsPath = ROOT + '/backups') {
  return mountLeaks(readFileSync('/proc/self/mountinfo', 'utf8'), backupsPath);
}

function controllerState() {
  return {
    head: git(SOURCE, ['rev-parse', 'HEAD']),
    config: readJson(CONFIG),
    clean: git(SOURCE, ['status', '--porcelain', '--untracked-files=all']) === '',
  };
}

function unzipEntry(archivePath, entry) {
  return execFileSync('/usr/bin/unzip', ['-p', archivePath, entry], { encoding: 'buffer' });
}

function manifestFromArchive(archivePath) {
  const bytes = unzipEntry(archivePath, 'release-manifest.json');
  return {
    manifest: JSON.parse(bytes.toString('utf8')),
    bytes,
    checksum: unzipEntry(archivePath, 'release-manifest.sha256').toString('utf8'),
  };
}

function commandPlan(argv) {
  const sha = argv.sha;
  if (!/^[0-9a-f]{40}$/.test(sha || ''))
    throw new Error('usage: lk2-deploy plan <sha> --run <publication-run> --artifact <zip>');
  const { head, config, clean } = controllerState();
  const pin = pinVerdict({
    controllerSha: head,
    candidateSha: sha,
    headSha: head,
    configSha: config ? config.controllerSha : '',
    clean,
  });
  const id = releaseId(sha, argv.run);
  const artifactPath = ROOT + '/releases/' + id + '/artifact/canonical-artifact.zip';
  const artifactPresent = existsSync(artifactPath);
  let artifactDigestMismatch = false;
  if (artifactPresent) {
    try {
      const { manifest, bytes, checksum } = manifestFromArchive(artifactPath);
      artifactDigestMismatch =
        sha256(bytes) !== argv.manifestSha256 ||
        checksum !== sha256(bytes) + '  release-manifest.json\n' ||
        manifest.gitCommit !== sha;
    } catch {
      artifactDigestMismatch = true;
    }
  }
  const backupReceipt = ROOT + '/backups/' + id + '-api-web/database-backup-receipt.json';
  const backupPresent = existsSync(backupReceipt);
  let backupFresh = false;
  let backupExpired = false;
  if (backupPresent) {
    const completed = Date.parse(readJson(backupReceipt).completedAt);
    backupFresh = Number.isFinite(completed) && Date.now() - completed <= 3600000;
    const requestExpiry = existsSync(BACKUP_REQUEST)
      ? Date.parse(readJson(BACKUP_REQUEST).expiresAt)
      : 0;
    backupExpired = Number.isFinite(requestExpiry) && requestExpiry <= Date.now();
  }
  const verdict = planVerdict({
    mount: mountCheck(),
    pin,
    artifactPresent,
    artifactDigestMismatch,
    backupPresent,
    backupFresh,
    backupExpired,
    lockPresent: existsSync(LOCK),
  });
  process.stdout.write(
    JSON.stringify({ ...verdict, sha, controllerSha: head, artifactPath, backupReceipt }) + '\n',
  );
  if (verdict.verdict !== 'GO') process.exitCode = 1;
}

function commandEnroll(argv) {
  const sha = argv.sha;
  if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('usage: lk2-deploy enroll <sha>');
  const incoming = SOURCE + '.incoming-' + sha.slice(0, 12);
  if (existsSync(incoming)) throw new Error('enrollment_incoming_exists');
  run('/usr/bin/git', ['clone', '--no-hardlinks', '-q', SOURCE, incoming]);
  run('/usr/bin/git', [
    '-C',
    incoming,
    'remote',
    'set-url',
    'origin',
    'https://github.com/Z6v6e6r/lk2.git',
  ]);
  run('/usr/bin/git', ['-C', incoming, 'fetch', '-q', 'origin', sha]);
  run('/usr/bin/git', ['-C', incoming, 'checkout', '-q', '--detach', sha]);
  run('/usr/bin/npm', ['ci', '--ignore-scripts'], { cwd: incoming, stdio: 'inherit' });
  if (git(incoming, ['rev-parse', 'HEAD']) !== sha) throw new Error('enrollment_head_mismatch');
  if (git(incoming, ['status', '--porcelain', '--untracked-files=all']) !== '')
    throw new Error('enrollment_dirty');
  const previous = SOURCE + '.pre-' + sha.slice(0, 12);
  if (existsSync(previous)) throw new Error('enrollment_previous_exists:' + previous);
  run('/usr/bin/mv', [SOURCE, previous]);
  run('/usr/bin/mv', [incoming, SOURCE]);
  writeFileSync(
    CONFIG + '.tmp',
    JSON.stringify({ controllerSha: sha, enabled: true, owner: 'Z6v6e6r', schema: 1 }) + '\n',
    { mode: 0o600 },
  );
  run('/usr/bin/mv', [CONFIG + '.tmp', CONFIG]);
  const receipt = ROOT + '/operator/enrollments/' + sha + '-cli';
  mkdirSync(receipt, { recursive: true, mode: 0o700 });
  writeFileSync(
    receipt + '/enrollment.json',
    JSON.stringify({
      reportSha: sha,
      tree: git(SOURCE, ['rev-parse', 'HEAD^{tree}']),
      previous,
      appliedAt: new Date().toISOString(),
    }) + '\n',
    { mode: 0o600 },
  );
  process.stdout.write(JSON.stringify({ status: 'ENROLLED', sha, previous }) + '\n');
}

async function ensureBackupTool(sha) {
  const dir = toolDir(sha);
  if (existsSync(dir + '/installation-receipt.json')) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const helper = dir + '/control-timeweb-database-backup.py';
  const proof = dir + '/source-proof.json';
  cpSync(SOURCE + '/scripts/control-timeweb-database-backup.py', helper);
  chmodSync(helper, 0o755);
  run('/usr/bin/python3', [
    '-I',
    '-S',
    '-B',
    SOURCE + '/scripts/prepare-timeweb-database-backup-source.py',
    SOURCE,
    sha,
    proof,
  ]);
  chmodSync(proof, 0o600);
  const plan = {
    schema: 'PHUB_BACKUP_HELPER_EXACT_INSTALLATION_PLAN_V2',
    target: { hostname: 'lk2.padlhub.su', projectId: 262717, serverId: 8886471 },
    toolCommit: sha,
    controllerTree: git(SOURCE, ['rev-parse', 'HEAD^{tree}']),
    controllerConfigSha256: hashFile(CONFIG),
    installedPath: helper,
    sourcePath: SOURCE + '/scripts/control-timeweb-database-backup.py',
    toolFileSha256: hashFile(helper),
    sourceProofSha256: hashFile(proof),
  };
  writeFileSync(dir + '/installation-plan.json', JSON.stringify(plan), { mode: 0o600 });
  const stat = requireStat(helper);
  const receipt = {
    schema: 'PHUB_TIMEWEB_BACKUP_INSTALLATION_V1',
    sourceProof: readJson(proof),
    installedPath: helper,
    installedAt: new Date().toISOString(),
    installationPlanSha256: hashFile(dir + '/installation-plan.json'),
    metadata: {
      dev: stat.dev,
      ino: stat.ino,
      uid: stat.uid,
      gid: stat.gid,
      mode: stat.mode,
      nlink: stat.nlink,
      size: stat.size,
    },
  };
  writeFileSync(dir + '/installation-receipt.json', JSON.stringify(receipt), { mode: 0o600 });
}

async function prepareBackup({ sha, publicationRun, artifact }) {
  const { manifest } = manifestFromArchive(artifact);
  if (manifest.gitCommit !== sha) throw new Error('artifact_source_mismatch');
  const id = releaseId(sha, publicationRun);
  const dir = ROOT + '/releases/' + id;
  mkdirSync(dir + '/artifact', { recursive: true, mode: 0o700 });
  cpSync(artifact, dir + '/artifact/canonical-artifact.zip');
  chmodSync(dir + '/artifact/canonical-artifact.zip', 0o600);
  const temporary = BACKUP_REQUEST + '.template';
  cpSync(BACKUP_REQUEST, temporary);
  const toolDirPath = toolDir(sha);
  const build = run('/usr/bin/python3', [
    '-I',
    '-S',
    '-B',
    SOURCE + '/scripts/build-timeweb-canonical-backup-request.py',
    '--candidate',
    sha,
    '--run',
    String(publicationRun),
    '--template',
    temporary,
    '--tool-dir',
    toolDirPath,
    '--output',
    BACKUP_REQUEST,
  ]);
  rmSync(temporary, { force: true });
  const built = JSON.parse(build);
  const executed = JSON.parse(
    run('/usr/bin/python3', [
      '-I',
      '-S',
      '-B',
      toolDirPath + '/control-timeweb-database-backup.py',
      '--execute',
      BACKUP_REQUEST,
    ]),
  );
  if (executed.status !== 'FRESH_DUMP_INTEGRITY_VERIFIED')
    throw new Error('backup_' + (executed.code || executed.status));
  return {
    id,
    operationSha256: executed.operationSha256,
    receiptSha256: executed.receiptSha256,
    request: built,
    tree: manifest.gitTree,
  };
}

export async function commandPrepareFull({ sha, run, artifact, artifactId, sourceCiRunId }) {
  if (mountCheck().count > 1)
    throw new Error('mount_leak: stale self-bind mounts must be removed first');
  if (existsSync(LOCK)) throw new Error('lock_present');
  const { head, config, clean } = controllerState();
  const pin = pinVerdict({
    controllerSha: head,
    candidateSha: sha,
    headSha: head,
    configSha: config ? config.controllerSha : '',
    clean,
  });
  if (pin !== 'ok') throw new Error('controller_pin_' + pin);
  await ensureBackupTool(sha);
  if (!artifactId || !sourceCiRunId) throw new Error('artifact_id_and_source_ci_required');
  const prepared = await prepareBackup({ sha, publicationRun: run, artifact });
  const backupRequest = readJson(BACKUP_REQUEST);
  const cutover = await import('file://' + SOURCE + '/scripts/timeweb-production-cutover.js');
  const waiver = await import('file://' + SOURCE + '/scripts/timeweb-roster-alert-waiver.js');
  const template = readJson(V5_REQUEST);
  const backupExpiry = Date.parse(backupRequest.expiresAt);
  const expiresAt = new Date(Math.min(backupExpiry - 120000, Date.now() + 50 * 60000))
    .toISOString()
    .replace(/\.\d{3}Z$/, '.000Z');
  const op = buildV5Request({
    template,
    baseline: backupRequest.canonicalBaseline,
    backupOperationSha256: prepared.operationSha256,
    candidateSha: sha,
    candidateTree: prepared.tree,
    publicationRunId: run,
    sourceCiRunId,
    artifactId,
    artifactDigest:
      'sha256:' + hashFile(ROOT + '/releases/' + prepared.id + '/artifact/canonical-artifact.zip'),
    manifestSha256: sha256(
      manifestFromArchive(ROOT + '/releases/' + prepared.id + '/artifact/canonical-artifact.zip')
        .bytes,
    ),
    expiresAt,
    legacyBaselineHash: cutover.legacyBaselineHash,
    ownerDirectedScopeSha256: waiver.ownerDirectedScopeSha256,
  });
  writeFileSync(V5_REQUEST, JSON.stringify(op), { mode: 0o600 });
  process.stdout.write(
    JSON.stringify({
      status: 'PREPARED',
      id: prepared.id,
      backupOperationSha256: prepared.operationSha256,
      confirmation: op.confirmation,
      expiresAt,
    }) + '\n',
  );
  return op;
}

function main(argv) {
  const [mode, sha] = argv;
  const rest = argv.slice(2);
  const flag = (name) => {
    const index = rest.indexOf('--' + name);
    return index >= 0 ? rest[index + 1] : undefined;
  };
  if (mode === 'plan')
    return commandPlan({
      sha,
      run: flag('run'),
      artifact: flag('artifact'),
      manifestSha256: flag('manifest-sha256'),
    });
  if (mode === 'enroll') return commandEnroll({ sha });
  if (mode === 'prepare')
    return commandPrepareFull({
      sha,
      run: flag('run'),
      artifact: flag('artifact'),
      artifactId: flag('artifact-id'),
      sourceCiRunId: flag('source-ci-run'),
    });
  if (mode === 'apply') return commandApply({ sha, confirmation: flag('confirmation') });
  throw new Error('usage: lk2-deploy <plan|prepare|apply|enroll> <sha> [flags]');
}

export function commandApply({ sha, confirmation }, env = {}) {
  const op = readJson(V5_REQUEST);
  if (op.candidateSha !== sha) throw new Error('request_candidate_mismatch');
  if (op.confirmation !== confirmation) throw new Error('confirmation_mismatch');
  if (Date.parse(op.expiresAt) <= Date.now()) throw new Error('request_expired');
  const exec = env.run ?? run;
  exec(
    '/usr/bin/env',
    [
      '-i',
      'PATH=/usr/bin:/bin',
      'HOME=/root',
      '/usr/bin/node',
      SOURCE + '/scripts/run-timeweb-standard-delivery.js',
      '--critical-api-web',
      V5_REQUEST,
    ],
    { stdio: 'inherit' },
  );
  exec(
    '/usr/bin/env',
    [
      '-i',
      'PATH=/usr/bin:/bin',
      'HOME=/root',
      '/usr/bin/node',
      SOURCE + '/scripts/run-timeweb-standard-delivery.js',
      '--critical-api-web-reconcile',
      V5_REQUEST,
    ],
    { stdio: 'inherit' },
  );
  const receipt = readJson(
    ROOT + '/backups/' + releaseId(sha, op.publicationRunId) + '-api-web/rollout-receipt.json',
  );
  process.stdout.write(
    JSON.stringify({
      status: receipt.status,
      reconciledStatus: receipt.reconciledStatus,
      release: releaseId(sha, op.publicationRunId),
    }) + '\n',
  );
  return receipt;
}

if (process.argv[1] && process.argv[1].endsWith('lk2-deploy.js')) main(process.argv.slice(2));
