import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const sha = 'a'.repeat(40);
const names = [
  'ci-plan',
  'source-quality',
  'quality-full',
  'quality',
  'dependency-security',
  'secret-scan',
  'deployment-contract',
  'docker-build',
  'pr-gate',
];
const run = {
  head_sha: sha,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  path: '.github/workflows/pull-request.yaml',
  run_attempt: 1,
  repository: { full_name: 'Z6v6e6r/lk2' },
};
function verify(
  candidate: unknown,
  jobs = names.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {verifySourceCi} from './scripts/verify-source-ci.js'; verifySourceCi(${JSON.stringify(candidate)}, ${JSON.stringify(jobs)}, '${sha}');`,
    ],
    { encoding: 'utf8' },
  ).status;
}
describe('exact integrated source reuse before publication', () => {
  it('accepts one successful main run with the whole required closure', () =>
    expect(verify(run)).toBe(0));
  it.each(['failure', 'cancelled', 'skipped', ''])('rejects required job %s', (conclusion) => {
    expect(
      verify(
        run,
        names.map((name) => ({
          name,
          status: 'completed',
          conclusion: name === 'quality-full' ? conclusion : 'success',
        })),
      ),
    ).not.toBe(0);
  });
  it.each([
    { event: 'pull_request' },
    { repository: { full_name: 'someone/else' } },
    { path: '.github/workflows/untrusted.yaml' },
    { head_sha: 'b'.repeat(40) },
    { run_attempt: 2 },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { head_branch: 'codex/test' },
  ])('rejects nonidentical source authority %j', (override) =>
    expect(verify({ ...run, ...override })).not.toBe(0),
  );
  it('rejects a missing or duplicate job', () => {
    expect(verify(run, [])).not.toBe(0);
    const jobs = names.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
    expect(verify(run, [...jobs, jobs[0]!])).not.toBe(0);
  });
});
