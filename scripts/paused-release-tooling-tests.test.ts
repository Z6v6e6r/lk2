import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

const scriptsDirectory = fileURLToPath(new URL('.', import.meta.url));
const list = readFileSync(new URL('./paused-release-tooling-tests.txt', import.meta.url), 'utf8');
const runner = readFileSync(new URL('./run-ci-tests-with-diagnostics.sh', import.meta.url), 'utf8');
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  readonly scripts: Readonly<Record<string, string>>;
};
const workflow = parse(
  readFileSync(new URL('../.github/workflows/pull-request.yaml', import.meta.url), 'utf8'),
) as {
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly outputs?: Readonly<Record<string, string>>;
        readonly steps: readonly {
          readonly env?: Readonly<Record<string, string>>;
          readonly if?: string;
          readonly id?: string;
          readonly name?: string;
          readonly run?: string;
        }[];
      }
    >
  >;
};

const GLOB = /^scripts\/[A-Za-z0-9*._-]+\.test\.ts$/u;
const entries = list
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'));
const scriptTests = readdirSync(scriptsDirectory)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => `scripts/${name}`);

function matcher(glob: string): RegExp {
  const pattern = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${pattern}$`, 'u');
}

function paused(path: string): boolean {
  return entries.some((glob) => matcher(glob).test(path));
}

describe('paused release-tooling test list', () => {
  it('contains only script-test globs the runner accepts, each matching a real test', () => {
    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(entries).size).toBe(entries.length);
    for (const glob of entries) {
      expect(glob, glob).toMatch(GLOB);
      expect(
        scriptTests.some((path) => matcher(glob).test(path)),
        `${glob} matches no test`,
      ).toBe(true);
    }
  });

  it.each([
    'scripts/lk2-beta-lane-script.test.ts',
    'scripts/lk2-test-preflight.test.ts',
    'scripts/lk2-commercial-acceptance.test.ts',
    'scripts/test-stand-results.test.ts',
    'scripts/select-pr-ci-profile.test.ts',
    'scripts/select-pr-docker-services.test.ts',
    'scripts/verify-ci-plan.test.ts',
    'scripts/pull-request-ci-workflow.test.ts',
    'scripts/run-ci-tests-with-diagnostics.test.ts',
    'scripts/required-game-ci.test.ts',
    'scripts/game-lifecycle-critical-classification.test.ts',
    'scripts/presentation-boundary.test.ts',
    'scripts/safe-web-boundary.test.ts',
    'scripts/closed-application-migration-acl.test.ts',
    'scripts/notification-migration-package.test.ts',
    'scripts/r1-tail-migration-profile.test.ts',
    'scripts/paused-release-tooling-tests.test.ts',
  ])(
    'never pauses the live path, migrator-imported scripts, the CI planner or product guard %s',
    (path) => {
      expect(scriptTests).toContain(path);
      expect(paused(path)).toBe(false);
    },
  );

  it('cannot reach a test outside scripts/', () => {
    for (const path of [
      'apps/api/src/app.test.ts',
      'apps/migrator/src/lk2-beta-lane.test.ts',
      'packages/database/src/game-repository.test.ts',
      'scripts/nested/timeweb-example.test.ts',
    ]) {
      expect(paused(path)).toBe(false);
    }
  });
});

describe('paused release-tooling test wiring', () => {
  async function config(value: string | undefined) {
    vi.resetModules();
    if (value === undefined) vi.stubEnv('CI_TEST_SKIP_PAUSED_RELEASE_TOOLING', undefined);
    else vi.stubEnv('CI_TEST_SKIP_PAUSED_RELEASE_TOOLING', value);
    const module = (await import('../vitest.config.js')) as unknown as {
      default: {
        test: {
          exclude: readonly string[];
          coverage: { exclude: readonly string[]; thresholds: Record<string, number> };
        };
      };
    };
    return module.default.test;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, '', '0', 'true', 'false', ' 1'])(
    'collects and measures everything when the variable is %j',
    async (value) => {
      const test = await config(value);
      expect(test.exclude).toEqual(['**/node_modules/**', '**/dist/**', '**/.worktrees/**']);
      expect(test.coverage.exclude).toEqual(['deploy/jetson/generated/**']);
    },
  );

  it('drops exactly the listed tests and their tooling sources when the plan asked to skip', async () => {
    const test = await config('1');
    expect(test.exclude).toEqual([
      '**/node_modules/**',
      '**/dist/**',
      '**/.worktrees/**',
      ...entries,
    ]);
    expect(test.coverage.exclude).toEqual([
      'deploy/jetson/generated/**',
      'scripts/*timeweb*',
      'scripts/communities-*',
    ]);
    expect(test.coverage.thresholds).toEqual({
      lines: 70,
      functions: 70,
      branches: 65,
      statements: 70,
    });
  });

  it('keeps the diagnostics runner and the publication source command unaware of the list', () => {
    expect(runner).not.toContain('paused-release-tooling');
    expect(runner).not.toContain('CI_TEST_SKIP_PAUSED_RELEASE_TOOLING');
    expect(packageJson.scripts['test:source']).toBe('vitest run --maxWorkers=2');
    expect(JSON.stringify(packageJson.scripts)).not.toContain(
      'CI_TEST_SKIP_PAUSED_RELEASE_TOOLING',
    );
    for (const name of readdirSync(new URL('../.github/workflows/', import.meta.url))) {
      if (name === 'pull-request.yaml') continue;
      expect(
        readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'),
        name,
      ).not.toContain('CI_TEST_SKIP_PAUSED_RELEASE_TOOLING');
    }
  });

  it('passes the plan to the test step and fails closed on a missing plan value', () => {
    const plan = workflow.jobs['ci-plan']!;
    const planStep = plan.steps.find(({ id }) => id === 'plan');
    const full = workflow.jobs['quality-full']!;
    const tests = full.steps.find(({ name }) => name === 'Unit and integration tests');
    const apt = full.steps.find(
      ({ name }) => name === 'Verify Ubuntu 26.04 Node-bootstrap APT isolation',
    );

    expect(plan.outputs?.release_tooling_tests).toBe(
      '${{ steps.plan.outputs.release_tooling_tests }}',
    );
    expect(planStep?.run).toContain(
      `jq -r 'if .releaseToolingTests == false then "false" else "true" end' "$plan_file"`,
    );
    expect(planStep?.env?.EVENT_BEFORE_SHA).toBe('${{ github.event.before }}');
    expect(planStep?.run).toContain('git cat-file -e "$EVENT_BEFORE_SHA^{commit}" 2>/dev/null');
    expect(planStep?.run).toContain(
      'git diff --no-renames --name-only -z "$EVENT_BEFORE_SHA" "$GITHUB_SHA"',
    );
    expect(tests?.env?.CI_TEST_SKIP_PAUSED_RELEASE_TOOLING).toBe(
      "${{ needs.ci-plan.outputs.release_tooling_tests == 'false' && '1' || '0' }}",
    );
    expect(apt?.if).toBe("${{ needs.ci-plan.outputs.release_tooling_tests != 'false' }}");
    // Only the full-quality test step may narrow the suite.
    expect(
      Object.values(workflow.jobs).flatMap(({ steps }) =>
        steps.filter(({ env }) => env?.CI_TEST_SKIP_PAUSED_RELEASE_TOOLING !== undefined),
      ),
    ).toEqual([tests]);
  });
});
