import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.skipIf(process.env.TIMEWEB_STANDARD_DOCKER_VERIFY !== '1').each([false, true])(
  'rehearses contained Worker activation and lost-ACK rollback on owned synthetic Compose canonical=%s',
  (canonical) => {
    const result = spawnSync(
      process.execPath,
      ['scripts/rehearse-timeweb-roster-cutover-compose.js'],
      {
        encoding: 'utf8',
        env: { ...process.env, TIMEWEB_CANONICAL_ROSTER_FIXTURE: canonical ? '1' : '0' },
        timeout: 180000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`API_WORKER_WEB_COMPOSE_REHEARSAL_PASS canonical=${canonical}`);
  },
  180000,
);
