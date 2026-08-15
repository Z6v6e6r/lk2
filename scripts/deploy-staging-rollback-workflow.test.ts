import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const workflow = readFileSync(
  fileURLToPath(new URL('../.github/workflows/deploy-staging.yaml', import.meta.url)),
  'utf8',
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function rollbackRunBlock(): string {
  const marker = '      - name: Roll back a failed staging application release';
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error('rollback workflow step is missing');
  const step = workflow.slice(start);
  const run = step.match(/\n {8}run: \|\n([\s\S]+)$/)?.[1];
  if (!run) throw new Error('rollback workflow run block is missing');
  return run
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

function execute(precheckStatus: number) {
  const directory = mkdtempSync(join(tmpdir(), 'phub-staging-rollback-workflow-'));
  temporaryDirectories.push(directory);
  const fakeBin = join(directory, 'bin');
  const sshLog = join(directory, 'ssh.log');
  const script = join(directory, 'rollback-step.sh');
  mkdirSync(fakeBin);
  writeFileSync(script, rollbackRunBlock());
  chmodSync(script, 0o700);
  writeFileSync(
    join(fakeBin, 'ssh'),
    `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_SSH_LOG"
case "$*" in
  *'PHUB_MEDIA_ROLLBACK_MODE=pre-cutover'*) exit "$FAKE_PRECHECK_STATUS" ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(join(fakeBin, 'ssh'), 0o700);
  const result = spawnSync('/bin/sh', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      HOST: 'staging.test',
      STAGING_RELEASE_BACKUP_DIR: '/opt/phub/backups/releases/pre-test',
      FAKE_SSH_LOG: sshLog,
      FAKE_PRECHECK_STATUS: String(precheckStatus),
    },
  });
  return {
    result,
    calls: readFileSync(sshLog, 'utf8').trim().split('\n'),
  };
}

describe('failed staging deployment rollback workflow', () => {
  it('uses the ordinary rollback only for a safe pre-cutover state', () => {
    const { result, calls } = execute(0);

    expect(result.status).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('PHUB_MEDIA_ROLLBACK_MODE=pre-cutover');
    expect(calls[1]).toContain('rollback-application.sh');
    expect(calls.join('\n')).not.toContain('prepare-compatible-worker-rollback.sh');
  });

  it('passes the client-media floor through prepare, guard and rollback in order', () => {
    const { result, calls } = execute(42);

    expect(result.status).toBe(0);
    expect(calls).toHaveLength(4);
    expect(calls[1]).toContain('PHUB_ROLLBACK_COMPATIBILITY_FLOOR=client-media');
    expect(calls[1]).toContain('prepare-compatible-worker-rollback.sh');
    expect(calls[2]).toContain('PHUB_ROLLBACK_COMPATIBILITY_FLOOR=client-media');
    expect(calls[2]).toContain('PHUB_MEDIA_ROLLBACK_MODE=compatible-client');
    expect(calls[3]).toContain('PHUB_ROLLBACK_COMPATIBILITY_FLOOR=client-media');
    expect(calls[3]).toContain('PHUB_ROLLBACK_REQUIRE_COMPATIBLE_WORKER=true');
  });

  it('passes the community-logo floor through prepare, guard and rollback in order', () => {
    const { result, calls } = execute(43);

    expect(result.status).toBe(0);
    expect(calls).toHaveLength(4);
    expect(calls[1]).toContain('PHUB_ROLLBACK_COMPATIBILITY_FLOOR=community-logo');
    expect(calls[1]).toContain('prepare-compatible-worker-rollback.sh');
    expect(calls[2]).toContain('PHUB_ROLLBACK_COMPATIBILITY_FLOOR=community-logo');
    expect(calls[2]).toContain('PHUB_MEDIA_ROLLBACK_MODE=compatible-logo');
    expect(calls[3]).toContain('PHUB_ROLLBACK_COMPATIBILITY_FLOOR=community-logo');
    expect(calls[3]).toContain('PHUB_ROLLBACK_REQUIRE_COMPATIBLE_WORKER=true');
  });

  it('fails closed for an unexpected precheck exit without preparing or restoring', () => {
    const { result, calls } = execute(1);

    expect(result.status).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('PHUB_MEDIA_ROLLBACK_MODE=pre-cutover');
  });
});
