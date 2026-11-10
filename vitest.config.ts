import { readFileSync } from 'node:fs';

import { defineConfig } from 'vitest/config';

// CI sets CI_TEST_SKIP_PAUSED_RELEASE_TOOLING=1 only when the CI plan reports
// releaseToolingTests=false, that is, when the change stays inside product areas
// (scripts/select-pr-ci-profile.js). The tests listed in scripts/paused-release-tooling-tests.txt are
// then not collected. The tooling they cover leaves the coverage report with them: migrator code
// still imports it, so it would otherwise count as loaded but unexercised. Without the variable
// nothing is excluded, which keeps `npm run source:quality` and every local run complete.
const PAUSED_TEST_GLOB = /^scripts\/[A-Za-z0-9*._-]+\.test\.ts$/u;

function pausedReleaseToolingTests(): string[] {
  if (process.env.CI_TEST_SKIP_PAUSED_RELEASE_TOOLING !== '1') return [];
  return readFileSync(
    new URL('./scripts/paused-release-tooling-tests.txt', import.meta.url),
    'utf8',
  )
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => PAUSED_TEST_GLOB.test(line));
}

const pausedTests = pausedReleaseToolingTests();
const pausedSources = pausedTests.map((glob) => {
  const stem = glob.slice(0, -'.test.ts'.length);
  return stem.endsWith('*') ? stem : `${stem}*`;
});

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.worktrees/**', ...pausedTests],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      exclude: ['deploy/jetson/generated/**', ...pausedSources],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 65,
        statements: 70,
      },
    },
  },
});
