import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const diagnostic = fileURLToPath(
  new URL('../deploy/jetson/diagnose-live-home-source-failures.sh', import.meta.url),
);

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function passthroughTimeout(): string {
  return '#!/bin/sh\nshift\nexec "$@"\n';
}

describe('Live Home source failure diagnostic', () => {
  it('keeps a candidate 403 metric while redacting identifiers and tokens', () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'phub-live-home-diagnostic-'));
    try {
      const docker = join(fakeBin, 'docker');
      writeExecutable(
        docker,
        `#!/bin/sh
test "$1" = logs
test "$2" = --since=2026-08-14T13:26:07Z
test "$3" = --tail
test "$4" = 2000
test "$5" = phub-staging-worker-1
printf '%s\\n' '{"metric":{"operation":"profile","outcome":"failure","attempt":1,"status":403,"durationMs":17},"providerTenantKey":"provider-secret","userId":"user-secret","tenantId":"tenant-secret","correlationId":"correlation-secret","authorizationToken":"token-secret","msg":"Viva Home read operation"}'
`,
      );
      const timeout = join(fakeBin, 'timeout');
      writeExecutable(timeout, passthroughTimeout());

      const result = spawnSync('sh', [diagnostic, '2026-08-14T13:26:07Z', 'worker'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('container=phub-staging-worker-1');
      expect(result.stdout).not.toContain('phub-staging-api-1');
      expect(result.stdout).toContain('"operation":"profile"');
      expect(result.stdout).toContain('"status":403');
      expect(result.stdout).toContain('"durationMs":17');
      expect(result.stdout).toContain('"providerTenantKey":"[REDACTED]"');
      expect(result.stdout).toContain('"userId":"[REDACTED]"');
      expect(result.stdout).toContain('"tenantId":"[REDACTED]"');
      expect(result.stdout).toContain('"correlationId":"[REDACTED]"');
      expect(result.stdout).toContain('"authorizationToken":"[REDACTED]"');
      for (const secret of [
        'provider-secret',
        'user-secret',
        'tenant-secret',
        'correlation-secret',
        'token-secret',
      ]) {
        expect(result.stdout).not.toContain(secret);
      }
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('reports a Docker log failure without echoing its raw output', () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'phub-live-home-diagnostic-'));
    try {
      writeExecutable(
        join(fakeBin, 'docker'),
        "#!/bin/sh\nprintf '%s\\n' 'raw-provider-secret' >&2\nexit 1\n",
      );
      writeExecutable(join(fakeBin, 'timeout'), passthroughTimeout());

      const result = spawnSync('sh', [diagnostic, '3h', 'worker'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'Live Home diagnostic log read failed: container=phub-staging-worker-1 status=1',
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain('raw-provider-secret');
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('reports a bounded log timeout without echoing its raw output', () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'phub-live-home-diagnostic-'));
    try {
      writeExecutable(join(fakeBin, 'docker'), '#!/bin/sh\nexit 0\n');
      writeExecutable(
        join(fakeBin, 'timeout'),
        "#!/bin/sh\nprintf '%s\\n' 'raw-timeout-secret' >&2\nexit 124\n",
      );

      const result = spawnSync('sh', [diagnostic, '3h', 'worker'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'Live Home diagnostic log read failed: container=phub-staging-worker-1 status=124',
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain('raw-timeout-secret');
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('reports a successful Docker read that contains no matching evidence', () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'phub-live-home-diagnostic-'));
    try {
      writeExecutable(
        join(fakeBin, 'docker'),
        "#!/bin/sh\nprintf '%s\\n' 'unrelated-worker-log'\n",
      );
      writeExecutable(join(fakeBin, 'timeout'), passthroughTimeout());

      const result = spawnSync('sh', [diagnostic, '3h', 'worker'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Live Home diagnostic found no matching redacted evidence');
      expect(`${result.stdout}${result.stderr}`).not.toContain('unrelated-worker-log');
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});
