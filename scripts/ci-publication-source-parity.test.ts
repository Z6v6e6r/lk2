import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type WorkflowStep = {
  readonly env?: Readonly<Record<string, string>>;
  readonly name?: string;
  readonly run?: string;
};

type WorkflowJob = {
  readonly env?: Readonly<Record<string, string>>;
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly services?: unknown;
  readonly steps?: readonly WorkflowStep[];
};

type Workflow = {
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
};

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  readonly scripts: Readonly<Record<string, string>>;
};
const pullRequestWorkflow = parse(
  readFileSync('.github/workflows/pull-request.yaml', 'utf8'),
) as Workflow;
const publicationWorkflow = parse(
  readFileSync('.github/workflows/publish-timeweb-amd64-images.yaml', 'utf8'),
) as Workflow;

const canonicalCommand = 'npm run source:quality';
const canonicalComponents = [
  'npm run contracts:generate',
  'npm run format:check',
  'npm run lint',
  'npm run typecheck',
  'npm run contracts:lint',
  'npm test',
  'npm run build',
  'npm run runtime:imports',
] as const;

function commandSteps(job: WorkflowJob | undefined): readonly string[] {
  return (job?.steps ?? []).flatMap(({ run }) => (run === undefined ? [] : [run]));
}

describe('exact-main CI and publication source-quality parity', () => {
  it('keeps the canonical source-quality components ordered and complete', () => {
    expect(packageJson.scripts['source:quality']).toBe(canonicalComponents.join(' && '));
    expect(packageJson.scripts.check).toBe(canonicalCommand);
  });

  it('runs the same clean source command in exact-main CI and publication', () => {
    const ciJob = pullRequestWorkflow.jobs['source-quality'];
    const publicationJob = publicationWorkflow.jobs['verify-source'];
    const ciCommands = commandSteps(ciJob);
    const publicationCommands = commandSteps(publicationJob);

    expect(ciJob?.if).toContain("full_quality == 'true'");
    expect(ciJob?.services).toBeUndefined();
    expect(ciJob?.env).toBeUndefined();
    expect(ciCommands).toContain('npm ci --ignore-scripts');
    expect(publicationCommands).toContain('npm ci --ignore-scripts');
    expect(ciCommands.filter((command) => command === canonicalCommand)).toEqual([
      canonicalCommand,
    ]);
    expect(publicationCommands.filter((command) => command === canonicalCommand)).toEqual([
      canonicalCommand,
    ]);
    expect(ciCommands.indexOf('npm ci --ignore-scripts')).toBeLessThan(
      ciCommands.indexOf(canonicalCommand),
    );
    expect(publicationCommands.indexOf('npm ci --ignore-scripts')).toBeLessThan(
      publicationCommands.indexOf(canonicalCommand),
    );
  });

  it('makes the publication-equivalent source result part of the stable quality gate', () => {
    const qualityJob = pullRequestWorkflow.jobs.quality;
    const needs = Array.isArray(qualityJob?.needs) ? qualityJob.needs : [qualityJob?.needs];
    const aggregateStep = qualityJob?.steps?.find(
      ({ name }) => name === 'Require the planned quality closure',
    );

    expect(needs).toContain('source-quality');
    expect(aggregateStep?.env?.SOURCE_RESULT).toBe('${{ needs.source-quality.result }}');
  });
});
