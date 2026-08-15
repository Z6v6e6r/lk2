import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
}

interface WorkflowJob {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly steps: readonly WorkflowStep[];
}

interface WorkflowDocument {
  readonly jobs: Readonly<Record<string, WorkflowJob>>;
}

const workflow = YAML.parse(
  readFileSync(
    fileURLToPath(new URL('../.github/workflows/deploy-staging.yaml', import.meta.url)),
    'utf8',
  ),
) as WorkflowDocument;

function requiredStep(jobName: string, stepName: string): WorkflowStep {
  const step = workflow.jobs[jobName]?.steps.find((candidate) => candidate.name === stepName);
  if (!step?.run) throw new Error(`missing ${jobName}/${stepName}`);
  return step;
}

const authorization = requiredStep(
  'authorize-foundation-maintenance',
  'Require the explicitly approved solo-owner maintenance environment',
).run as string;

function authorize(overrides: Readonly<Record<string, string>> = {}) {
  return spawnSync('/bin/bash', ['-c', authorization], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      MAINTENANCE_READY: 'APPROVED_SOLO_OWNER_V1',
      ALLOWED_OPERATOR_IDS: '52034887',
      SOLO_OWNER_ID: '52034887',
      ACTOR_ID: '52034887',
      ACTOR: 'Z6v6e6r',
      REPOSITORY_OWNER: 'Z6v6e6r',
      ...overrides,
    },
  });
}

describe('staging foundation solo-owner authorization', () => {
  it('accepts only the attested repository owner singleton', () => {
    expect(authorize().status).toBe(0);
  });

  it.each([
    ['readiness', { MAINTENANCE_READY: 'APPROVED_WITH_REQUIRED_REVIEWER_V1' }],
    ['allowlist', { ALLOWED_OPERATOR_IDS: '52034887,999' }],
    ['solo owner ID', { SOLO_OWNER_ID: '999' }],
    ['actor ID', { ACTOR_ID: '999' }],
    ['repository owner login', { REPOSITORY_OWNER: 'other-owner' }],
  ])('rejects a mismatched %s', (_name, overrides) => {
    expect(authorize(overrides).status).not.toBe(0);
  });

  it('keeps repair mode isolated to authorization and the exact repair job', () => {
    const repairReferences = Object.entries(workflow.jobs)
      .filter(([, job]) => job.if?.includes('repair-runtime-env'))
      .map(([name]) => name)
      .sort();

    expect(repairReferences).toEqual([
      'authorize-foundation-maintenance',
      'repair-foundation-runtime-env-permissions',
    ]);
    expect(workflow.jobs['repair-foundation-runtime-env-permissions']?.needs).toEqual([
      'validate-request',
      'authorize-foundation-maintenance',
    ]);
  });

  it('pins the repair command to the metadata-only allowlist', () => {
    const repair = requiredStep(
      'repair-foundation-runtime-env-permissions',
      'Repair staging runtime env metadata without reading values',
    ).run as string;

    expect(repair.trim()).toBe(
      [
        'ssh -o ServerAliveInterval=10 -o ServerAliveCountMax=2 "phub-deploy@$HOST" \'',
        '  set -eu',
        '  runtime_env=/etc/phub/staging.env',
        '  [ ! -w /etc/phub ]',
        '  test -f "$runtime_env"',
        '  test ! -L "$runtime_env"',
        '  sudo -n chown phub-deploy:phub-deploy "$runtime_env"',
        '  sudo -n chmod 0600 "$runtime_env"',
        '  [ "$(stat -c "%U:%G:%a" "$runtime_env")" = phub-deploy:phub-deploy:600 ]',
        '  echo staging_runtime_env_metadata_repaired',
        "'",
      ].join('\n'),
    );
  });
});
