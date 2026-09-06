import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.skipIf(process.env.TIMEWEB_STANDARD_DOCKER_VERIFY !== '1')(
  'rehearses actual isolated Compose Web success and forced same-digest rollback',
  () => {
    const result = spawnSync(process.execPath, ['scripts/rehearse-timeweb-standard-compose.js'], {
      encoding: 'utf8',
      timeout: 180000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('STANDARD_COMPOSE_REHEARSAL_PASS');
  },
  180000,
);
