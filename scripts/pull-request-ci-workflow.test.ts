import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const source = readFileSync('.github/workflows/pull-request.yaml', 'utf8');
const workflow = parse(source) as {
  readonly on: { readonly push: { readonly branches: readonly string[] } };
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly if?: string;
        readonly name?: string;
        readonly needs?: string | readonly string[];
        readonly services?: unknown;
        readonly steps?: readonly {
          readonly if?: string;
          readonly name?: string;
          readonly run?: string;
        }[];
      }
    >
  >;
};

describe('pull request CI profiles and stable gates', () => {
  it('runs the full contour on main and temporary integration branches only', () => {
    expect(workflow.on.push.branches).toEqual(['main', 'integration/**']);
    expect(source).not.toContain('workflow_dispatch');
  });

  it('always defines the stable aggregate contract', () => {
    for (const job of [
      'ci-plan',
      'source-quality',
      'quality',
      'dependency-security',
      'secret-scan',
      'deployment-contract',
      'docker-build',
      'pr-gate',
    ]) {
      expect(workflow.jobs[job]?.name, job).toBe(job);
    }
    expect(workflow.jobs['quality']?.if).toBe('${{ always() }}');
    expect(workflow.jobs['docker-build']?.if).toBe('${{ always() }}');
    expect(workflow.jobs['pr-gate']?.if).toBe('${{ always() }}');
  });

  it('keeps databases and brokers exclusive to full quality', () => {
    expect(workflow.jobs['quality-full']?.services).toBeTruthy();
    expect(workflow.jobs['source-quality']?.services).toBeUndefined();
    expect(workflow.jobs['quality-docs']?.services).toBeUndefined();
    expect(workflow.jobs['quality-web']?.services).toBeUndefined();
    expect(workflow.jobs['quality-docs']?.if).toContain("docs_quality == 'true'");
    expect(workflow.jobs['quality-web']?.if).toContain("web_quality == 'true'");
    expect(workflow.jobs['quality-full']?.if).toContain("full_quality == 'true'");
    expect(workflow.jobs['source-quality']?.if).toContain("full_quality == 'true'");
  });

  it('uses the planner for Docker and never publishes CI images', () => {
    expect(source).toContain('node scripts/select-pr-ci-profile.js');
    expect(source).toContain('PLANNED_SERVICES: ${{ needs.ci-plan.outputs.services }}');
    expect(source).toContain('push: false');
    expect(source).not.toContain('push: true');
  });

  it('runs Timeweb contracts only when explicitly planned and accepts only planned skips', () => {
    const deploymentSteps = workflow.jobs['deployment-contract']?.steps ?? [];
    expect(
      deploymentSteps.some(({ if: condition }) => condition?.includes('deployment_contract')),
    ).toBe(true);
    expect(workflow.jobs['timeweb-provenance-probe']?.if).toContain("provenance_probe == 'true'");
    expect(source).toContain('node scripts/verify-ci-plan.js conditional provenanceProbe');
  });

  it('uses bounded pinned BuildKit readiness diagnostics without publication authority', () => {
    expect(source).toContain('node scripts/verify-pinned-buildkit-bootstrap.js');
    expect(source).toContain('--version "$BUILDKIT_VERSION"');
    expect(source).toContain('$SERVICE-buildkit-bootstrap.json');
    expect(source).toContain('push: false');
    expect(source).not.toContain('docker buildx inspect --bootstrap | grep');
  });

  it('fails the final aggregate on missing, failed or cancelled stable results', () => {
    expect(source).toContain('node scripts/verify-ci-plan.js gate');
    expect(source).toContain('"ci-plan":"${{ needs.ci-plan.result }}"');
    expect(source).toContain('"secret-scan":"${{ needs.secret-scan.result }}"');
  });

  it('extends the exact-range secret scan to integration branches without weakening it', () => {
    expect(source).toContain('refs/heads/main|refs/heads/integration/*');
    expect(source).toContain('git fetch --no-tags origin main:refs/remotes/origin/main');
    expect(source).toContain('base_sha="$(git merge-base "$main_sha" "$head_sha")"');
    expect(source).toContain('A zero before SHA is allowed only for a new integration branch.');
    expect(source).toContain('--diff-merges=remerge $BASE_SHA..$HEAD_SHA');
    expect(source).toContain('--exit-code=2');
  });
});

describe('exact ephemeral provenance builder cleanup', () => {
  const cleanup = workflow.jobs['timeweb-provenance-probe']?.steps?.find(
    ({ name }) => name === 'Remove the ephemeral BuildKit builder',
  );
  const builder = 'phub-timeweb-pr-provenance-37300753114-1-api';

  function runCleanup(mode: string, target = builder) {
    const directory = mkdtempSync(join(tmpdir(), 'phub-provenance-cleanup-'));
    try {
      const docker = join(directory, 'docker');
      writeFileSync(
        docker,
        `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const directory = process.env.FIXTURE_DIRECTORY;
const target = ${JSON.stringify(builder)};
const container = 'buildx_buildkit_' + target + '0';
const volume = container + '_state';
const counter = directory + '/counter';
const calls = directory + '/calls';
fs.appendFileSync(calls, JSON.stringify(args) + '\\n');
let count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
if (args[0] === 'buildx' && args[1] === 'rm') {
  if (JSON.stringify(args) !== JSON.stringify(['buildx','rm','--force','--timeout','60s',target])) process.exit(90);
  fs.writeFileSync(counter, String(++count));
  process.exit(process.env.FIXTURE_MODE === 'persistent' || process.env.FIXTURE_MODE === 'partial' || count === 1 ? 1 : 0);
}
const residue = process.env.FIXTURE_MODE === 'persistent' || (process.env.FIXTURE_MODE === 'retry' && count < 2);
if (args[0] === 'buildx' && args[1] === 'ls') console.log('foreign-builder' + (residue ? '\\n' + target : ''));
else if (args[0] === 'ps') console.log('foreign-container' + (residue ? '\\n' + container : ''));
else if (args[0] === 'volume' && args[1] === 'ls') {
  if (process.env.FIXTURE_MODE === 'daemon-failure') process.exit(91);
  console.log('foreign-volume' + (residue ? '\\n' + volume : ''));
} else process.exit(92);
`,
      );
      chmodSync(docker, 0o700);
      // Avoid real waiting in this disposable command fixture.
      const sleep = join(directory, 'sleep');
      writeFileSync(sleep, '#!/bin/sh\nexit 0\n');
      chmodSync(sleep, 0o700);
      const result = spawnSync('/bin/bash', ['-c', cleanup!.run!], {
        env: {
          PATH: `${directory}:${process.env.PATH}`,
          BUILDER_NAME: target,
          GITHUB_RUN_ID: '37300753114',
          GITHUB_RUN_ATTEMPT: '1',
          SERVICE: 'api',
          FIXTURE_DIRECTORY: directory,
          FIXTURE_MODE: mode,
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
      const callsPath = join(directory, 'calls');
      const calls = (() => {
        try {
          return readFileSync(callsPath, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as string[]);
        } catch {
          return [];
        }
      })();
      return { status: result.status, calls };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('remains mandatory and verifies all exact residue after a timeout', () => {
    expect(cleanup?.if).toBe('${{ always() }}');
    const result = runCleanup('retry');
    expect(result.status).toBe(0);
    expect(result.calls.filter((args) => args[1] === 'rm')).toHaveLength(2);
    expect(result.calls.every((args) => args[1] !== 'rm' || args.at(-1) === builder)).toBe(true);
    expect(cleanup?.run).not.toContain('prune');
  });

  it('accepts a partial removal error only when builder, container and volume are absent', () => {
    const result = runCleanup('partial');
    expect(result.status).toBe(0);
    expect(result.calls.filter((args) => args[1] === 'rm')).toHaveLength(1);
  });

  it('fails after the bounded budget when exact residue persists', () => {
    const result = runCleanup('persistent');
    expect(result.status).toBe(1);
    expect(result.calls.filter((args) => args[1] === 'rm')).toHaveLength(3);
  });

  it('fails closed when Docker cannot enumerate remaining state', () => {
    expect(runCleanup('daemon-failure').status).not.toBe(0);
  });

  it('rejects a builder belonging to another run before any Docker command', () => {
    const result = runCleanup('retry', 'phub-timeweb-pr-provenance-37300753115-1-api');
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });
});
