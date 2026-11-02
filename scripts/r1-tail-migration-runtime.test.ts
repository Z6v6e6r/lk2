import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('fixed R1 host entry denies foreign scope before host reads or effects', () => {
  it.each([
    ['deploy', '/tmp/arbitrary.json', 'R1_TAIL_ENTRY'],
    ['reconcile', '/tmp/arbitrary.json', 'R1_TAIL_ENTRY'],
    ['prefetch', '/tmp/arbitrary.json', 'R1_TAIL_PREFETCH_ENTRY'],
    ['reconcile-prefetch', '/tmp/arbitrary.json', 'R1_TAIL_PREFETCH_ENTRY'],
    ['shell', '/opt/phub/timeweb-beta/operator/r1-tail108-119-migration.json', 'R1_TAIL_ENTRY'],
  ])('refuses%s at a non-admitted path without exposing a request', (...args) => {
    const [mode, path, code] = args;
    const result = spawnSync(
      process.execPath,
      ['scripts/r1-tail-migration-runtime.js', mode, path],
      { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ status: 'STOP', code, replayAllowed: false });
  });
});
