import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
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

const verifier = fileURLToPath(
  new URL('../deploy/jetson/verify-chat-push-foundation-clone.sh', import.meta.url),
);
const temporaryDirectories: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'phub-foundation-clone-'));
  temporaryDirectories.push(root);
  const appRoot = join(root, 'app');
  const markers = join(root, 'markers');
  const bin = join(root, 'bin');
  const log = join(root, 'docker.log');
  const databaseState = join(root, 'database.state');
  mkdirSync(appRoot);
  mkdirSync(markers);
  mkdirSync(bin);
  writeFileSync(join(appRoot, 'infrastructure.env'), 'POSTGRES_USER=phub\n');
  writeFileSync(join(appRoot, 'release.env'), 'RELEASE=test\n', { mode: 0o600 });
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *'select datname from pg_catalog.pg_database'*)
    if [ -f "$FAKE_DATABASE_STATE" ]; then echo phub_foundation_123_1; fi ;;
  *'pg_get_userbyid'*) echo migrator_role ;;
  *'createdb -U'*)
    if [ "\${FAKE_CREATE_REACHED_SERVER:-false}" = true ]; then : > "$FAKE_DATABASE_STATE"; fi
    if [ "\${FAKE_FAIL_CREATE:-false}" = true ]; then exit 1; fi
    : > "$FAKE_DATABASE_STATE" ;;
  *'dropdb --if-exists'*) rm -f "$FAKE_DATABASE_STATE" ;;
  *'verify-chat-push-foundation.js'*)
    if [ "\${CHAT_PUSH_FOUNDATION_PHASE:-}" = pre ]; then
      printf '%s\n' '{"result":"PASS","pendingFoundationCount":5}'
    else
      printf '%s\n' '{"result":"PASS","pendingFoundationCount":0,"catalogDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
    fi
    ;;
esac
`,
  );
  chmodSync(join(bin, 'docker'), 0o755);
  writeFileSync(join(bin, 'stat'), '#!/bin/sh\nprintf "%s\\n" 600\n');
  chmodSync(join(bin, 'stat'), 0o755);
  return { root, appRoot, markers, bin, log, databaseState };
}

function execute(input: ReturnType<typeof fixture>, environment: Record<string, string> = {}) {
  return spawnSync(
    '/bin/sh',
    [verifier, 'phub_foundation_123_1', 'local-padel', 'VERIFY_CHAT_PUSH_FOUNDATION_CLONE'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${input.bin}:${process.env.PATH ?? ''}`,
        PHUB_APP_ROOT: input.appRoot,
        PHUB_FOUNDATION_CLONE_MARKER_ROOT: input.markers,
        RUNTIME_DATABASE_URL: 'postgresql://runtime:test@127.0.0.1/padlhub',
        MIGRATOR_DATABASE_URL: 'postgresql://migrator:test@127.0.0.1/padlhub',
        FAKE_DOCKER_LOG: input.log,
        FAKE_DATABASE_STATE: input.databaseState,
        ...environment,
      },
    },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('chat/push foundation clone verifier', () => {
  it('uses a same-cluster template clone, rehearses ACK, verifies no-op and removes the clone', () => {
    const input = fixture();
    const result = execute(input);
    const calls = readFileSync(input.log, 'utf8');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('foundation clone verified');
    expect(calls).toContain('createdb -U');
    expect(calls).toContain('--template="$POSTGRES_DB"');
    expect(calls).toContain('CHAT_PUSH_FOUNDATION_MAINTENANCE_V1');
    expect(calls.match(/apps\/migrator\/dist\/main\.js/g)).toHaveLength(2);
    expect(calls).toContain('dropdb --if-exists');
    expect(existsSync(input.databaseState)).toBe(false);
    expect(existsSync(join(input.markers, '.foundation-clone-cleanup-phub_foundation_123_1'))).toBe(
      false,
    );
  });

  it('never reuses or drops a colliding clone database', () => {
    const input = fixture();
    writeFileSync(input.databaseState, 'exists\n');
    const result = execute(input);
    const calls = readFileSync(input.log, 'utf8');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already exists');
    expect(calls).not.toContain('createdb -U');
    expect(calls).not.toContain('dropdb --if-exists');
  });

  it('retains a marker when clone creation may have reached PostgreSQL', () => {
    const input = fixture();
    const result = execute(input, {
      FAKE_CREATE_REACHED_SERVER: 'true',
      FAKE_FAIL_CREATE: 'true',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('creation is uncertain; marker retained');
    expect(existsSync(join(input.markers, '.foundation-clone-cleanup-phub_foundation_123_1'))).toBe(
      true,
    );
  });
});
