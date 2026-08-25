import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const classifierPath = fileURLToPath(new URL('./select-pr-docker-services.js', import.meta.url));
const select = (paths: readonly string[]): readonly string[] => {
  const result = spawnSync(process.execPath, [classifierPath], {
    encoding: 'utf8',
    input: `${paths.join('\0')}\0`,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as readonly string[];
};
const all = ['web', 'api', 'worker', 'realtime', 'migrator'];

describe('PR Docker service selection', () => {
  it.each([
    {
      scenario: 'docs and policy only',
      paths: ['README.md', 'AGENTS.md', '.github/PULL_REQUEST_TEMPLATE.md', 'docs/ci.md'],
      expected: [],
    },
    { scenario: 'leaf web', paths: ['apps/web/src/App.tsx'], expected: ['web'] },
    { scenario: 'leaf worker', paths: ['apps/worker/src/main.ts'], expected: ['worker'] },
    { scenario: 'leaf migrator', paths: ['apps/migrator/src/main.ts'], expected: ['migrator'] },
    {
      scenario: 'database migration',
      paths: ['packages/database/migrations/0069_example.sql'],
      expected: ['api', 'worker', 'realtime', 'migrator'],
    },
    { scenario: 'shared package', paths: ['packages/domain/src/index.ts'], expected: all },
    { scenario: 'root lockfile', paths: ['package-lock.json'], expected: all },
    {
      scenario: 'release-critical workflow',
      paths: ['.github/workflows/deploy-production.yaml'],
      expected: all,
    },
  ])('$scenario', ({ paths, expected }) => {
    expect(select(paths)).toEqual(expected);
  });

  it('unions independent leaf apps and ignores accompanying docs', () => {
    expect(
      select(['docs/web-change.md', 'apps/web/src/App.tsx', 'apps/worker/src/main.ts']),
    ).toEqual(['web', 'worker']);
  });

  it.each([
    'apps/api/src/auth/auth-routes.ts',
    'apps/api/src/bookings/activity-history-refresh.ts',
    'apps/web/src/TournamentDetailPage.tsx',
    'apps/api/src/paymentService.ts',
    'apps/api/src/providerClient.ts',
    'apps/api/src/rbacPolicy.ts',
    'apps/api/src/schema.ts',
  ])('fails closed for CRITICAL leaf path %s', (path) => {
    expect(select([path])).toEqual(all);
  });

  it.each([
    'apps/web/package.json',
    'apps/worker/package.json',
    'apps/mobile/package.json',
    'apps/cup-admin/package.json',
  ])('builds all images for workspace manifest %s', (path) => {
    expect(select([path])).toEqual(all);
  });

  it('fails closed for an unknown path', () => {
    expect(select(['tooling/unknown-build-input.ts'])).toEqual(all);
  });

  it('keeps an always-running aggregate check around the conditional matrix', async () => {
    const workflow = parse(
      await readFile(new URL('../.github/workflows/pull-request.yaml', import.meta.url), 'utf8'),
    ) as {
      readonly jobs?: Readonly<Record<string, unknown>>;
    };
    const jobs = workflow.jobs as {
      readonly ['docker-selection']?: {
        readonly outputs?: Readonly<Record<string, string>>;
        readonly steps?: readonly { readonly id?: string; readonly run?: string }[];
      };
      readonly ['docker-image']?: {
        readonly if?: string;
        readonly name?: string;
        readonly needs?: string;
        readonly strategy?: { readonly matrix?: { readonly service?: string } };
      };
      readonly ['docker-build']?: {
        readonly if?: string;
        readonly name?: string;
        readonly needs?: readonly string[];
        readonly steps?: readonly { readonly run?: string }[];
      };
    };

    const selection = jobs['docker-selection'];
    const selector = selection?.steps?.find(({ id }) => id === 'select');
    const image = jobs['docker-image'];
    const aggregate = jobs['docker-build'];

    expect(selection?.outputs?.services).toBe('${{ steps.select.outputs.services }}');
    expect(selector?.run).toContain('git merge-base "$EVENT_BASE_SHA" "$EVENT_HEAD_SHA"');
    expect(selector?.run).toContain(
      'git diff --no-renames --name-only -z "$base_sha" "$EVENT_HEAD_SHA"',
    );
    expect(selector?.run).toContain('node scripts/select-pr-docker-services.js');
    expect(image).toMatchObject({
      if: "${{ needs.docker-selection.result == 'success' && needs.docker-selection.outputs.services != '[]' }}",
      name: 'docker-build (${{ matrix.service }})',
      needs: 'docker-selection',
      strategy: { matrix: { service: '${{ fromJSON(needs.docker-selection.outputs.services) }}' } },
    });
    expect(aggregate).toMatchObject({
      if: '${{ always() }}',
      name: 'docker-build',
      needs: ['docker-selection', 'docker-image'],
    });
    expect(aggregate?.steps?.[0]?.run).toContain('test "$SELECTION_RESULT" = success');
    expect(aggregate?.steps?.[0]?.run).toContain('test "$BUILD_RESULT" = skipped');
    expect(aggregate?.steps?.[0]?.run).toContain('test "$BUILD_RESULT" = success');
  });
});
