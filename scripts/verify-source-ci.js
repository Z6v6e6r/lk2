import { fileURLToPath } from 'node:url';

export function verifySourceCi(run, jobs, sha) {
  if (
    !/^[a-f0-9]{40}$/.test(sha) ||
    run.head_sha !== sha ||
    run.head_branch !== 'main' ||
    run.event !== 'push' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.path !== '.github/workflows/pull-request.yaml' ||
    run.run_attempt !== 1 ||
    run.repository?.full_name !== 'Z6v6e6r/lk2'
  )
    throw new Error('Untrusted or incomplete source CI');
  for (const name of [
    'ci-plan',
    'source-quality',
    'quality-full',
    'quality',
    'dependency-security',
    'secret-scan',
    'deployment-contract',
    'docker-build',
    'pr-gate',
  ]) {
    const matches = jobs.filter((job) => job.name === name);
    if (
      matches.length !== 1 ||
      matches[0].status !== 'completed' ||
      matches[0].conclusion !== 'success'
    ) {
      throw new Error(`Required source job did not succeed: ${name}`);
    }
  }
  return true;
}

export async function readSourceCi(runId, sha, token = process.env.GH_TOKEN) {
  if (!/^[1-9][0-9]*$/.test(runId ?? '') || !token) throw new Error('Missing source CI authority');
  async function get(path) {
    const response = await fetch(
      `https://api.github.com/repos/Z6v6e6r/lk2/actions/runs/${runId}${path}`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new Error(`Source CI lookup failed (${response.status})`);
    return response.json();
  }
  const run = await get('');
  const jobs = await get('/attempts/1/jobs?per_page=100');
  if (jobs.total_count !== jobs.jobs?.length) throw new Error('Truncated source CI job inventory');
  verifySourceCi(run, jobs.jobs, sha);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await readSourceCi(process.env.SOURCE_CI_RUN_ID, process.env.EXPECTED_SOURCE_SHA);
}
