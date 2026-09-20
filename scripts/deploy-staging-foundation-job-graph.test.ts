import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

interface WorkflowJob {
  readonly needs?: readonly string[] | string;
  readonly if?: string;
}

interface WorkflowDocument {
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

const source = readFileSync(
  fileURLToPath(new URL('../.github/workflows/deploy-staging.yaml', import.meta.url)),
  'utf8',
);
const workflow = YAML.parse(source) as WorkflowDocument;
const STATUS_FUNCTIONS = ['always()', 'success()', 'failure()', 'cancelled()'];

function needsOf(job: WorkflowJob): readonly string[] {
  const needs = job.needs;
  if (typeof needs === 'string') return [needs];
  if (!Array.isArray(needs)) return [];
  return needs.filter((need): need is string => typeof need === 'string');
}

function transitiveNeeds(name: string, seen = new Set<string>()): Set<string> {
  for (const need of needsOf(workflow.jobs[name] ?? {})) {
    if (seen.has(need)) continue;
    seen.add(need);
    transitiveNeeds(need, seen);
  }
  return seen;
}

describe('staging foundation deploy job graph', () => {
  it('keeps every job that depends on the skipped media baseline evaluable', () => {
    // `media-baseline` runs only for the media profiles, so it is skipped for everything else,
    // including CHAT_PUSH_FOUNDATION.
    const mediaBaseline = workflow.jobs['media-baseline'];
    expect(mediaBaseline?.if).toContain("inputs.deployment_profile == 'MEDIA_BINARY_ONLY'");

    const dependent = Object.entries(workflow.jobs)
      .filter(([name]) => name !== 'media-baseline' && transitiveNeeds(name).has('media-baseline'))
      .map(([name, job]) => ({ name, condition: job.if ?? '' }))
      .sort((left, right) => (left.name < right.name ? -1 : 1));
    expect(dependent.map((job) => job.name)).toEqual(['build', 'deploy', 'verify']);

    for (const job of dependent) {
      expect(
        STATUS_FUNCTIONS.some((statusFunction) => job.condition.includes(statusFunction)),
        `${job.name} depends on the conditionally skipped media-baseline and needs a status function`,
      ).toBe(true);
    }
  });

  it('keeps the explicit build gate after adding the status guard', () => {
    const build = workflow.jobs.build?.if ?? '';
    // Regression evidence: run 35527093145 attempt 1 (mode=deploy, CHAT_PUSH_FOUNDATION, verify
    // success) skipped `build`, so the foundation deploy reached neither `build` nor `deploy`.
    expect(build).toContain('always()');
    // `always()` drops the implicit success() veto, so every former gate stays written out.
    expect(build).toContain("needs.validate-request.result == 'success'");
    expect(build).toContain("needs.validate-request.outputs.mode == 'deploy'");
    expect(build).toContain("needs.verify.result == 'success'");
    expect(build).toContain("inputs.deployment_profile != 'CHAT_PUSH_FOUNDATION_RECOVERY'");
  });
});
