import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const verifier = fileURLToPath(new URL('./verify-ci-plan.js', import.meta.url));
const basePlan = {
  schemaVersion: 1,
  profile: 'docs',
  docsQuality: true,
  webQuality: false,
  fullQuality: false,
  deploymentContract: false,
  provenanceProbe: false,
  policyValidation: true,
  dockerServices: [],
  reason: 'test',
};

function run(command: readonly string[], environment: Record<string, string>) {
  return spawnSync(process.execPath, [verifier, ...command], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

describe('CI plan and aggregate verifier', () => {
  it('accepts only the selected quality result', () => {
    expect(
      run(['quality'], {
        PLAN_JSON: JSON.stringify(basePlan),
        DOCS_RESULT: 'success',
        WEB_RESULT: 'skipped',
        SOURCE_RESULT: 'skipped',
        FULL_RESULT: 'skipped',
      }).status,
    ).toBe(0);
  });

  it('requires both source and integration quality for the full profile', () => {
    const fullPlan = {
      ...basePlan,
      profile: 'full',
      docsQuality: false,
      fullQuality: true,
      policyValidation: false,
      dockerServices: ['web', 'api', 'worker', 'realtime', 'migrator'],
    };
    const environment = {
      PLAN_JSON: JSON.stringify(fullPlan),
      DOCS_RESULT: 'skipped',
      WEB_RESULT: 'skipped',
      SOURCE_RESULT: 'success',
      FULL_RESULT: 'success',
    };

    expect(run(['quality'], environment).status).toBe(0);
    expect(run(['quality'], { ...environment, SOURCE_RESULT: 'failure' }).status).not.toBe(0);
    expect(run(['quality'], { ...environment, FULL_RESULT: 'failure' }).status).not.toBe(0);
  });

  it.each(['failure', 'cancelled', 'skipped', ''])(
    'rejects required quality result %s',
    (result) => {
      expect(
        run(['quality'], {
          PLAN_JSON: JSON.stringify(basePlan),
          DOCS_RESULT: result,
          WEB_RESULT: 'skipped',
          SOURCE_RESULT: 'skipped',
          FULL_RESULT: 'skipped',
        }).status,
      ).not.toBe(0);
    },
  );

  it('rejects an erroneously successful job that the plan expected to skip', () => {
    expect(
      run(['quality'], {
        PLAN_JSON: JSON.stringify(basePlan),
        DOCS_RESULT: 'success',
        WEB_RESULT: 'success',
        SOURCE_RESULT: 'skipped',
        FULL_RESULT: 'skipped',
      }).status,
    ).not.toBe(0);
  });

  it.each(['{', '{}', JSON.stringify({ ...basePlan, profile: 'mystery' })])(
    'rejects malformed planner output %s',
    (plan) => {
      expect(
        run(['quality'], {
          PLAN_JSON: plan,
          DOCS_RESULT: 'success',
          WEB_RESULT: 'skipped',
          SOURCE_RESULT: 'skipped',
          FULL_RESULT: 'skipped',
        }).status,
      ).not.toBe(0);
    },
  );

  it.each(['failure', 'cancelled', 'skipped', ''])(
    'final gate rejects %s stable result',
    (result) => {
      expect(
        run(['gate'], {
          GATE_RESULTS: JSON.stringify({ quality: 'success', 'secret-scan': result }),
        }).status,
      ).not.toBe(0);
    },
  );
});
