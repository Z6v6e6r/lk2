import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
let tripwireLog = '';
let baseRequest: CommunitiesStagingRoleSplitRestoreMarkerRequest;

async function execute(originalCommand: string, isolated = true): Promise<Result> {
  const executable = isolated ? scriptPath : fileURLToPath(commandSource);
  return await new Promise((resolve) => {
    execFile(
      '/bin/sh',
      [executable],
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
  root = await mkdtemp(join(tmpdir(), 'phub-role-split-negative-'));
  requestRoot = join(root, 'requests');
  backupRoot = join(root, 'backups');
  binRoot = join(root, 'bin');
  scriptPath = join(root, 'prepare-marker.sh');
  helperPath = join(root, 'verify-helper.sh');
  requestPath = join(requestRoot, 'communities-role-split-marker-request-123-4.txt');
  tripwireLog = join(root, 'dangerous-child.log');
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

describe('current role-split preparation adversarial boundary', () => {
  it.each([
    ['semicolon', (sentinel: string) => `; touch ${sentinel}`],
    ['subshell', (sentinel: string) => `$(touch ${sentinel})`],
    ['backticks', (sentinel: string) => `\`touch ${sentinel}\``],
    ['newline', () => '\nPREPARE_COMMUNITIES_ROLE_SPLIT_INVENTORY_CLONE_V1 injected'],
  ])('rejects %s shell command injection without reflecting it', async (_label, suffix) => {
    const sentinel = join(root, 'injected');
    const secret = 'postgres://runtime:secret@example.invalid/shared';
    const result = await execute(
      `PREPARE_COMMUNITIES_ROLE_SPLIT_INVENTORY_CLONE_V1 request.txt ${'a'.repeat(64)}${suffix(sentinel)} ${secret}`,
      false,
    );
    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_CONFIRMATION_INVALID\n',
    });
    expect(result.stderr).not.toContain(secret);
    await expect(readFile(sentinel, 'utf8')).rejects.toThrow();
  });

  it.each([
    [
      'SQL metacharacters',
      'sourceDatabase=phub_staging',
      'sourceDatabase=phub_staging;DROP_DATABASE',
    ],
    [
      'line injection',
      'sourceDatabase=phub_staging',
      'sourceDatabase=phub_staging\nrestoreRunId=999',
    ],
  ])(
    'rejects %s before any operation',
    async (_label, before, after) => {
      const canonical = canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(baseRequest);
      const result = await installRequest(canonical.replace(before, after));
      expect(result).toEqual({
        code: 1,
        stdout: '',
        stderr: 'COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_REQUEST_SHAPE_INVALID\n',
      });
      await expect(readFile(tripwireLog, 'utf8')).rejects.toThrow();
    },
    15_000,
  );

  it.each([
    ['shared database', 'phub_staging'],
    ['forbidden system database', 'postgres'],
  ])(
    'rejects the %s as the restore target',
    async (_label, target) => {
      const canonical = canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(baseRequest);
      const collision = canonical.replace(
        'restoreDatabase=phub_restore_123_4',
        `restoreDatabase=${target}`,
      );
      const result = await installRequest(collision);
      expect(result.stderr).toBe(
        'COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_REQUEST_BINDING_INVALID\n',
      );
      await expect(readFile(tripwireLog, 'utf8')).rejects.toThrow();
    },
    15_000,
  );

  it('rejects reordered lines and a mismatched request digest independently', async () => {
    const canonical = canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(baseRequest);
    const lines = canonical.trimEnd().split('\n');
    const reordered = `${[lines[0]!, lines[2]!, lines[1]!, ...lines.slice(3)].join('\n')}\n`;
    const orderResult = await installRequest(reordered);
    expect(orderResult.stderr).toBe(
      'COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_REQUEST_SHAPE_INVALID\n',
    );
    const digestResult = await installRequest(canonical, '0'.repeat(64));
    expect(digestResult.stderr).toBe(
      'COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_REQUEST_SHA_INVALID\n',
    );
  }, 15_000);

  it('replays a valid request as the same stateless refusal without cleanup or side effects', async () => {
    const canonical = canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(baseRequest);
    const first = await installRequest(canonical);
    const second = await installRequest(canonical);
    const expected = {
      code: 1,
      stdout: '',
      stderr: 'COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_EXECUTION_NOT_AUTHORIZED\n',
    };
    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    expect(await readFile(requestPath, 'utf8')).toBe(canonical);
    expect(await readFile(backupPath, 'utf8')).toBe('ownership-preserving-backup');
    expect(await readFile(evidencePath, 'utf8')).toBe('redacted-backup-evidence\n');
    await expect(readFile(tripwireLog, 'utf8')).rejects.toThrow();
    expect(await readdir(requestRoot)).toEqual(['communities-role-split-marker-request-123-4.txt']);
  }, 20_000);

  it('fails closed on a partial inspector failure and preserves all pre-marker inputs', async () => {
    await writeFile(join(binRoot, 'od'), '#!/usr/bin/env sh\nprintf partial\nexit 98\n', 'utf8');
    await chmod(join(binRoot, 'od'), 0o755);
    const canonical = canonicalCommunitiesStagingRoleSplitRestoreMarkerRequest(baseRequest);
    const result = await installRequest(canonical);
    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'COMMUNITIES_STAGING_ROLE_SPLIT_RESTORE_MARKER_WRITER_REQUEST_SHAPE_INVALID\n',
    });
    expect(await readFile(requestPath, 'utf8')).toBe(canonical);
    expect(await readFile(backupPath, 'utf8')).toBe('ownership-preserving-backup');
    await expect(readFile(tripwireLog, 'utf8')).rejects.toThrow();
  }, 15_000);

  it('contains no SQL, role mutation, clone or cleanup primitive', async () => {
    const source = await readFile(commandSource, 'utf8');
    expect(source).not.toMatch(
      /\beval\b|\bsh\s+-c\b|\bpsql\b|\bcreatedb\b|\bpg_restore\b|\bdropdb\b|COMMENT ON DATABASE|\bGRANT\b|\bALTER\s+(?:ROLE|USER)\b|\brm\b/iu,
    );
  });
});
