import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest,
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from '@phub/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ceremonySource = new URL(
  '../deploy/jetson/run-communities-role-split-restore-marker-ceremony.sh',
  import.meta.url,
);
const cleanupSource = new URL(
  '../deploy/jetson/cleanup-communities-role-split-restore-marker-clone.sh',
  import.meta.url,
);
const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex');

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

let root = '';
let requestRoot = '';
let cleanupRequestRoot = '';
let backupRoot = '';
let stateRoot = '';
let appRoot = '';
let binRoot = '';
let ceremonyPath = '';
let cleanupPath = '';
let helperPath = '';
let requestPath = '';
let backupPath = '';
let evidencePath = '';
let runtimePath = '';
let dockerLog = '';
let cloneState = '';
let markerState = '';
let request: CommunitiesStagingRoleSplitRestoreMarkerRequest;

async function execute(path: string, originalCommand: string, extraEnv = {}): Promise<Result> {
  return await new Promise((resolve) => {
    execFile(
      '/bin/sh',
      [path],
      {
        env: {
          ...process.env,
          PATH: `${binRoot}:${process.env.PATH ?? ''}`,
          PHUB_TEST_APP_ROOT: appRoot,
          PHUB_TEST_BACKUP_ROOT: backupRoot,
          PHUB_TEST_CLEANUP_REQUEST_ROOT: cleanupRequestRoot,
          PHUB_TEST_CLONE_STATE: cloneState,
          PHUB_TEST_DOCKER_LOG: dockerLog,
          PHUB_TEST_EVIDENCE: evidencePath,
          PHUB_TEST_HELPER: helperPath,
          PHUB_TEST_MARKER_STATE: markerState,
          PHUB_TEST_REQUEST_ROOT: requestRoot,
          PHUB_TEST_SCRIPT_CLEANUP: cleanupPath,
          PHUB_TEST_SCRIPT_CEREMONY: ceremonyPath,
          PHUB_TEST_STATE_ROOT: stateRoot,
          PHUB_TEST_BIN_ROOT: binRoot,
          PHUB_COMMUNITIES_MARKER_TIMEOUT_ACTIVE: '1',
          PHUB_COMMUNITIES_MARKER_CLEANUP_TIMEOUT_ACTIVE: '1',
          SSH_ORIGINAL_COMMAND: originalCommand,
          ...extraEnv,
        },
      },
      (error, stdout, stderr) =>
        resolve({ code: error && 'code' in error ? Number(error.code) : 0, stdout, stderr }),
    );
  });
}

async function runCeremony(extraEnv = {}): Promise<Result> {
  const contents = canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(request);
  await writeFile(requestPath, contents, 'utf8');
  return execute(
    ceremonyPath,
    `RUN_COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CEREMONY_V1 communities-role-split-marker-request-123-4.txt ${sha256(contents)} communities-role-split-marker-runtime-123-4.txt ${sha256(await readFile(runtimePath))}`,
    extraEnv,
  );
}

async function runCleanup(extraEnv = {}, cloneOid = '45678'): Promise<Result> {
  const marker = await readFile(markerState, 'utf8');
  const markerRequestSha = sha256(
    canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(request),
  );
  const cleanupRequest = `PHUB_COMMUNITIES_ROLE_SPLIT_CLONE_MARKER_CLEANUP_REQUEST_V2
restoreDatabase=phub_restore_123_4
cloneDatabaseOid=${cloneOid}
cloneDatabaseOwner=phub_staging
cloneDatabaseOwnerOid=16384
markerRequestSha256=${markerRequestSha}
markerValue=${marker}
restoreRunId=123
restoreRunAttempt=4
cleanupWriterSha256=${sha256(await readFile(cleanupPath))}
`;
  await writeFile(
    join(cleanupRequestRoot, 'communities-role-split-marker-cleanup-request-123-4.txt'),
    cleanupRequest,
    'utf8',
  );
  return execute(
    cleanupPath,
    `CLEANUP_COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CLONE_V1 communities-role-split-marker-cleanup-request-123-4.txt ${sha256(cleanupRequest)} communities-role-split-marker-runtime-123-4.txt ${sha256(await readFile(runtimePath))}`,
    extraEnv,
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'phub-role-split-ceremony-'));
  requestRoot = join(root, 'requests');
  cleanupRequestRoot = join(root, 'cleanup-requests');
  backupRoot = join(root, 'backups');
  stateRoot = join(root, 'state');
  appRoot = join(root, 'app');
  binRoot = join(root, 'bin');
  ceremonyPath = join(root, 'ceremony.sh');
  cleanupPath = join(root, 'cleanup.sh');
  helperPath = join(root, 'verify-helper.sh');
  requestPath = join(requestRoot, 'communities-role-split-marker-request-123-4.txt');
  backupPath = join(backupRoot, 'postgres-communities-rehearsal-20260819T120000Z-123.dump');
  evidencePath = `${backupPath}.evidence`;
  dockerLog = join(root, 'docker.log');
  cloneState = join(root, 'clone.exists');
  markerState = join(root, 'database.comment');
  runtimePath = join(requestRoot, 'communities-role-split-marker-runtime-123-4.txt');
  await Promise.all(
    [requestRoot, cleanupRequestRoot, backupRoot, stateRoot, appRoot, binRoot].map((path) =>
      mkdir(path),
    ),
  );
  await Promise.all([
    writeFile(helperPath, '#!/usr/bin/env sh\nexit 99\n', 'utf8'),
    writeFile(backupPath, 'ownership-and-acl-preserving-archive', 'utf8'),
    writeFile(evidencePath, 'fixed-redacted-backup-evidence\n', 'utf8'),
    writeFile(join(appRoot, 'release.env'), `RELEASE=${'f'.repeat(40)}\n`, 'utf8'),
    writeFile(join(appRoot, 'infrastructure.env'), 'POSTGRES_DB=phub_staging\n', 'utf8'),
    writeFile(
      join(appRoot, 'compose.infrastructure.yaml'),
      'services:\n  postgres:\n    image: pinned\n',
      'utf8',
    ),
  ]);

  const [ceremony, cleanup] = await Promise.all([
    readFile(ceremonySource, 'utf8'),
    readFile(cleanupSource, 'utf8'),
  ]);
  await Promise.all([
    writeFile(
      ceremonyPath,
      ceremony
        .replace(
          'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
          'PATH=$PHUB_TEST_BIN_ROOT:/usr/bin:/bin:/usr/sbin:/sbin',
        )
        .replaceAll('/usr/bin/timeout', join(binRoot, 'timeout'))
        .replaceAll('/usr/bin/sync', join(binRoot, 'sync'))
        .replace('/proc/$$/fd/8', backupPath)
        .replace('/var/lib/phub-preflight/role-split-marker-requests', requestRoot)
        .replace('/var/lib/phub-preflight/backups', backupRoot)
        .replace('/var/lib/phub-preflight/role-split-marker-state', stateRoot)
        .replace('/opt/phub', appRoot)
        .replace('/usr/local/libexec/phub/verify-postgres-backup-restore.sh', helperPath),
      'utf8',
    ),
    writeFile(
      cleanupPath,
      cleanup
        .replace(
          'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
          'PATH=$PHUB_TEST_BIN_ROOT:/usr/bin:/bin:/usr/sbin:/sbin',
        )
        .replaceAll('/usr/bin/timeout', join(binRoot, 'timeout'))
        .replaceAll('/usr/bin/sync', join(binRoot, 'sync'))
        .replace('/var/lib/phub-preflight/role-split-marker-cleanup-requests', cleanupRequestRoot)
        .replace('/var/lib/phub-preflight/role-split-marker-requests', requestRoot)
        .replace('/var/lib/phub-preflight/role-split-marker-state', stateRoot)
        .replace('/opt/phub', appRoot),
      'utf8',
    ),
  ]);
  await Promise.all([ceremonyPath, cleanupPath, helperPath].map((path) => chmod(path, 0o755)));

  await writeFile(
    join(binRoot, 'readlink'),
    '#!/usr/bin/env sh\ntest "$1" = -f || exit 1\nprintf "%s\\n" "$2"\n',
    'utf8',
  );
  await writeFile(
    join(binRoot, 'sha256sum'),
    '#!/usr/bin/env sh\n/usr/bin/shasum -a 256 "$@"\n',
    'utf8',
  );
  await writeFile(join(binRoot, 'flock'), '#!/usr/bin/env sh\nexit 0\n', 'utf8');
  await writeFile(
    join(binRoot, 'timeout'),
    '#!/usr/bin/env sh\ntest "${1:-}" = --version && { echo "timeout (GNU coreutils) 9.0"; exit 0; }\nexit 99\n',
    'utf8',
  );
  await writeFile(join(binRoot, 'sync'), '#!/usr/bin/env sh\nexit 0\n', 'utf8');
  await writeFile(
    join(binRoot, 'stat'),
    `#!/usr/bin/env sh
set -eu
test "$1" = -c
field=$2
path=$3
case "$path" in
  "$PHUB_TEST_REQUEST_ROOT"|"$PHUB_TEST_CLEANUP_REQUEST_ROOT") uid=0; gid=$(id -g); mode=750 ;;
  "$PHUB_TEST_BACKUP_ROOT") uid=0; gid=$(id -g); mode=750 ;;
  "$PHUB_TEST_STATE_ROOT") uid=$(id -u); gid=$(id -g); mode=700 ;;
  "$PHUB_TEST_APP_ROOT") uid=0; gid=0; mode=755; inode=100 ;;
  "$PHUB_TEST_APP_ROOT/infrastructure.env") uid=0; gid=0; mode=600; inode=101 ;;
  "$PHUB_TEST_APP_ROOT/compose.infrastructure.yaml") uid=0; gid=0; mode=644; inode=102 ;;
  "$PHUB_TEST_APP_ROOT/release.env") uid=0; gid=0; mode=644; inode=103 ;;
  "$PHUB_TEST_SCRIPT_CEREMONY"|"$PHUB_TEST_SCRIPT_CLEANUP"|"$PHUB_TEST_HELPER"|"$PHUB_TEST_BIN_ROOT/timeout"|"$PHUB_TEST_BIN_ROOT/sync") uid=0; gid=0; mode=755 ;;
  "$PHUB_TEST_REQUEST_ROOT"/*|"$PHUB_TEST_CLEANUP_REQUEST_ROOT"/*|"$PHUB_TEST_EVIDENCE") uid=0; gid=$(id -g); mode=440 ;;
  "$PHUB_TEST_BACKUP_ROOT"/*.dump) uid=0; gid=$(id -g); mode=440; inode=200 ;;
  "$PHUB_TEST_STATE_ROOT"/*) uid=$(id -u); gid=$(id -g); mode=600 ;;
  *) exit 1 ;;
esac
inode=\${inode:-300}; device=1; links=1
size=0; test -f "$path" && size=$(wc -c < "$path" | tr -d ' ')
case "$field" in
  %u) echo "$uid" ;; %g) echo "$gid" ;; %a) echo "$mode" ;; %d) echo "$device" ;;
  %i) echo "$inode" ;; %h) echo "$links" ;;
  %d:%i) echo "$device:$inode" ;;
  %d:%i:%s:%Y:%Z) echo "$device:$inode:$size:100:100" ;;
  %d:%i:%s:%Y:%Z:%h:%u:%g:%a) echo "$device:$inode:$size:100:100:$links:$uid:$gid:$mode" ;;
  *) exit 1 ;;
esac
`,
    'utf8',
  );
  await writeFile(
    join(binRoot, 'docker'),
    `#!/usr/bin/env sh
set -eu
test -z "\${DOCKER_HOST:-}\${DOCKER_CONTEXT:-}\${COMPOSE_FILE:-}\${COMPOSE_PROJECT_NAME:-}\${COMPOSE_PROFILES:-}" ||
  { printf '%s\n' SECRET_SENTINEL >&2; exit 95; }
printf '%s\n' "$*" >> "$PHUB_TEST_DOCKER_LOG"
all=$*
case "$all" in
  *compose*ps*postgres*) printf '%s\n' '${'c'.repeat(64)}' ;;
  *inspect*com.docker.compose.project*) printf '%s\n' '${'c'.repeat(64)}|sha256:${'d'.repeat(64)}|phubmarker|postgres' ;;
  *pg_restore*--list*)
    printf '%s\n' '1; 0 0 ACL - public postgres' '2; 0 0 DEFAULT ACL - TABLES postgres'
    ;;
  *createdb*template0*)
    if test "\${PHUB_TEST_TOOL_SENTINEL:-0}" = 1; then
      printf '%s\n' SECRET_SENTINEL
      printf '%s\n' SECRET_SENTINEL >&2
    fi
    printf '%s\n' 45678 > "$PHUB_TEST_CLONE_STATE"
    test "\${PHUB_TEST_CREATEDB_AMBIGUOUS:-0}" != 1 || exit 82
    ;;
  *pg_restore*--exit-on-error*)
    test "\${PHUB_TEST_RESTORE_FAIL:-0}" != 1 || exit 82
    ;;
  *dropdb*)
    rm -f "$PHUB_TEST_CLONE_STATE"
    if test "\${PHUB_TEST_DROP_REPLACEMENT:-0}" = 1; then printf '%s\n' 99999 > "$PHUB_TEST_CLONE_STATE"; exit 82; fi
    test "\${PHUB_TEST_DROP_AMBIGUOUS:-0}" != 1 || exit 82
    ;;
  *COMMENT*DATABASE*)
    marker=$(printf '%s\n' "$all" | sed -n "s/.* IS '\\([^']*\\)'.*/\\1/p")
    test -n "$marker" || marker=$(printf '%s\n' "$all" | grep -Eo 'phub-communities-role-split-clone-v1:[0-9a-f]{64}' | tail -1)
    printf '%s' "$marker" > "$PHUB_TEST_MARKER_STATE"
    test "\${PHUB_TEST_COMMENT_AMBIGUOUS:-0}" != 1 || exit 83
    ;;
  *shobj_description*)
    test -f "$PHUB_TEST_CLONE_STATE" || exit 0
    marker=''; test ! -f "$PHUB_TEST_MARKER_STATE" || marker=$(cat "$PHUB_TEST_MARKER_STATE")
    test "\${PHUB_TEST_BAD_READBACK:-0}" != 1 || marker=wrong
    oid=$(cat "$PHUB_TEST_CLONE_STATE")
    case "$all" in *r.rolname*) printf '%s|phub_staging|16384|%s\n' "$oid" "$marker" ;; *) printf '%s\n' "$marker" ;; esac
    ;;
  *rolcanlogin*) printf '%s\n' 'phub_staging|16384' ;;
  *server_version_num*) printf '%s\n' '160012' ;;
  *pg_control_system*) printf '%s\n' '16385|phub_staging|16384|7421000000000000000' ;;
  *filename*checksum*) printf '%s\n' '0001_first.sql|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
  *d.datname*phub_restore_123_4*)
    test -f "$PHUB_TEST_CLONE_STATE" || exit 0
    oid=$(cat "$PHUB_TEST_CLONE_STATE")
    case "$all" in *shobj_description*) marker=''; test ! -f "$PHUB_TEST_MARKER_STATE" || marker=$(cat "$PHUB_TEST_MARKER_STATE"); printf '%s|phub_staging|16384|%s\n' "$oid" "$marker" ;;
      *) printf '%s|phub_staging|16384\n' "$oid" ;;
    esac
    ;;
  *datname*phub_restore_123_4*) test -f "$PHUB_TEST_CLONE_STATE" && cat "$PHUB_TEST_CLONE_STATE" || true ;;
  *) printf '%s\n' "unexpected docker invocation: $all" >&2; exit 96 ;;
esac
`,
    'utf8',
  );
  await Promise.all(
    ['readlink', 'sha256sum', 'flock', 'stat', 'docker', 'timeout', 'sync'].map((name) =>
      chmod(join(binRoot, name), 0o755),
    ),
  );

  const [helper, installedCeremony, backup, evidence] = await Promise.all([
    readFile(helperPath),
    readFile(ceremonyPath),
    readFile(backupPath),
    readFile(evidencePath),
  ]);
  const ledger =
    '0001_first.sql|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n';
  const toc = '1; 0 0 ACL - public postgres\n2; 0 0 DEFAULT ACL - TABLES postgres\n';
  request = {
    restoreDatabase: 'phub_restore_123_4',
    expectedCloneDatabaseOwner: 'phub_staging',
    expectedCloneDatabaseOwnerOid: '16384',
    sourceDatabase: 'phub_staging',
    sourceDatabaseOid: '16385',
    sourceDatabaseOwner: 'phub_staging',
    sourceDatabaseOwnerOid: '16384',
    systemIdentifier: '7421000000000000000',
    backupBasename: 'postgres-communities-rehearsal-20260819T120000Z-123.dump',
    backupSha256: sha256(backup),
    backupBytes: String(backup.byteLength),
    backupEvidenceBasename: 'postgres-communities-rehearsal-20260819T120000Z-123.dump.evidence',
    backupEvidenceSha256: sha256(evidence),
    archiveTocSha256: sha256(toc),
    sourceLedgerSha256: sha256(ledger),
    sourceLedgerCount: '1',
    activeRelease: 'f'.repeat(40),
    restoreRunId: '123',
    restoreRunAttempt: '4',
    postgresMajor: '16',
    objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
    restoreHelperSha256: sha256(helper),
    markerWriterSha256: sha256(installedCeremony),
  };
  const [infrastructureEnv, composeInfrastructure, releaseEnv] = await Promise.all([
    readFile(join(appRoot, 'infrastructure.env')),
    readFile(join(appRoot, 'compose.infrastructure.yaml')),
    readFile(join(appRoot, 'release.env')),
  ]);
  await writeFile(
    runtimePath,
    `PHUB_COMMUNITIES_ROLE_SPLIT_MARKER_RUNTIME_BINDING_V1
appRootDevice=1
appRootInode=100
infrastructureEnvSha256=${sha256(infrastructureEnv)}
composeInfrastructureSha256=${sha256(composeInfrastructure)}
releaseEnvSha256=${sha256(releaseEnv)}
composeProjectName=phubmarker
postgresContainerId=${'c'.repeat(64)}
postgresImageId=sha256:${'d'.repeat(64)}
`,
    'utf8',
  );
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true });
});

describe('runnable role-split restore-marker clone ceremony', () => {
  it('restores ownership and ACLs, writes/readbacks the marker, and retains the clone', async () => {
    const result = await runCeremony();
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stderr).toBe('');
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(29);
    expect(result.stdout).toContain(
      'schemaVersion=communities-role-split-clone-marker-evidence-v1\nstatus=MARKED\n',
    );
    expect(result.stdout).toContain('binding.archiveOwnershipAcl=true\n');
    expect(result.stdout).toContain('authorizes.sharedDatabaseMutation=false\n');
    const calls = await readFile(dockerLog, 'utf8');
    expect(calls).toContain(
      'pg_restore -U "$POSTGRES_USER" --exit-on-error --no-password --dbname="$1"',
    );
    expect(calls).not.toContain('--no-owner');
    expect(calls).not.toContain('--no-acl');
    expect(calls).not.toContain('dropdb');
    await expect(readFile(cloneState)).resolves.toBeDefined();
    expect(
      await readFile(join(stateRoot, '.communities-role-split-marker-123-4.state'), 'utf8'),
    ).toMatch(/^MARKED\|[a-f0-9]{64}\|45678\|[a-f0-9]{64}\n$/u);
  }, 15_000);

  it('auto-cleans only the recorded clone OID before marker commit', async () => {
    const result = await runCeremony({ PHUB_TEST_RESTORE_FAIL: '1' });
    expect(result.code).not.toBe(0);
    const calls = await readFile(dockerLog, 'utf8');
    expect(calls).toContain('dropdb -U "$POSTGRES_USER" "$1"');
    await expect(readFile(cloneState)).rejects.toThrow();
    expect(
      await readFile(join(stateRoot, '.communities-role-split-marker-123-4.state'), 'utf8'),
    ).toMatch(/^CLEANED_PRE_MARKER\|[a-f0-9]{64}\|45678\n$/u);
  }, 15_000);

  it('never auto-cleans after the marker commit, including readback failure', async () => {
    const result = await runCeremony({ PHUB_TEST_BAD_READBACK: '1' });
    expect(result.code).not.toBe(0);
    const calls = await readFile(dockerLog, 'utf8');
    expect(calls).not.toContain('dropdb');
    await expect(readFile(cloneState)).resolves.toBeDefined();
  }, 15_000);

  it('never adopts or drops an ambiguous createdb outcome', async () => {
    const result = await runCeremony({ PHUB_TEST_CREATEDB_AMBIGUOUS: '1' });
    expect(result.stderr).toBe(
      'COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CEREMONY_CREATEDB_AMBIGUOUS\n',
    );
    expect(
      await readFile(join(stateRoot, '.communities-role-split-marker-123-4.state'), 'utf8'),
    ).toMatch(/^CANDIDATE_RECONCILIATION_REQUIRED\|[a-f0-9]{64}\n$/u);
    expect(await readFile(dockerLog, 'utf8')).not.toContain('dropdb');
    await expect(readFile(cloneState)).resolves.toBeDefined();
  }, 15_000);

  it('durably enters MARKER_PENDING before an ambiguous comment and retains the clone', async () => {
    const result = await runCeremony({ PHUB_TEST_COMMENT_AMBIGUOUS: '1' });
    expect(result.stderr).toBe(
      'COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CEREMONY_MARKER_ACTION_AMBIGUOUS\n',
    );
    expect(
      await readFile(join(stateRoot, '.communities-role-split-marker-123-4.state'), 'utf8'),
    ).toMatch(/^MARKER_PENDING\|[a-f0-9]{64}\|45678\|[a-f0-9]{64}\n$/u);
    expect(await readFile(dockerLog, 'utf8')).not.toContain('dropdb');
    await expect(readFile(cloneState)).resolves.toBeDefined();
  }, 15_000);

  it('scrubs Docker/Compose routing variables and never emits a secret sentinel', async () => {
    const result = await runCeremony({
      DOCKER_HOST: 'SECRET_SENTINEL',
      DOCKER_CONTEXT: 'SECRET_SENTINEL',
      COMPOSE_PROJECT_NAME: 'SECRET_SENTINEL',
      PHUB_TEST_TOOL_SENTINEL: '1',
    });
    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain('SECRET_SENTINEL');
  }, 15_000);

  it('fails artifact digest custody before the first Docker call', async () => {
    await writeFile(join(appRoot, 'compose.infrastructure.yaml'), 'tampered\n', 'utf8');
    const result = await runCeremony();
    expect(result.code).not.toBe(0);
    await expect(readFile(dockerLog)).rejects.toThrow();
  }, 15_000);

  it('completes an ambiguous drop only when the recorded OID is absent', async () => {
    expect((await runCeremony()).code).toBe(0);
    const result = await runCleanup({ PHUB_TEST_DROP_AMBIGUOUS: '1' });
    expect(result.code).toBe(0);
    expect(
      await readFile(join(stateRoot, '.communities-role-split-marker-123-4.state'), 'utf8'),
    ).toMatch(/^CLEANED\|[a-f0-9]{64}\|45678\|[a-f0-9]{64}\n$/u);
  }, 20_000);

  it('retains DROPPING and never drops a replacement database', async () => {
    expect((await runCeremony()).code).toBe(0);
    const result = await runCleanup({ PHUB_TEST_DROP_REPLACEMENT: '1' });
    expect(result.stderr).toBe(
      'COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CLEANUP_DATABASE_REPLACEMENT_DETECTED\n',
    );
    expect(await readFile(cloneState, 'utf8')).toBe('99999\n');
    expect(
      await readFile(join(stateRoot, '.communities-role-split-marker-123-4.state'), 'utf8'),
    ).toMatch(/^DROPPING\|[a-f0-9]{64}\|45678\|[a-f0-9]{64}\|[a-f0-9]{64}\n$/u);
  }, 20_000);

  it('requires a separate exact cleanup request bound to marker, request and clone OID', async () => {
    const ceremonyResult = await runCeremony();
    expect(ceremonyResult).toMatchObject({ code: 0, stderr: '' });
    const marker = await readFile(markerState, 'utf8');
    const markerRequestSha = sha256(
      canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(request),
    );
    const installedCleanup = await readFile(cleanupPath);
    const cleanupRequest = `PHUB_COMMUNITIES_ROLE_SPLIT_CLONE_MARKER_CLEANUP_REQUEST_V2
restoreDatabase=phub_restore_123_4
cloneDatabaseOid=45678
cloneDatabaseOwner=phub_staging
cloneDatabaseOwnerOid=16384
markerRequestSha256=${markerRequestSha}
markerValue=${marker}
restoreRunId=123
restoreRunAttempt=4
cleanupWriterSha256=${sha256(installedCleanup)}
`;
    const cleanupRequestPath = join(
      cleanupRequestRoot,
      'communities-role-split-marker-cleanup-request-123-4.txt',
    );
    const wrongOidRequest = cleanupRequest.replace(
      'cloneDatabaseOid=45678',
      'cloneDatabaseOid=45679',
    );
    await writeFile(cleanupRequestPath, wrongOidRequest, 'utf8');
    const rejectedCleanup = await execute(
      cleanupPath,
      `CLEANUP_COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CLONE_V1 communities-role-split-marker-cleanup-request-123-4.txt ${sha256(wrongOidRequest)} communities-role-split-marker-runtime-123-4.txt ${sha256(await readFile(runtimePath))}`,
    );
    expect(rejectedCleanup.stderr).toBe(
      'COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CLEANUP_STATE_BINDING_INVALID\n',
    );
    await expect(readFile(cloneState)).resolves.toBeDefined();

    await writeFile(cleanupRequestPath, cleanupRequest, 'utf8');
    const cleanupResult = await execute(
      cleanupPath,
      `CLEANUP_COMMUNITIES_ROLE_SPLIT_RESTORE_MARKER_CLONE_V1 communities-role-split-marker-cleanup-request-123-4.txt ${sha256(cleanupRequest)} communities-role-split-marker-runtime-123-4.txt ${sha256(await readFile(runtimePath))}`,
    );
    expect(cleanupResult.code).toBe(0);
    expect(cleanupResult.stderr).toBe('');
    expect(cleanupResult.stdout).toContain(
      'schemaVersion=communities-role-split-clone-marker-cleanup-evidence-v1\nstatus=CLEANED\n',
    );
    await expect(readFile(cloneState)).rejects.toThrow();
  }, 15_000);

  it('contains no role, grant, migration, deploy or shared-database mutation primitive', async () => {
    const [ceremony, cleanup] = await Promise.all([
      readFile(ceremonySource, 'utf8'),
      readFile(cleanupSource, 'utf8'),
    ]);
    expect(`${ceremony}\n${cleanup}`).not.toMatch(
      /\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER)\b|\bGRANT\b|\bREVOKE\b|\bdb:migrate\b|34_V1|docker\s+(?:push|deploy)|ALTER\s+DATABASE/iu,
    );
    expect(ceremony).toContain('PATH=/usr/sbin:/usr/bin:/sbin:/bin');
    expect(ceremony).toContain('/proc/$$/fd/8');
    expect(ceremony).toContain('CANDIDATE_RECONCILIATION_REQUIRED');
    expect(ceremony).toContain('MARKER_PENDING');
    expect(cleanup).toContain('DROPPING');
    expect(`${ceremony}\n${cleanup}`).toContain('--kill-after=15s');
    expect(`${ceremony}\n${cleanup}`).toContain('ulimit -f 128');
  });
});
