import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const classifier = fileURLToPath(new URL('./select-pr-ci-profile.js', import.meta.url));
const all = ['web', 'api', 'worker', 'realtime', 'migrator'];

function select(paths: readonly string[], event = 'pull_request', ref = 'refs/pull/1/merge') {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const result = spawnSync(
    process.execPath,
    [classifier, '--event', event, '--ref', ref, '--base', sha, '--head', sha],
    {
      encoding: 'utf8',
      input: `${paths.join('\0')}${paths.length > 0 ? '\0' : ''}`,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    profile: string;
    fullQuality: boolean;
    releaseToolingTests: boolean;
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
      [],
    ],
    ['recommendation CSS', ['apps/web/src/styles.css'], 'leaf-web', []],
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

  it.each([
    'apps/web/src/chats-ui/chat-image-webp.ts',
    'apps/web/src/chats-ui/chat-image-webp.test.ts',
    'apps/web/src/App.tsx',
  ])('allowlisted safe-Web module %s runs the Web contour without a Docker rebuild', (path) => {
    expect(select([path])).toMatchObject({ profile: 'leaf-web', dockerServices: [] });
  });

  it.each([
    'scripts/safe-web-boundary.js',
    'scripts/timeweb-standard-policy.js',
    'scripts/run-timeweb-standard-delivery.js',
  ])('treats delivery control surface %s as a deployment contract', (path) => {
    expect(select([path])).toMatchObject({
      profile: 'full',
      deploymentContract: true,
      provenanceProbe: true,
    });
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
    'scripts/timeweb-commercial-runtime-contract.js',
    'scripts/verify-timeweb-api-web-observability.js',
    'scripts/verify-timeweb-api-web-observability.d.ts',
    'scripts/verify-timeweb-api-web-observability.test.ts',
    'scripts/produce-timeweb-api-web-observability-evidence.js',
    'scripts/produce-timeweb-api-web-observability-evidence.d.ts',
    'scripts/produce-timeweb-api-web-observability-evidence.test.ts',
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
        releaseToolingTests: true,
        deploymentContract: true,
        provenanceProbe: true,
        dockerServices: all,
      });
    },
  );

  it.each([
    ['API source', ['apps/api/src/games/game-routes.ts']],
    ['Web source outside the leaf allowlist', ['apps/web/src/auth-gateway.ts']],
    ['worker and package source', ['apps/worker/src/main.ts', 'packages/database/src/index.ts']],
    ['product tests', ['apps/api/src/app.test.ts', 'packages/games/src/index.test.ts']],
    ['package manifest', ['packages/database/src/index.ts', 'packages/database/package.json']],
    ['native Android project', ['apps/mobile/android/app/build.gradle']],
    ['Web public asset', ['apps/web/public/loader.js']],
    ['API contract', ['contracts/openapi/user/v1/openapi.yaml', 'openapi.yaml']],
    [
      'source with its documentation',
      ['apps/api/src/auth/auth-service.ts', 'docs/contracts/viva-profile-phone-link.md'],
    ],
  ])('skips the paused release-tooling tests for %s only', (_scenario, paths) => {
    expect(select(paths)).toMatchObject({ profile: 'full', releaseToolingTests: false });
    expect(select(paths, 'push', 'refs/heads/main')).toMatchObject({
      profile: 'full',
      releaseToolingTests: false,
      deploymentContract: true,
      provenanceProbe: true,
      dockerServices: all,
    });
  });

  it.each([
    'scripts/timeweb-standard-policy.js',
    'scripts/paused-release-tooling-tests.txt',
    'scripts/run-ci-tests-with-diagnostics.sh',
    'deploy/timeweb/compose.beta.yaml',
    'deploy/lk1-results-bridge/README.md',
    '.github/workflows/pull-request.yaml',
    '.github/PULL_REQUEST_TEMPLATE.md',
    '.agents/skills/lk2-dev/SKILL.md',
    'apps/migrator/src/lk2-beta-lane.ts',
    'apps/migrator/package.json',
    'apps/api/Dockerfile',
    'apps/web/Dockerfile.dev',
    'apps/api/docker/Dockerfile',
    'packages/ui/build/Dockerfile.ci',
    'packages/database/migrations/0117_example.sql',
    'packages/database/migrations',
    'apps/worker/src/fcm-rollout-gate.ts',
    'docs/runbooks/timeweb-lk2-beta.md',
    'docs/runbooks/Timeweb-notes.md',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'vitest.config.ts',
    'compose.yaml',
    '.env.example',
    '.dockerignore',
    'AGENTS.md',
    'docs/api/schema.json',
    'tooling/new-graph.ts',
    'apps/api/src/../Dockerfile',
  ])('keeps the paused release-tooling tests when %s changes with product source', (path) => {
    for (const paths of [[path], ['apps/api/src/games/game-routes.ts', path]]) {
      const pullRequest = select(paths);
      expect(pullRequest.releaseToolingTests).toBe(pullRequest.fullQuality);
      expect(select(paths, 'push', 'refs/heads/main').releaseToolingTests).toBe(true);
    }
  });

  it('never plans the paused release-tooling tests outside the full profile', () => {
    expect(select(['docs/product-notes.md'])).toMatchObject({
      profile: 'docs',
      releaseToolingTests: false,
    });
    expect(select(['apps/web/src/styles.css'])).toMatchObject({
      profile: 'leaf-web',
      releaseToolingTests: false,
    });
  });

  it('keeps the paused release-tooling tests for an empty pull-request range', () => {
    expect(select([])).toMatchObject({ profile: 'full', releaseToolingTests: true });
  });
});
