import { spawnSync } from 'node:child_process';
import { mkdtempSync, chmodSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it.skipIf(
  process.env.GITHUB_ACTIONS !== 'true' || process.env.TIMEWEB_STANDARD_DOCKER_VERIFY !== '1',
)(
  'CI kernel enforces nonroot readonly directory bind and exposes a newly published token',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'phub-fcm-gate-kernel-'));
    chmodSync(directory, 0o755);
    writeFileSync(join(directory, 'held.json'), 'HELD\n', { mode: 0o644 });
    let container = '';
    const run = (args: string[]) => {
      const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      // This image already runs as the quality-full disposable PostgreSQL16 service.
      container = run([
        'run',
        '-d',
        '--network',
        'none',
        '--user',
        '1001:1001',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--mount',
        `type=bind,src=${directory},dst=/run/phub/fcm-rollout-gate,readonly`,
        '--entrypoint',
        '/bin/sh',
        'postgres:16-alpine',
        '-ec',
        'test -r /run/phub/fcm-rollout-gate/held.json; if echo forbidden > /run/phub/fcm-rollout-gate/foreign 2>/dev/null; then exit 31; fi; i=0; while test ! -f /run/phub/fcm-rollout-gate/released.json; do i=$((i+1)); test $i -lt 100; sleep 0.1; done; cat /run/phub/fcm-rollout-gate/released.json',
      ]);
      expect(container).toMatch(/^[a-f0-9]{64}$/);
      const inspect = JSON.parse(run(['inspect', container])) as {
        Config: { User: string };
        Mounts: { Destination: string; RW: boolean; Type: string; Source: string }[];
      }[];
      expect(inspect[0]?.Config.User).toBe('1001:1001');
      expect(inspect[0]?.Mounts).toContainEqual(
        expect.objectContaining({
          Destination: '/run/phub/fcm-rollout-gate',
          RW: false,
          Type: 'bind',
          Source: directory,
        }),
      );
      writeFileSync(join(directory, 'released.json'), 'RELEASED\n', { mode: 0o644 });
      expect(run(['wait', container])).toBe('0');
      expect(run(['logs', container])).toBe('RELEASED');
    } finally {
      if (/^[a-f0-9]{64}$/.test(container))
        spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8', timeout: 30000 });
      rmSync(directory, { recursive: true, force: true });
    }
  },
  45000,
);
