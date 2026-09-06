import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

function scenario(program: string) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

describe('standard Timeweb release behavior', () => {
  it.each([
    'apps/api/src/payments/purchase.ts',
    'apps/web/src/auth-gateway.ts',
    'packages/database/migrations/next.sql',
    '.github/workflows/pull-request.yaml',
    'scripts/run-timeweb-standard-delivery.js',
  ])('cumulative %s prevents a later safe Web PR from hiding critical source', (path) => {
    expect(
      scenario(`import { standardReleasePlan } from './scripts/timeweb-standard-policy.js';
      console.log(JSON.stringify(standardReleasePlan({paths:${JSON.stringify(['apps/web/src/TournamentSummaryCard.tsx', path])}, presentationVerified:true, backendUnchanged:true})));`),
    ).toMatchObject({ eligible: false });
  });
  it('requires verified syntax and backend compatibility, and plans actual stages', () => {
    expect(
      scenario(`import { standardReleasePlan } from './scripts/timeweb-standard-policy.js';
      console.log(JSON.stringify([true,false].map(backendUnchanged=>standardReleasePlan({paths:['apps/web/src/TournamentSummaryCard.tsx'],presentationVerified:true,backendUnchanged}))));`),
    ).toEqual([
      {
        eligible: true,
        component: 'web',
        stages: ['source', 'publication', 'artifact-smoke', 'web-up', 'observe', 'receipt'],
        reason: 'presentation',
      },
      { eligible: false, reason: 'cumulative-critical-shared-or-unknown' },
    ]);
  });
  it.each(['preflight', 'pull', 'artifactSmoke', 'activate', 'observe', 'attestBackend'])(
    'failure at %s stops propagation and rolls back only after activation',
    (failure) => {
      const calls =
        scenario(`import { runWebTransition } from './scripts/timeweb-standard-policy.js';
      const calls=[]; let failed=false;
      const names=['preflight','pull','artifactSmoke','activate','observe','attestBackend','rollback'];
      const operations=Object.fromEntries(names.map(name=>[name,async()=>{calls.push(name); if(name===${JSON.stringify(failure)}&&!failed){failed=true;throw Error('fixture');}}]));
      operations.journal=async status=>calls.push(status);
      try{await runWebTransition(operations)}catch{calls.push('STOP')}
      console.log(JSON.stringify(calls));`) as string[];
      expect(calls.at(-1)).toBe('STOP');
      expect(calls).not.toContain('success');
      if (['activate', 'observe', 'attestBackend'].includes(failure)) {
        expect(calls).toContain('rollback');
        expect(calls).toContain('rolled-back');
      } else expect(calls).not.toContain('activate');
    },
  );
  it('exposes failed rollback and never reports success', () => {
    expect(
      scenario(`import { runWebTransition } from './scripts/timeweb-standard-policy.js';
      const calls=[]; const ok=async()=>{};
      try {await runWebTransition({preflight:ok,pull:ok,artifactSmoke:ok,activate:async()=>{throw Error()},observe:ok,attestBackend:ok,rollback:async()=>{throw Error()},journal:async s=>calls.push(s)})}catch{calls.push('STOP')}
      console.log(JSON.stringify(calls));`),
    ).toEqual(['pending', 'rollback-failed', 'STOP']);
  });
  it('runs only the installed controller on the protected runner, never PR code', () => {
    const source = readFileSync('.github/workflows/timeweb-standard-delivery.yaml', 'utf8');
    const workflow = parse(source) as {
      jobs: Record<string, { environment: string; steps: { run: string }[] }>;
    };
    expect(workflow.jobs['standard-web']?.environment).toBe('timeweb-standard-delivery');
    expect(source).toContain("github.event.workflow_run.event == 'push'");
    expect(source).toContain('LK2_STANDARD_DELIVERY_ENABLED');
    expect(source).not.toContain('actions/checkout');
    expect(source).not.toContain('pull_request_target');
    expect(source).not.toContain('secrets: inherit');
    expect(workflow.jobs['standard-web']?.steps[0]?.run).toContain(
      '/usr/local/sbin/phub-standard-delivery',
    );
  });
});
