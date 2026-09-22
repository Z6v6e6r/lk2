import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const helper = fileURLToPath(
  new URL('../deploy/jetson/derive-worker-runtime-env.sh', import.meta.url),
);
const temporaryDirectories: string[] = [];

const sourceEnvironment = `# staging runtime contract
APP_ENV=staging
DATABASE_URL=postgresql://phub_runtime:secret@postgres:5432/phub_staging
JWT_ACCESS_SECRET=access-signing-secret
JWT_REFRESH_SECRET=refresh-signing-secret
JWT_REALTIME_SECRET=realtime-signing-secret
COMMUNITIES_REALTIME_ENABLED=false
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'phub-worker-runtime-env-'));
  temporaryDirectories.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // The staging hosts ship GNU coreutils; the developer hosts running this test may not.
  writeFileSync(
    join(bin, 'stat'),
    `#!/bin/sh
case "$2" in
  %a) printf '600\\n' ;;
  %u) id -u ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(join(bin, 'stat'), 0o755);
  const source = join(root, 'staging.env');
  const target = join(root, 'staging.worker.env');
  writeFileSync(source, sourceEnvironment, { mode: 0o600 });
  return { root, bin, source, target };
}

function execute(input: ReturnType<typeof fixture>, source = input.source, target = input.target) {
  return spawnSync('/bin/sh', [helper, source, target], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${input.bin}:${process.env.PATH ?? ''}` },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('worker runtime env derivation', () => {
  it('copies the runtime contract without API signing secrets and attests the isolation', () => {
    const input = fixture();
    const result = execute(input);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('worker runtime env derived');
    const derived = readFileSync(input.target, 'utf8');
    expect(derived).toBe(`# staging runtime contract
APP_ENV=staging
DATABASE_URL=postgresql://phub_runtime:secret@postgres:5432/phub_staging
JWT_REALTIME_SECRET=realtime-signing-secret
COMMUNITIES_REALTIME_ENABLED=false
WORKER_RUNTIME_SECRET_ISOLATION_REQUIRED=true
`);
  });

  it('is idempotent for an existing derived contract owned by the deployment identity', () => {
    const input = fixture();
    expect(execute(input).status).toBe(0);
    const result = execute(input);

    expect(result.status).toBe(0);
    expect(readFileSync(input.target, 'utf8')).toContain(
      'WORKER_RUNTIME_SECRET_ISOLATION_REQUIRED=true',
    );
  });

  it('refuses unsafe inputs and leaves no derived contract behind', () => {
    const missingRefresh = fixture();
    writeFileSync(
      missingRefresh.source,
      sourceEnvironment.replace('JWT_REFRESH_SECRET=refresh-signing-secret\n', ''),
      { mode: 0o600 },
    );
    const missing = execute(missingRefresh);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('has no JWT_REFRESH_SECRET to isolate');
    expect(existsSync(missingRefresh.target)).toBe(false);

    const alreadyIsolated = fixture();
    writeFileSync(
      alreadyIsolated.source,
      `${sourceEnvironment}WORKER_RUNTIME_SECRET_ISOLATION_REQUIRED=true\n`,
      { mode: 0o600 },
    );
    const isolated = execute(alreadyIsolated);
    expect(isolated.status).toBe(1);
    expect(isolated.stderr).toContain('already carries the worker isolation attestation');

    const linked = fixture();
    symlinkSync(join(linked.root, 'elsewhere.env'), linked.target);
    const symlinked = execute(linked);
    expect(symlinked.status).toBe(1);
    expect(symlinked.stderr).toContain('worker runtime env target is unsafe');
  });
});
