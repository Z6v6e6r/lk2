import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('Timeweb publication tag guard', () => {
  it('allows only an authenticated MANIFEST_UNKNOWN response and fails closed otherwise', () => {
    const fixture = fileURLToPath(
      new URL('./timeweb-publication-tag-guard.fixture.ts', import.meta.url),
    );
    const guard = fileURLToPath(
      new URL('./assert-timeweb-publication-tag-absent.js', import.meta.url),
    );
    const result = spawnSync(process.execPath, ['--import', 'tsx', fixture, guard], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const scenarios = JSON.parse(result.stdout) as Record<
      string,
      { readonly status: number | null; readonly leaked: boolean; readonly stderr: string }
    >;
    expect(scenarios.absent?.status, scenarios.absent?.stderr).toBe(0);
    for (const name of [
      'existing',
      'wrong-404',
      'mixed-404',
      'token-401',
      'manifest-401',
      'manifest-429',
      'manifest-500',
      'manifest-redirect',
      'transport-reset',
    ]) {
      expect(scenarios[name]?.status, `${name}: ${scenarios[name]?.stderr}`).not.toBe(0);
    }
    expect(Object.values(scenarios).every(({ leaked }) => leaked === false)).toBe(true);
  });
});
