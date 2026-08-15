import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const verifier = fileURLToPath(
  new URL('../deploy/jetson/verify-postgres-backup-restore.sh', import.meta.url),
);
const temporaryDirectories: string[] = [];
const restoredLedgerManifest = `0001_test.sql|${'a'.repeat(64)}`;
const restoredLedgerDigest = createHash('sha256')
  .update(`${restoredLedgerManifest}\n`)
  .digest('hex');

class CommandFailure extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

interface Fixture {
  readonly root: string;
  readonly appRoot: string;
  readonly backup: string;
  readonly bin: string;
  readonly log: string;
  readonly markers: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'phub-restore-verify-'));
  temporaryDirectories.push(root);
  const appRoot = join(root, 'app');
  const markers = join(root, 'markers');
  const bin = join(root, 'bin');
  const backup = join(root, 'backup.dump');
  const log = join(root, 'docker.log');
  await Promise.all([mkdir(appRoot), mkdir(markers), mkdir(bin)]);
  await writeFile(join(appRoot, 'infrastructure.env'), 'POSTGRES_USER=phub\n', 'utf8');
  await writeFile(join(appRoot, 'compose.infrastructure.yaml'), 'services: {}\n', 'utf8');
  await writeFile(backup, 'synthetic archive', 'utf8');
  await writeFile(
    join(bin, 'df'),
    '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/test 9000000 1 %s 1%% /\\n" "${PHUB_TEST_AVAILABLE_KB:-8999999}"\n',
    'utf8',
  );
  await chmod(join(bin, 'df'), 0o755);
  await writeFile(
    join(bin, 'docker'),
    `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$PHUB_TEST_LOG"
case "$*" in
  *'select datname from pg_database'*)
    if [ "\${PHUB_TEST_COLLISION:-false}" = true ] || [ -f "$PHUB_TEST_CREATED_STATE" ]; then
      echo phub_restore_123_1
    fi
    ;;
  *'select pg_database_size(current_database())'*) echo 1048576 ;;
  *'createdb --template=template0'*)
    if [ "\${PHUB_TEST_FAIL_STAGE:-}" = create ]; then
      if [ "\${PHUB_TEST_CREATE_REACHED_SERVER:-false}" = true ]; then
        : > "$PHUB_TEST_CREATED_STATE"
      fi
      exit 1
    fi
    ;;
  *'pg_restore -U'*)
    if [ "\${PHUB_TEST_FAIL_STAGE:-}" = restore ]; then exit 1; fi
    ;;
  *'chat_push_foundation_snapshot_v1'*)
    if [ ! -f "$PHUB_TEST_FOUNDATION_SNAPSHOT_STATE" ]; then
      : > "$PHUB_TEST_FOUNDATION_SNAPSHOT_STATE"
      printf '%s\n' "\${PHUB_TEST_FOUNDATION_SOURCE:-snapshot-v1}"
    else
      printf '%s\n' "\${PHUB_TEST_FOUNDATION_RESTORED:-snapshot-v1}"
    fi
    ;;
  *'select count(*) from public.schema_migrations'*)
    if [ "\${PHUB_TEST_FAIL_STAGE:-}" = query ]; then exit 1; fi
    echo 77
    ;;
  *'dropdb'*)
    if [ "\${PHUB_TEST_FAIL_STAGE:-}" = drop ]; then exit 1; fi
    rm -f "$PHUB_TEST_CREATED_STATE"
    ;;
  *'show server_version_num'*) echo 160009 ;;
  *'select filename, checksum from public.schema_migrations order by filename'*)
    printf '%s\n' '${restoredLedgerManifest}'
    ;;
  *'pg_dump --version'*) echo 'pg_dump (PostgreSQL) 16.9' ;;
  *'pg_restore --version'*) echo 'pg_restore (PostgreSQL) 16.9' ;;
  *'psql --version'*) echo 'psql (PostgreSQL) 16.9' ;;
esac
`,
    'utf8',
  );
  await chmod(join(bin, 'docker'), 0o755);
  return { root, appRoot, backup, bin, log, markers };
}

function execute(
  input: Fixture,
  options: {
    readonly availableKb?: number;
    readonly collision?: boolean;
    readonly confirmation?:
      | 'VERIFY_STAGING_POSTGRES_BACKUP'
      | 'VERIFY_STAGING_POSTGRES_CAPACITY'
      | 'VERIFY_CHAT_PUSH_FOUNDATION_BACKUP';
    readonly createReachedServer?: boolean;
    readonly expectedLedgerDigest?: string;
    readonly failStage?: string;
    readonly foundationRestoredSnapshot?: string;
  } = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/sh',
      [
        verifier,
        options.confirmation === 'VERIFY_STAGING_POSTGRES_CAPACITY' ? '-' : input.backup,
        'phub_restore_123_1',
        options.confirmation ?? 'VERIFY_STAGING_POSTGRES_BACKUP',
      ],
      {
        env: {
          ...process.env,
          PATH: `${input.bin}:${process.env.PATH ?? ''}`,
          PHUB_APP_ROOT: input.appRoot,
          PHUB_RESTORE_MARKER_ROOT: input.markers,
          PHUB_POSTGRES_STORAGE_PATH: input.root,
          PHUB_TEST_COLLISION: options.collision ? 'true' : 'false',
          PHUB_TEST_AVAILABLE_KB: String(options.availableKb ?? 8_999_999),
          PHUB_TEST_CREATED_STATE: join(input.root, 'created.state'),
          PHUB_TEST_CREATE_REACHED_SERVER: options.createReachedServer ? 'true' : 'false',
          PHUB_TEST_FAIL_STAGE: options.failStage ?? '',
          PHUB_TEST_FOUNDATION_SOURCE: 'snapshot-v1',
          PHUB_TEST_FOUNDATION_RESTORED: options.foundationRestoredSnapshot ?? 'snapshot-v1',
          PHUB_TEST_FOUNDATION_SNAPSHOT_STATE: join(input.root, 'foundation-snapshot.state'),
          PHUB_TEST_LOG: input.log,
          PHUB_EXPECTED_SOURCE_LEDGER_DIGEST: options.expectedLedgerDigest ?? '',
        },
      },
      (error, stdout, stderr) => {
        if (error) reject(new CommandFailure(error.message, stdout, stderr));
        else resolve({ stdout, stderr });
      },
    );
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('PostgreSQL backup restore verifier', () => {
  it('restores, checks the ledger and removes the owned database', async () => {
    const input = await fixture();
    const result = await execute(input);
    const log = await readFile(input.log, 'utf8');

    expect(log).toContain('createdb --template=template0');
    expect(log).toContain('pg_restore -U');
    expect(log).toContain('select count(*) from public.schema_migrations');
    expect(log).toContain('show server_version_num');
    expect(log).toContain(
      'select filename, checksum from public.schema_migrations order by filename',
    );
    expect(log).toContain('dropdb --if-exists');
    expect(result.stdout).toContain('migrations=77');
    expect(result.stdout).toContain(`ledger_sha256=${restoredLedgerDigest}`);
    await expect(
      readFile(join(input.markers, '.restore-cleanup-phub_restore_123_1')),
    ).rejects.toThrow();
  });

  it('accepts only the exact source ledger digest and still removes the clone', async () => {
    const input = await fixture();
    const result = await execute(input, { expectedLedgerDigest: restoredLedgerDigest });
    expect(result.stdout).toContain(restoredLedgerDigest);

    const mismatchInput = await fixture();
    const failure = await execute(mismatchInput, {
      expectedLedgerDigest: 'b'.repeat(64),
    }).catch((error: CommandFailure) => error);
    const log = await readFile(mismatchInput.log, 'utf8');

    expect(failure).toBeInstanceOf(Error);
    expect((failure as CommandFailure).stderr).toContain(
      'restored migration ledger digest does not match',
    );
    expect(log).toContain('dropdb --if-exists');
  }, 15_000);

  it('never drops a colliding database that it did not create', async () => {
    const input = await fixture();
    const failure = await execute(input, { collision: true }).catch(
      (error: CommandFailure) => error,
    );
    const log = await readFile(input.log, 'utf8');

    expect(failure).toBeInstanceOf(Error);
    expect(log).not.toContain('createdb');
    expect(log).not.toContain('dropdb');
  });

  it('checks source-sized capacity without creating or restoring a database', async () => {
    const input = await fixture();
    const result = await execute(input, { confirmation: 'VERIFY_STAGING_POSTGRES_CAPACITY' });
    const log = await readFile(input.log, 'utf8');

    expect(result.stdout).toContain('restore capacity verified');
    expect(log).not.toContain('createdb');
    expect(log).not.toContain('pg_restore -U');
  });

  it('compares a content-free foundation snapshot between source and restored databases', async () => {
    const input = await fixture();
    const result = await execute(input, {
      confirmation: 'VERIFY_CHAT_PUSH_FOUNDATION_BACKUP',
      expectedLedgerDigest: restoredLedgerDigest,
    });
    const log = await readFile(input.log, 'utf8');

    expect(result.stdout).toContain('foundation source/restore snapshot verified');
    expect(result.stdout).toContain(`ledger_sha256=${restoredLedgerDigest}`);
    expect(log.match(/chat_push_foundation_snapshot_v1/g)).toHaveLength(2);
    expect(log).toContain('show server_version_num');
    expect(log).toContain(
      'select filename, checksum from public.schema_migrations order by filename',
    );
    expect(log).toContain('dropdb --if-exists');
  });

  it('fails closed and cleans the owned restore when the foundation snapshot differs', async () => {
    const input = await fixture();
    const failure = await execute(input, {
      confirmation: 'VERIFY_CHAT_PUSH_FOUNDATION_BACKUP',
      foundationRestoredSnapshot: 'different-snapshot',
    }).catch((error: CommandFailure) => error);
    const log = await readFile(input.log, 'utf8');

    expect(failure).toBeInstanceOf(CommandFailure);
    expect((failure as CommandFailure).stderr).toContain('source and restored snapshots differ');
    expect(log).toContain('dropdb --if-exists');
  });

  it('fails the pre-dump capacity gate before creating a database', async () => {
    const input = await fixture();
    const failure = await execute(input, {
      availableKb: 1,
      confirmation: 'VERIFY_STAGING_POSTGRES_CAPACITY',
    }).catch((error: CommandFailure) => error);
    const log = await readFile(input.log, 'utf8');

    expect(failure).toBeInstanceOf(Error);
    expect((failure as CommandFailure).stderr).toContain('insufficient disk headroom');
    expect(log).not.toContain('createdb');
    expect(log).not.toContain('pg_restore -U');
  });

  it('blocks a later attempt while any older cleanup marker exists', async () => {
    const input = await fixture();
    await writeFile(join(input.markers, '.restore-cleanup-phub_restore_999_1'), 'OWNED\n', 'utf8');
    const failure = await execute(input).catch((error: CommandFailure) => error);
    const log = await readFile(input.log, 'utf8').catch(() => '');

    expect(failure).toBeInstanceOf(Error);
    expect((failure as CommandFailure).stderr).toContain('unresolved restore cleanup marker');
    expect(log).not.toContain('createdb');
  });

  it('rejects a dangling cleanup-marker symlink', async () => {
    const input = await fixture();
    await symlink(
      join(input.root, 'missing-target'),
      join(input.markers, '.restore-cleanup-phub_restore_999_1'),
    );
    const failure = await execute(input).catch((error: CommandFailure) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as CommandFailure).stderr).toContain('unresolved restore cleanup marker');
  });

  it.each(['create', 'restore', 'query'])(
    'fails closed at %s and cleans only an owned database',
    async (failStage) => {
      const input = await fixture();
      const failure = await execute(input, { failStage }).catch((error: CommandFailure) => error);
      const log = await readFile(input.log, 'utf8');

      expect(failure).toBeInstanceOf(Error);
      if (failStage === 'create') expect(log).not.toContain('dropdb');
      else expect(log).toContain('dropdb --if-exists');
    },
  );

  it('surfaces cleanup failure and retains the recovery marker', async () => {
    const input = await fixture();
    const failure = await execute(input, { failStage: 'drop' }).catch(
      (error: CommandFailure) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as CommandFailure).stderr).toContain('cleanup failed; marker retained');
    await expect(
      readFile(join(input.markers, '.restore-cleanup-phub_restore_123_1'), 'utf8'),
    ).resolves.toBe('OWNED\n');
  });

  it('retains a CANDIDATE marker when createdb may have succeeded before response loss', async () => {
    const input = await fixture();
    const failure = await execute(input, {
      createReachedServer: true,
      failStage: 'create',
    }).catch((error: CommandFailure) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as CommandFailure).stderr).toContain('createdb outcome is uncertain');
    await expect(
      readFile(join(input.markers, '.restore-cleanup-phub_restore_123_1'), 'utf8'),
    ).resolves.toBe('CANDIDATE\n');
  }, 15_000);
});
