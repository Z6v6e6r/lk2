import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const classifier = fileURLToPath(new URL('./select-pr-ci-profile.js', import.meta.url));
const all = ['web', 'api', 'worker', 'realtime', 'migrator'];

function select(paths: readonly string[], event = 'pull_request', ref = 'refs/pull/1/merge') {
  const result = spawnSync(process.execPath, [classifier, '--event', event, '--ref', ref], {
    encoding: 'utf8',
    input: `${paths.join('\0')}${paths.length > 0 ? '\0' : ''}`,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    profile: string;
    fullQuality: boolean;
    webQuality: boolean;
    deploymentContract: boolean;
    provenanceProbe: boolean;
    policyValidation: boolean;
    dockerServices: readonly string[];
  };
}

describe('PR CI profile planner', () => {
  it.each([
    ['ordinary Markdown', ['docs/product-notes.md'], 'docs', []],
    ['AGENTS policy', ['AGENTS.md'], 'docs', []],
    ['PR template policy', ['.github/PULL_REQUEST_TEMPLATE.md'], 'docs', []],
    [
      'recommendation presentation',
      ['apps/web/src/RecommendationGridCard.tsx', 'apps/web/src/RecommendationGridCard.test.tsx'],
      'leaf-web',
      ['web'],
    ],
    ['recommendation CSS', ['apps/web/src/styles.css'], 'leaf-web', ['web']],
    ['Web auth gateway', ['apps/web/src/auth-gateway.ts'], 'full', all],
    ['public API SDK', ['packages/api-sdk/src/index.ts'], 'full', all],
    ['OpenAPI', ['contracts/openapi/user/v1/openapi.yaml'], 'full', all],
    ['database repository', ['packages/database/src/game-repository.ts'], 'full', all],
    [
      'migration',
      ['packages/database/migrations/0069_example.sql'],
      'full',
      ['api', 'worker', 'realtime', 'migrator'],
    ],
    ['root package manifest', ['package.json'], 'full', all],
    ['lockfile', ['package-lock.json'], 'full', all],
    ['workflow', ['.github/workflows/mobile-ios.yaml'], 'full', all],
    ['security policy', ['.agents/skills/security-policy.md'], 'full', []],
    ['unknown path', ['tooling/new-graph.ts'], 'full', all],
  ])('%s selects %s', (_scenario, paths, profile, dockerServices) => {
    expect(select(paths)).toMatchObject({ profile, dockerServices });
  });

  it('marks policy validation without escalating safe policy Markdown', () => {
    expect(select(['AGENTS.md', '.github/PULL_REQUEST_TEMPLATE.md'])).toMatchObject({
      profile: 'docs',
      policyValidation: true,
    });
  });

  it.each([
    'apps/web/src/userSessionsCard.tsx',
    'apps/web/src/IdentityPermissionsView.tsx',
    'apps/web/src/subscriptionPaymentsCard.tsx',
    'apps/web/src/tournamentSignupsPage.tsx',
    'apps/web/src/bookingRostersView.tsx',
  ])('plural/camelCase sensitive path %s fails closed', (path) => {
    expect(select([path])).toMatchObject({ profile: 'full', dockerServices: all });
  });

  it.each([
    'apps/web/src/ProfilePage.tsx',
    'apps/web/src/CommunityInvitePage.tsx',
    'apps/web/src/CommunityDetailPage.tsx',
    'apps/web/src/GiftCertificatesPage.tsx',
    'apps/web/src/LoginPage.tsx',
    'apps/web/src/adminRolesPage.tsx',
    'apps/web/src/accountCredentialsView.tsx',
    'apps/web/src/privacyTokenCard.tsx',
  ])('non-allowlisted Web surface %s fails closed', (path) => {
    expect(select([path])).toMatchObject({ profile: 'full' });
  });

  it('escalates a mixed policy and leaf Web diff to full', () => {
    expect(select(['AGENTS.md', 'apps/web/src/RecommendationGridCard.tsx'])).toMatchObject({
      profile: 'full',
      policyValidation: true,
      dockerServices: ['web'],
    });
  });

  it('considers both sides of a rename', () => {
    expect(
      select(['apps/web/src/RecommendationGridCard.tsx', 'apps/web/src/authGateway.ts']),
    ).toMatchObject({ profile: 'full', dockerServices: all });
  });

  it('fails closed for an empty changed-path set', () => {
    expect(select([])).toMatchObject({ profile: 'full', dockerServices: all });
  });

  it.each([
    'apps/web/Dockerfile',
    'apps/api/Dockerfile',
    'apps/worker/Dockerfile',
    '.dockerignore',
    'scripts/verify-timeweb-publication-evidence-checksums.js',
    'scripts/verify-timeweb-base-images.js',
    'scripts/verify-timeweb-base-images.d.ts',
    'scripts/verify-timeweb-base-images.test.ts',
    '.github/workflows/publish-timeweb-amd64-images.yaml',
  ])('Timeweb release surface requires deployment contract: %s', (path) => {
    expect(select([path])).toMatchObject({
      profile: 'full',
      deploymentContract: true,
      provenanceProbe: true,
    });
  });

  it.each([
    'scripts/verify-timeweb-api-web-observability.js',
    'scripts/verify-timeweb-api-web-observability.d.ts',
    'scripts/verify-timeweb-api-web-observability.test.ts',
  ])('runs deployment validation without publication provenance for %s', (path) => {
    expect(select([path])).toMatchObject({
      profile: 'full',
      deploymentContract: true,
      provenanceProbe: false,
    });
  });

  it('runs the deployment contract for the Timeweb publication custody helper', () => {
    expect(select(['scripts/timeweb-amd64-registry-custody-retry.sh'])).toMatchObject({
      profile: 'full',
      deploymentContract: true,
    });
  });

  it('runs the deployment contract without an unrelated provenance probe for Timeweb Compose', () => {
    expect(select(['deploy/timeweb/compose.beta.yaml'])).toMatchObject({
      profile: 'full',
      deploymentContract: true,
      provenanceProbe: false,
    });
  });

  it.each(['main', 'integration/lk2-beta-20260827-01'])(
    'push to %s is full integration',
    (branch) => {
      expect(select([], 'push', `refs/heads/${branch}`)).toMatchObject({
        profile: 'full',
        deploymentContract: true,
        provenanceProbe: true,
        dockerServices: all,
      });
    },
  );
});
