import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const provisioner = fileURLToPath(
  new URL('../deploy/jetson/prepare-communities-rehearsal-credentials.sh', import.meta.url),
);
const temporaryDirectories: string[] = [];

function execute(args: readonly string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
    execFile('/bin/sh', [provisioner, ...args], { env }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr });
      const failure = new Error(error.message, { cause: error });
      Object.assign(failure, { stdout, stderr });
      reject(failure);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixture(
  options: { readonly sameRole?: boolean; readonly extraMigratorKey?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'phub-rehearsal-credentials-'));
  temporaryDirectories.push(directory);
  const bin = join(directory, 'bin');
  const sourceRoot = join(directory, 'sources');
  const targetParent = join(directory, 'targets');
  const targetRoot = join(targetParent, 'communities-rehearsal');
  const runtime = join(sourceRoot, 'staging.env');
  const migrator = join(sourceRoot, 'staging.migrator.env');
  const realtime = join(sourceRoot, 'realtime.env');
  const verifier = join(directory, 'verify-runtime-env-isolation.sh');
  const runtimeUrl = 'postgresql://runtime:runtime-secret@postgres:5432/phub';
  const migratorUrl = options.sameRole
    ? runtimeUrl
    : 'postgresql://migrator:migrator-secret@postgres:5432/phub';
  await Promise.all([mkdir(bin), mkdir(sourceRoot), mkdir(targetParent)]);
  await Promise.all([
    writeFile(
      runtime,
      `APP_ENV=staging\nDATABASE_URL=${runtimeUrl}\nJWT_REALTIME_SECRET=${'r'.repeat(40)}\nCOMMUNITIES_REALTIME_ENABLED=false\n`,
    ),
    writeFile(
      migrator,
      `DATABASE_URL=${migratorUrl}\n${options.extraMigratorKey ? 'UNEXPECTED=true\n' : ''}`,
    ),
    writeFile(
      realtime,
      `DATABASE_URL=${runtimeUrl}\nJWT_REALTIME_SECRET=${'r'.repeat(40)}\nCOMMUNITIES_REALTIME_ENABLED=false\n`,
    ),
    writeFile(verifier, '#!/bin/sh\nexit 0\n'),
  ]);
  await chmod(verifier, 0o755);
  await writeFile(
    join(bin, 'id'),
    `#!/bin/sh
case "$1:$2" in
  '-u:') echo 0 ;;
  '-u:phub-deploy') echo 501 ;;
  '-g:phub-deploy') echo 502 ;;
  *) exit 1 ;;
esac
`,
  );
  await writeFile(
    join(bin, 'getent'),
    '#!/bin/sh\ntest "$1:$2" = group:phub-preflight\nprintf "%s\\n" phub-preflight:x:503:\n',
  );
  await writeFile(join(bin, 'readlink'), '#!/bin/sh\ntest "$1" = -f\nprintf "%s\\n" "$2"\n');
  await writeFile(join(bin, 'flock'), '#!/bin/sh\nexit 0\n');
  await writeFile(join(bin, 'chown'), '#!/bin/sh\nexit 0\n');
  await writeFile(join(bin, 'chmod'), '#!/bin/sh\nexit 0\n');
  await writeFile(join(bin, 'sync'), '#!/bin/sh\nexit 0\n');
  await writeFile(
    join(bin, 'stat'),
    `#!/bin/sh
set -eu
field=$2
path=$3
runtime_target='${targetRoot}/runtime.database.env'
migrator_target='${targetRoot}/migrator.database.env'
receipt_target='${targetRoot}/realtime-isolation.receipt'
case "$field:$path" in
  '%u:${runtime}'|'%u:${realtime}') echo 501 ;;
  '%g:${runtime}'|'%g:${realtime}'|'%g:${migrator}') echo 502 ;;
  '%u:${migrator}'|'%u:${verifier}'|'%u:${targetParent}'|'%u:${targetRoot}') echo 0 ;;
  '%a:${runtime}'|'%a:${realtime}'|'%a:${migrator}') echo 600 ;;
  '%a:${verifier}') echo 755 ;;
  '%a:${targetParent}') echo 755 ;;
  '%g:${targetRoot}') echo 503 ;;
  '%a:${targetRoot}') echo 750 ;;
  '%h:${runtime}'|'%h:${realtime}'|'%h:${migrator}') echo 1 ;;
  '%u:'"$runtime_target"|'%u:'"$migrator_target"|'%u:'"$receipt_target") echo 0 ;;
  '%g:'"$runtime_target"|'%g:'"$migrator_target"|'%g:'"$receipt_target") echo 503 ;;
  '%a:'"$runtime_target"|'%a:'"$migrator_target"|'%a:'"$receipt_target") echo 440 ;;
  '%h:'"$runtime_target"|'%h:'"$migrator_target"|'%h:'"$receipt_target") echo 1 ;;
  '%u:%g:%a:%h:'"$runtime_target"|'%u:%g:%a:%h:'"$migrator_target"|'%u:%g:%a:%h:'"$receipt_target") echo '0:503:440:1' ;;
  '%d:%i:%s:%y:%z:%u:%g:%a:%h:${runtime}') echo '1:101:140:100:501:502:600:1' ;;
  '%d:%i:%s:%y:%z:%u:%g:%a:%h:${migrator}') echo '1:102:80:100:0:502:600:1' ;;
  '%d:%i:%s:%y:%z:%u:%g:%a:%h:${realtime}') echo '1:103:140:100:501:502:600:1' ;;
  '%d:%i:%s:%y:%z:%u:%g:%a:%h:'"$runtime_target") echo '1:201:80:200:0:503:440:1' ;;
  '%d:%i:%s:%y:%z:%u:%g:%a:%h:'"$migrator_target") echo '1:202:82:200:0:503:440:1' ;;
  '%d:%i:%s:%y:%z:%u:%g:%a:%h:'"$receipt_target") echo '1:203:900:200:0:503:440:1' ;;
  *) printf 'unexpected stat: %s %s\\n' "$field" "$path" >&2; exit 1 ;;
esac
`,
  );
  await Promise.all(
    ['id', 'getent', 'readlink', 'flock', 'chown', 'chmod', 'sync', 'stat'].map((name) =>
      chmod(join(bin, name), 0o755),
    ),
  );
  return {
    directory,
    targetRoot,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      PHUB_DEPLOY_USER: 'phub-deploy',
      PHUB_MIGRATOR_ENV_SOURCE: migrator,
      PHUB_PREFLIGHT_GROUP: 'phub-preflight',
      PHUB_REALTIME_ENV_SOURCE: realtime,
      PHUB_REHEARSAL_CREDENTIAL_ROOT: targetRoot,
      PHUB_RUNTIME_ENV_SOURCE: runtime,
      PHUB_RUNTIME_ISOLATION_VERIFIER: verifier,
      PHUB_STAGING_GAMES_SOURCE: join(directory, 'staging.games.env'),
      PHUB_STAGING_OVERRIDE_SOURCE: join(directory, 'staging.override.env'),
    },
  };
}

describe('Communities rehearsal credential provisioning', () => {
  it('projects only the two database URLs and emits a metadata-only realtime receipt', async () => {
    const input = await fixture();
    const prepared = await execute(
      ['PREPARE_COMMUNITIES_REHEARSAL_CREDENTIALS_V1', 'prepare'],
      input.env,
    );
    expect(prepared.stderr).toBe('');
    expect(prepared.stdout).toBe(
      'COMMUNITIES_REHEARSAL_CREDENTIALS|operation=prepare|status=passed|secrets_exposed=false\n',
    );
    const runtimeTarget = await readFile(join(input.targetRoot, 'runtime.database.env'), 'utf8');
    const migratorTarget = await readFile(join(input.targetRoot, 'migrator.database.env'), 'utf8');
    const receipt = await readFile(join(input.targetRoot, 'realtime-isolation.receipt'), 'utf8');
    expect(runtimeTarget).toBe(
      'DATABASE_URL=postgresql://runtime:runtime-secret@postgres:5432/phub\n',
    );
    expect(migratorTarget).toBe(
      'DATABASE_URL=postgresql://migrator:migrator-secret@postgres:5432/phub\n',
    );
    expect(receipt).toContain('CONTRACT=COMMUNITIES_REHEARSAL_CREDENTIALS_V1');
    expect(receipt).toContain('EXPECTED_COMMUNITIES_REALTIME_ENABLED=false');
    expect(receipt).not.toContain('runtime-secret');
    expect(receipt).not.toContain('migrator-secret');
    expect(receipt).not.toContain('JWT_REALTIME_SECRET');

    const verified = await execute(
      ['PREPARE_COMMUNITIES_REHEARSAL_CREDENTIALS_V1', 'verify'],
      input.env,
    );
    expect(verified.stderr).toBe('');
    expect(verified.stdout).toBe(
      'COMMUNITIES_REHEARSAL_CREDENTIALS|operation=verify|status=passed|secrets_exposed=false\n',
    );
  }, 60_000);

  it('fails before creating targets when both sources resolve to the same database role', async () => {
    const input = await fixture({ sameRole: true });
    const failure = await execute(
      ['PREPARE_COMMUNITIES_REHEARSAL_CREDENTIALS_V1', 'prepare'],
      input.env,
    ).catch((error: Error & { stderr?: string }) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { stderr?: string }).stderr).toContain(
      'runtime and migrator database roles must differ',
    );
    await expect(readFile(join(input.targetRoot, 'runtime.database.env'))).rejects.toThrow();
  }, 60_000);

  it('rejects a migrator source containing any second key', async () => {
    const input = await fixture({ extraMigratorKey: true });
    const failure = await execute(
      ['PREPARE_COMMUNITIES_REHEARSAL_CREDENTIALS_V1', 'prepare'],
      input.env,
    ).catch((error: Error & { stderr?: string }) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { stderr?: string }).stderr).toContain(
      'migrator source must contain exactly one DATABASE_URL line',
    );
  }, 60_000);
});
