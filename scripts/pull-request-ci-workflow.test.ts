import { readFileSync } from 'node:fs';
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
    expect(workflow.jobs['quality-docs']?.services).toBeUndefined();
    expect(workflow.jobs['quality-web']?.services).toBeUndefined();
    expect(workflow.jobs['quality-docs']?.if).toContain("docs_quality == 'true'");
    expect(workflow.jobs['quality-web']?.if).toContain("web_quality == 'true'");
    expect(workflow.jobs['quality-full']?.if).toContain("full_quality == 'true'");
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
