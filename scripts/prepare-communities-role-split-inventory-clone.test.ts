import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest,
  COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
  type CommunitiesStagingRoleSplitRestoreMarkerRequest,
} from '@phub/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const commandSource = new URL(
  '../deploy/jetson/prepare-communities-role-split-inventory-clone.sh',
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
let backupRoot = '';
let binRoot = '';
let scriptPath = '';
let helperPath = '';
let requestPath = '';
let backupPath = '';
let evidencePath = '';
let baseRequest: CommunitiesStagingRoleSplitRestoreMarkerRequest;

async function execute(originalCommand: string): Promise<Result> {
  return await new Promise((resolve) => {
    execFile(
      '/bin/sh',
      [scriptPath],
      {
        env: {
          ...process.env,
          PATH: `${binRoot}:${process.env.PATH ?? ''}`,
          PHUB_TEST_BACKUP_ROOT: backupRoot,
          PHUB_TEST_HELPER: helperPath,
          PHUB_TEST_REQUEST_ROOT: requestRoot,
          PHUB_TEST_SCRIPT: scriptPath,
          SSH_ORIGINAL_COMMAND: originalCommand,
        },
      },
      (error, stdout, stderr) =>
        resolve({ code: error && 'code' in error ? Number(error.code) : 0, stdout, stderr }),
    );
  });
}

async function installRequest(contents: string, requestSha = sha256(contents)): Promise<Result> {
  await writeFile(requestPath, contents, 'utf8');
  return execute(
    `PREPARE_COMMUNITIES_ROLE_SPLIT_INVENTORY_CLONE_V1 communities-role-split-marker-request-123-4.txt ${requestSha}`,
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'phub-role-split-marker-'));
  requestRoot = join(root, 'requests');
  backupRoot = join(root, 'backups');
  binRoot = join(root, 'bin');
  scriptPath = join(root, 'prepare-marker.sh');
  helperPath = join(root, 'verify-helper.sh');
  requestPath = join(requestRoot, 'communities-role-split-marker-request-123-4.txt');
  const backupBasename = 'postgres-communities-rehearsal-20260819T120000Z-123.dump';
  backupPath = join(backupRoot, backupBasename);
  evidencePath = join(backupRoot, `${backupBasename}.evidence`);
  await Promise.all([mkdir(requestRoot), mkdir(backupRoot), mkdir(binRoot)]);
  await Promise.all([
    writeFile(helperPath, '#!/usr/bin/env sh\nexit 99\n', 'utf8'),
    writeFile(backupPath, 'ownership-preserving-backup', 'utf8'),
    writeFile(evidencePath, 'redacted-backup-evidence\n', 'utf8'),
  ]);

  const original = await readFile(commandSource, 'utf8');
  const isolated = original
    .replace('/var/lib/phub-preflight/role-split-marker-requests', requestRoot)
    .replace('/var/lib/phub-preflight/backups', backupRoot)
    .replace('/usr/local/libexec/phub/verify-postgres-backup-restore.sh', helperPath);
  await writeFile(scriptPath, isolated, 'utf8');
  await chmod(scriptPath, 0o755);

  await writeFile(
    join(binRoot, 'readlink'),
    '#!/usr/bin/env sh\ntest "$1" = -f || exit 1\nprintf "%s\\n" "$2"\n',
    'utf8',
  );
  await writeFile(
    join(binRoot, 'sha256sum'),
    '#!/usr/bin/env sh\n/usr/bin/shasum -a 256 "$1"\n',
    'utf8',
  );
  await writeFile(
    join(binRoot, 'stat'),
    `#!/usr/bin/env sh
set -eu
test "$1" = -c
field=$2
path=$3
case "$path" in
  "$PHUB_TEST_REQUEST_ROOT") uid=0; gid=$(id -g); mode=750 ;;
  "$PHUB_TEST_BACKUP_ROOT") uid=$(id -u); gid=$(id -g); mode=700 ;;
  "$PHUB_TEST_SCRIPT"|"$PHUB_TEST_HELPER") uid=0; gid=0; mode=755 ;;
  "$PHUB_TEST_REQUEST_ROOT"/*|"$PHUB_TEST_BACKUP_ROOT"/*.evidence) uid=0; gid=$(id -g); mode=440 ;;
  "$PHUB_TEST_BACKUP_ROOT"/*.dump) uid=$(id -u); gid=$(id -g); mode=600 ;;
  *) exit 1 ;;
esac
case "$field" in %u) echo "$uid" ;; %g) echo "$gid" ;; %a) echo "$mode" ;; *) exit 1 ;; esac
`,
    'utf8',
  );
  const tripwireLog = join(root, 'dangerous-child.log');
  for (const name of ['docker', 'psql', 'createdb', 'pg_restore', 'dropdb']) {
    await writeFile(
      join(binRoot, name),
      `#!/usr/bin/env sh\nprintf '%s\\n' '${name}' >> '${tripwireLog}'\nexit 97\n`,
      'utf8',
    );
  }
  await Promise.all(
    ['readlink', 'sha256sum', 'stat', 'docker', 'psql', 'createdb', 'pg_restore', 'dropdb'].map(
      (name) => chmod(join(binRoot, name), 0o755),
    ),
  );

  const [helper, script, backup, evidence] = await Promise.all([
    readFile(helperPath),
    readFile(scriptPath),
    readFile(backupPath),
    readFile(evidencePath),
  ]);
  baseRequest = {
    restoreDatabase: 'phub_restore_123_4',
    expectedCloneDatabaseOwner: 'phub_staging',
    expectedCloneDatabaseOwnerOid: '16384',
    sourceDatabase: 'phub_staging',
    sourceDatabaseOid: '16385',
    sourceDatabaseOwner: 'phub_staging',
    sourceDatabaseOwnerOid: '16384',
    systemIdentifier: '7421000000000000000',
    backupBasename,
    backupSha256: sha256(backup),
    backupBytes: String(backup.byteLength),
    backupEvidenceBasename: `${backupBasename}.evidence`,
    backupEvidenceSha256: sha256(evidence),
    archiveTocSha256: 'd'.repeat(64),
    sourceLedgerSha256: 'e'.repeat(64),
    sourceLedgerCount: '91',
    activeRelease: 'f'.repeat(40),
    restoreRunId: '123',
    restoreRunAttempt: '4',
    postgresMajor: '16',
    objectManifestSha256: COMMUNITIES_STAGING_ROLE_SPLIT_CLONE_MANIFEST_SHA256,
    restoreHelperSha256: sha256(helper),
    markerWriterSha256: sha256(script),
  };
});

afterEach(async () => {
  if (root) await rm(root, { recursive: true });
});

describe('role split marker writer pre-execution gate', () => {
  it('validates every bound artifact and then refuses before execution', async () => {
    const result = await installRequest(
      canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(baseRequest),
    );
    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_EXECUTION_NOT_AUTHORIZED\n',
    });
    await expect(readFile(join(root, 'dangerous-child.log'), 'utf8')).rejects.toThrow();
  });

  it.each([
    ['reordered lines', (lines: string[]) => [lines[0]!, lines[2]!, lines[1]!, ...lines.slice(3)]],
    ['missing line', (lines: string[]) => lines.slice(0, -1)],
    ['duplicate line', (lines: string[]) => [...lines, lines[23]!]],
    ['extra line', (lines: string[]) => [...lines, 'unexpected=value']],
  ])(
    'rejects %s',
    async (_label, mutate) => {
      const canonical = canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(baseRequest);
      const result = await installRequest(
        `${mutate(canonical.trimEnd().split('\n')).join('\n')}\n`,
      );
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        'COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_REQUEST_SHAPE_INVALID\n',
      );
    },
    15_000,
  );

  it('rejects CRLF, database/run mismatch and malformed values', async () => {
    const canonical = canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(baseRequest);
    const cases = [
      canonical.replaceAll('\n', '\r\n'),
      canonical.replace('sourceDatabase=phub_staging', 'sourceDatabase=phub_staging\0ignored'),
      canonical.trimEnd(),
      canonical.replace('restoreDatabase=phub_restore_123_4', 'restoreDatabase=phub_restore_123_5'),
      canonical.replace('sourceLedgerCount=91', 'sourceLedgerCount=0'),
    ];
    for (const contents of cases) {
      const result = await installRequest(contents);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(
        /^COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_REQUEST_(SHAPE|BINDING)_INVALID\n$/u,
      );
    }
  });

  it('rejects token, arity, traversal and request digest mismatches', async () => {
    const canonical = canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(baseRequest);
    await writeFile(requestPath, canonical, 'utf8');
    const digest = sha256(canonical);
    const commands = [
      `WRONG communities-role-split-marker-request-123-4.txt ${digest}`,
      'PREPARE_COMMUNITIES_ROLE_SPLIT_INVENTORY_CLONE_V1 communities-role-split-marker-request-123-4.txt',
      `PREPARE_COMMUNITIES_ROLE_SPLIT_INVENTORY_CLONE_V1 ../request.txt ${digest}`,
      `PREPARE_COMMUNITIES_ROLE_SPLIT_INVENTORY_CLONE_V1 communities-role-split-marker-request-123-4.txt ${'0'.repeat(64)}`,
    ];
    for (const originalCommand of commands) {
      const result = await execute(originalCommand);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(
        /^COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_(CONFIRMATION|REQUEST_(PATH|SHA))_INVALID\n$/u,
      );
    }
  });

  it('binds the request basename to the request run and attempt', async () => {
    const canonical = canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(baseRequest);
    const mismatchedPath = join(requestRoot, 'communities-role-split-marker-request-124-4.txt');
    await writeFile(mismatchedPath, canonical, 'utf8');
    const result = await execute(
      `PREPARE_COMMUNITIES_ROLE_SPLIT_INVENTORY_CLONE_V1 communities-role-split-marker-request-124-4.txt ${sha256(canonical)}`,
    );
    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_REQUEST_BINDING_INVALID\n',
    });
  });

  it('rejects request symlinks and mismatched helper or writer digests', async () => {
    const canonical = canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(baseRequest);
    const alternate = join(root, 'alternate-request.txt');
    await writeFile(alternate, canonical, 'utf8');
    await symlink(alternate, requestPath);
    const symlinkResult = await execute(
      `PREPARE_COMMUNITIES_ROLE_SPLIT_INVENTORY_CLONE_V1 communities-role-split-marker-request-123-4.txt ${sha256(canonical)}`,
    );
    expect(symlinkResult.stderr).toBe(
      'COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_REQUEST_CUSTODY_INVALID\n',
    );
    await rm(requestPath);

    for (const override of [
      { restoreHelperSha256: '1'.repeat(64) },
      { markerWriterSha256: '1'.repeat(64) },
    ]) {
      const result = await installRequest(
        canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest({
          ...baseRequest,
          ...override,
        }),
      );
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(
        /^COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_(RESTORE_HELPER|SCRIPT)_CUSTODY_INVALID\n$/u,
      );
    }
  });

  it('rejects backup and evidence digest or byte mismatches', async () => {
    for (const override of [
      { backupSha256: '1'.repeat(64) },
      { backupBytes: '1' },
      { backupEvidenceSha256: '1'.repeat(64) },
    ]) {
      const result = await installRequest(
        canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest({
          ...baseRequest,
          ...override,
        }),
      );
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(
        /^COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_BACKUP(?:_EVIDENCE)?_CUSTODY_INVALID\n$/u,
      );
    }
  });

  it('fails closed when the byte-level request inspector fails or emits no bytes', async () => {
    for (const body of ['#!/usr/bin/env sh\nexit 98\n', '#!/usr/bin/env sh\nexit 0\n']) {
      await writeFile(join(binRoot, 'od'), body, 'utf8');
      await chmod(join(binRoot, 'od'), 0o755);
      const result = await installRequest(
        canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(baseRequest),
      );
      expect(result).toEqual({
        code: 1,
        stdout: '',
        stderr: 'COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_REQUEST_SHAPE_INVALID\n',
      });
    }
  });

  it('contains no database, container, cleanup or role-mutation command', async () => {
    const source = await readFile(commandSource, 'utf8');
    expect(source).not.toMatch(
      /\bdocker\b|\bpsql\b|\bcreatedb\b|\bpg_restore\b|COMMENT ON DATABASE|\bdropdb\b|\brm\b|\bGRANT\b|\bALTER\s+(?:ROLE|USER)\b/iu,
    );
  });
});
