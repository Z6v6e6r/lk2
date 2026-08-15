import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const rehearsal = fileURLToPath(
  new URL('../deploy/jetson/rehearse-media-migration.sh', import.meta.url),
);
const ledgerVerifier = fileURLToPath(
  new URL('../deploy/jetson/verify-media-migration-ledger.sh', import.meta.url),
);
const temporaryDirectories: string[] = [];
const checksum = 'a'.repeat(64);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function execute(
  input: {
    readonly failCreateResponse?: boolean;
    readonly failFinalDrop?: boolean;
    readonly failMediaRuntimeProbe?: boolean;
    readonly failPreRoleBoundary?: boolean;
    readonly failRestore?: boolean;
    readonly ledgerChecksum?: string;
    readonly migratorUrl?: string;
    readonly preexistingClone?: boolean;
    readonly secondMigratorOutput?: string;
    readonly sharedDatabase?: string;
    readonly totalPolicies?: number;
    readonly validatedCommandConstraints?: number;
    readonly exactCommandConstraintDefinitions?: number;
    readonly profileCommandColumnState?: number;
    readonly profileCommandDefault?: number;
    readonly runtimeUrl?: string;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'phub-media-migration-rehearsal-'));
  temporaryDirectories.push(directory);
  const appRoot = join(directory, 'app');
  const backupRoot = join(directory, 'backups');
  const fakeBin = join(directory, 'bin');
  const dockerLog = join(directory, 'docker.log');
  const databaseState = join(directory, 'database.state');
  const migratorCount = join(directory, 'migrator.count');
  mkdirSync(appRoot);
  mkdirSync(backupRoot);
  mkdirSync(fakeBin);
  copyFileSync(ledgerVerifier, join(appRoot, 'verify-media-migration-ledger.sh'));
  const backup = join(backupRoot, 'postgres-pre-candidate.dump');
  writeFileSync(backup, 'custom-format-backup');
  writeFileSync(dockerLog, '');
  writeFileSync(databaseState, input.preexistingClone ? '1\n' : '0\n');
  writeFileSync(migratorCount, '0\n');
  writeFileSync(
    join(fakeBin, 'docker'),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *'printf %s "$POSTGRES_DB"'*) printf '%s' "$FAKE_SHARED_DATABASE" ;;
  *'select count(*) from pg_database'*) cat "$FAKE_DATABASE_STATE" ;;
  *'--entrypoint node migrator -e'*)
    for argument do role_target_script="$argument"; done
    node -e "$role_target_script"
    ;;
  *'apps/migrator/dist/verify-role-boundary.js'*)
    printf 'ROLE_BOUNDARY_PHASE=%s\n' "$DATABASE_ROLE_BOUNDARY_PHASE" >> "$FAKE_DOCKER_LOG"
    test "$DATABASE_ROLE_BOUNDARY_PHASE" != pre || test "$FAKE_PRE_ROLE_BOUNDARY_FAIL" != true
    ;;
  *'apps/migrator/dist/verify-media-runtime-role.js'*)
    printf 'MEDIA_RUNTIME_PROBE tenant=%s\n' "$MEDIA_RUNTIME_TENANT_KEY" >> "$FAKE_DOCKER_LOG"
    test "$FAKE_MEDIA_RUNTIME_PROBE_FAIL" != true
    ;;
  *'createdb -U "$POSTGRES_USER" --template=template0'*)
    printf '%s\n' 1 > "$FAKE_DATABASE_STATE"
    test "$FAKE_CREATE_RESPONSE_FAIL" != true
    ;;
  *'dropdb -U "$POSTGRES_USER" --if-exists --force'*) printf '%s\n' 0 > "$FAKE_DATABASE_STATE" ;;
  *'dropdb -U "$POSTGRES_USER" --force'*)
    test "$FAKE_FINAL_DROP_FAIL" != true || exit 1
    printf '%s\n' 0 > "$FAKE_DATABASE_STATE"
    ;;
  *'pg_restore -U "$POSTGRES_USER"'*)
    cat >/dev/null
    test "$FAKE_RESTORE_FAIL" != true
    ;;
  *'--entrypoint sh migrator -ec'*)
    count="$(cat "$FAKE_MIGRATOR_COUNT")"
    count=$((count + 1))
    printf '%s\n' "$count" > "$FAKE_MIGRATOR_COUNT"
    if test "$count" -eq 2 && test -n "$FAKE_SECOND_MIGRATOR_OUTPUT"; then
      printf '%s\n' "$FAKE_SECOND_MIGRATOR_OUTPUT"
    fi
    ;;
  *'show server_version_num'*) printf '%s\n' 160010 ;;
  *'select rolsuper from pg_catalog.pg_roles'*) printf '%s\n' t ;;
  *"select filename || '|' || checksum"*) printf '%s|%s\n' '0001_test.sql' "$FAKE_LEDGER_CHECKSUM" ;;
  *'where (delivery_url is null)'*) printf '0|1|3|1|3|%s|%s|%s|%s|%s\n' "$FAKE_TOTAL_POLICIES" "$FAKE_VALIDATED_COMMAND_CONSTRAINTS" "$FAKE_EXACT_COMMAND_CONSTRAINT_DEFINITIONS" "$FAKE_PROFILE_COMMAND_COLUMN_STATE" "$FAKE_PROFILE_COMMAND_DEFAULT" ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(join(fakeBin, 'docker'), 0o700);
  const manifest = Buffer.from(`${checksum}|0001_test.sql\n`, 'utf8').toString('base64');
  const result = spawnSync('/bin/sh', [rehearsal, backup, 'phub_restore_123_1', manifest], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      PHUB_APP_ROOT: appRoot,
      PHUB_BACKUP_ROOT: backupRoot,
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_DATABASE_STATE: databaseState,
      FAKE_MIGRATOR_COUNT: migratorCount,
      FAKE_SHARED_DATABASE: input.sharedDatabase ?? 'phub',
      FAKE_CREATE_RESPONSE_FAIL: String(input.failCreateResponse ?? false),
      FAKE_PRE_ROLE_BOUNDARY_FAIL: String(input.failPreRoleBoundary ?? false),
      FAKE_MEDIA_RUNTIME_PROBE_FAIL: String(input.failMediaRuntimeProbe ?? false),
      FAKE_RESTORE_FAIL: String(input.failRestore ?? false),
      FAKE_FINAL_DROP_FAIL: String(input.failFinalDrop ?? false),
      FAKE_SECOND_MIGRATOR_OUTPUT: input.secondMigratorOutput ?? '',
      FAKE_LEDGER_CHECKSUM: input.ledgerChecksum ?? checksum,
      FAKE_TOTAL_POLICIES: String(input.totalPolicies ?? 3),
      FAKE_VALIDATED_COMMAND_CONSTRAINTS: String(input.validatedCommandConstraints ?? 2),
      FAKE_EXACT_COMMAND_CONSTRAINT_DEFINITIONS: String(
        input.exactCommandConstraintDefinitions ?? 2,
      ),
      FAKE_PROFILE_COMMAND_COLUMN_STATE: String(input.profileCommandColumnState ?? 4),
      FAKE_PROFILE_COMMAND_DEFAULT: String(input.profileCommandDefault ?? 1),
      RUNTIME_DATABASE_URL:
        input.runtimeUrl ?? 'postgresql://runtime:runtime-secret@postgres:5432/phub',
      MIGRATOR_DATABASE_URL:
        input.migratorUrl ?? 'postgresql://migrator:migrator-secret@postgres:5432/phub',
    },
  });
  return {
    result,
    log: readFileSync(dockerLog, 'utf8'),
    marker: join(backupRoot, '.restore-cleanup-phub_restore_123_1'),
  };
}

describe('media migration restore rehearsal', () => {
  it('restores, migrates and verifies only the isolated database before cleanup', () => {
    const { result, log } = execute();

    expect(result.status, result.stderr).toBe(0);
    const create = log.indexOf('createdb -U "$POSTGRES_USER" --template=template0');
    const restore = log.indexOf('pg_restore -U "$POSTGRES_USER"');
    const preRoleBoundary = log.indexOf('ROLE_BOUNDARY_PHASE=pre');
    const migrate = log.indexOf('--entrypoint sh migrator -ec');
    const postRoleBoundary = log.indexOf('ROLE_BOUNDARY_PHASE=post');
    const runtimeProbe = log.indexOf('MEDIA_RUNTIME_PROBE');
    const verify = log.lastIndexOf('show server_version_num');
    const finalDrop = log.lastIndexOf('dropdb -U "$POSTGRES_USER" --force');
    expect(create).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(create);
    expect(preRoleBoundary).toBeGreaterThan(restore);
    expect(migrate).toBeGreaterThan(preRoleBoundary);
    expect(postRoleBoundary).toBeGreaterThan(migrate);
    expect(runtimeProbe).toBeGreaterThan(postRoleBoundary);
    expect(log).toContain('MEDIA_RUNTIME_PROBE tenant=local-padel');
    expect(log).toContain('PHUB_RESTORE_DATABASE=phub_restore_123_1');
    expect(log.match(/--entrypoint sh migrator -ec/g)).toHaveLength(2);
    expect(verify).toBeGreaterThan(migrate);
    expect(finalDrop).toBeGreaterThan(verify);
    expect(result.stdout).toContain('media_migration_ledger database=phub_restore_123_1');
    expect(result.stdout).toContain(
      'media_clone_role_boundary phase=pre scope=media status=passed',
    );
    expect(result.stdout).toContain(
      'media_clone_role_boundary phase=post scope=media status=passed',
    );
    expect(result.stdout).toContain(
      'media_clone_runtime_role tenant_dml=passed cross_tenant_rls=passed rollback=confirmed status=passed',
    );
    expect(result.stdout).toContain('media_migration_rehearsal database=phub_restore_123_1');
    expect(result.stdout).toContain('rerun_applied=0 cleanup=confirmed status=passed');
    expect(log).not.toContain('--no-owner');
    expect(log).not.toContain('--no-acl');
  });

  it('fails before the clone migrator when ownership or default ACL role precheck fails', () => {
    const { result, log } = execute({ failPreRoleBoundary: true });

    expect(result.status).not.toBe(0);
    expect(log).toContain('ROLE_BOUNDARY_PHASE=pre');
    expect(log).not.toContain('--entrypoint sh migrator -ec');
    expect(log).toContain('dropdb -U "$POSTGRES_USER" --if-exists --force');
  });

  it('fails and cleans the clone when runtime tenant DML or RLS probing fails', () => {
    const { result, log } = execute({ failMediaRuntimeProbe: true });

    expect(result.status).not.toBe(0);
    expect(log).toContain('ROLE_BOUNDARY_PHASE=post');
    expect(log).toContain('MEDIA_RUNTIME_PROBE');
    expect(log).toContain('dropdb -U "$POSTGRES_USER" --if-exists --force');
  });

  it('fails before the migrator and still drops the clone when restore fails', () => {
    const { result, log } = execute({ failRestore: true });

    expect(result.status).not.toBe(0);
    expect(log).toContain('pg_restore -U "$POSTGRES_USER"');
    expect(log).not.toContain('--entrypoint sh migrator -ec');
    expect(log.lastIndexOf('dropdb -U "$POSTGRES_USER" --if-exists --force')).toBeGreaterThan(
      log.indexOf('pg_restore -U "$POSTGRES_USER"'),
    );
  });

  it('retains a CANDIDATE marker when createdb may have succeeded before response loss', () => {
    const { result, log, marker } = execute({ failCreateResponse: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('createdb outcome is uncertain');
    expect(readFileSync(marker, 'utf8')).toBe('CANDIDATE\n');
    expect(log).not.toContain('dropdb -U "$POSTGRES_USER"');
  });

  it('fails after migration and drops the clone when the exact ledger checksum differs', () => {
    const { result, log } = execute({ ledgerChecksum: 'b'.repeat(64) });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('migration checksum mismatch: 0001_test.sql');
    const migrate = log.indexOf('--entrypoint sh migrator -ec');
    const verify = log.lastIndexOf('show server_version_num');
    const finalDrop = log.lastIndexOf('dropdb -U "$POSTGRES_USER" --if-exists --force');
    expect(migrate).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(migrate);
    expect(finalDrop).toBeGreaterThan(verify);
  });

  it('fails closed and invokes best-effort cleanup when the strict final drop fails', () => {
    const { result, log } = execute({ failFinalDrop: true });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('media_migration_rehearsal');
    const strictDrop = log.indexOf('dropdb -U "$POSTGRES_USER" --force');
    const trappedDrop = log.lastIndexOf('dropdb -U "$POSTGRES_USER" --if-exists --force');
    expect(strictDrop).toBeGreaterThan(-1);
    expect(trappedDrop).toBeGreaterThan(strictDrop);
  });

  it('refuses a pre-existing clone without creating or dropping it', () => {
    const { result, log } = execute({ preexistingClone: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('restore database already exists');
    expect(log).not.toContain('createdb -U "$POSTGRES_USER"');
    expect(log).not.toContain('dropdb -U "$POSTGRES_USER"');
  });

  it('refuses a clone name equal to the shared database', () => {
    const { result, log } = execute({ sharedDatabase: 'phub_restore_123_1' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('restore database must differ from the shared database');
    expect(log).not.toContain('createdb -U "$POSTGRES_USER"');
  });

  it('refuses an external or drifted candidate migrator target before clone DDL', () => {
    const { result, log } = execute({
      migratorUrl: 'postgresql://migrator:secret@database.example:5432/phub',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'runtime and migrator DATABASE_URLs are not distinct local shared PostgreSQL roles',
    );
    expect(log).not.toContain('createdb -U "$POSTGRES_USER"');
  });

  it('refuses role aliasing and URL option overrides before clone DDL', () => {
    const aliased = execute({
      runtimeUrl: 'postgresql://same:runtime@postgres:5432/phub',
      migratorUrl: 'postgresql://same:migrator@postgres:5432/phub',
    });
    expect(aliased.result.status).not.toBe(0);
    expect(aliased.log).not.toContain('createdb -U "$POSTGRES_USER"');

    const encodedAlias = execute({
      runtimeUrl: 'postgresql://%73ame:runtime@postgres:5432/phub',
      migratorUrl: 'postgresql://same:migrator@postgres:5432/phub',
    });
    expect(encodedAlias.result.status).not.toBe(0);
    expect(encodedAlias.log).not.toContain('createdb -U "$POSTGRES_USER"');

    const options = execute({
      migratorUrl: 'postgresql://migrator:secret@postgres:5432/phub?host=database.example',
    });
    expect(options.result.status).not.toBe(0);
    expect(options.log).not.toContain('createdb -U "$POSTGRES_USER"');

    const malformedSecret = 'do-not-print-this-secret';
    const malformed = execute({
      migratorUrl: `postgresql://migrator:${malformedSecret}@%/phub`,
    });
    expect(malformed.result.status).not.toBe(0);
    expect(malformed.log).not.toContain('createdb -U "$POSTGRES_USER"');
    expect(malformed.result.stdout).not.toContain(malformedSecret);
    expect(malformed.result.stderr).not.toContain(malformedSecret);
  }, 15_000);

  it('requires the second candidate migrator invocation to be a no-op', () => {
    const { result, log } = execute({ secondMigratorOutput: 'Applied 0081_again.sql' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('second candidate migrator invocation was not a no-op');
    expect(log.match(/--entrypoint sh migrator -ec/g)).toHaveLength(2);
    expect(log).toContain('dropdb -U "$POSTGRES_USER" --if-exists --force');
  });

  it('rejects an additional permissive RLS policy on the isolated clone', () => {
    const { result, log } = execute({ totalPolicies: 4 });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'media schema, RLS, policy or command-constraint invariants failed',
    );
    expect(log).toContain('dropdb -U "$POSTGRES_USER" --if-exists --force');
  });

  it('rejects an unvalidated profile-photo command constraint on the isolated clone', () => {
    const { result, log } = execute({ validatedCommandConstraints: 1 });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'media schema, RLS, policy or command-constraint invariants failed',
    );
    expect(log).toContain('dropdb -U "$POSTGRES_USER" --if-exists --force');
  });

  it('rejects a changed profile-photo command constraint definition on the isolated clone', () => {
    const { result, log } = execute({ exactCommandConstraintDefinitions: 1 });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'media schema, RLS, policy or command-constraint invariants failed',
    );
    expect(log).toContain('dropdb -U "$POSTGRES_USER" --if-exists --force');
  });
});
