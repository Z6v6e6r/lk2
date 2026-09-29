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
  it('delivers an allowlisted safe-Web module only when the range verifies it', () => {
    expect(
      scenario(`import { standardReleasePlan } from './scripts/timeweb-standard-policy.js';
      console.log(JSON.stringify([true,false].map(safeWebVerified=>standardReleasePlan({paths:['apps/web/src/chats-ui/chat-image-webp.ts'],presentationVerified:false,safeWebVerified,backendUnchanged:true}))));`),
    ).toEqual([
      {
        eligible: true,
        component: 'web',
        stages: ['source', 'publication', 'artifact-smoke', 'web-up', 'observe', 'receipt'],
        reason: 'safe-web',
      },
      { eligible: false, reason: 'cumulative-critical-shared-or-unknown' },
    ]);
  });
  it('does not plan a Web release for a range that ships no runtime code', () => {
    expect(
      scenario(`import { standardReleasePlan } from './scripts/timeweb-standard-policy.js';
      console.log(JSON.stringify(standardReleasePlan({paths:['apps/web/src/chats-ui/chat-image-webp.test.ts'],presentationVerified:false,safeWebVerified:true,backendUnchanged:true})));`),
    ).toEqual({ eligible: false, reason: 'docs-no-runtime-release' });
    expect(
      scenario(`import { standardReleasePlan } from './scripts/timeweb-standard-policy.js';
      console.log(JSON.stringify(standardReleasePlan({paths:['docs/product-notes.md'],presentationVerified:false,safeWebVerified:false,backendUnchanged:true})));`),
    ).toEqual({ eligible: false, reason: 'docs-no-runtime-release' });
  });
  it('never lets one verified class vouch for the other class', () => {
    expect(
      scenario(`import { standardReleasePlan } from './scripts/timeweb-standard-policy.js';
      console.log(JSON.stringify(standardReleasePlan({paths:['apps/web/src/chats-ui/chat-image-webp.ts','apps/web/src/TournamentSummaryCard.tsx'],presentationVerified:false,safeWebVerified:true,backendUnchanged:true})));`),
    ).toMatchObject({ eligible: false });
    expect(
      scenario(`import { standardReleasePlan } from './scripts/timeweb-standard-policy.js';
      console.log(JSON.stringify(standardReleasePlan({paths:['apps/web/src/chats-ui/chat-image-webp.ts','apps/web/src/TournamentSummaryCard.tsx'],presentationVerified:true,safeWebVerified:false,backendUnchanged:true})));`),
    ).toMatchObject({ eligible: false });
  });
  it.each([
    'apps/api/src/payments/purchase.ts',
    'apps/web/src/auth-gateway.ts',
    'scripts/safe-web-boundary.js',
  ])('cumulative %s stays outside the safe-Web class', (path) => {
    expect(
      scenario(`import { standardReleasePlan } from './scripts/timeweb-standard-policy.js';
      console.log(JSON.stringify(standardReleasePlan({paths:${JSON.stringify(['apps/web/src/chats-ui/chat-image-webp.ts', path])},presentationVerified:false,safeWebVerified:true,backendUnchanged:true})));`),
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
  it('hands one validated run id to the enrolled controller without running candidate code', () => {
    const source = readFileSync('.github/workflows/timeweb-standard-delivery.yaml', 'utf8');
    const workflow = parse(source) as {
      jobs: Record<
        string,
        {
          environment: string;
          'runs-on': string;
          permissions: Record<string, string>;
          steps: { name?: string; run?: string }[];
        }
      >;
    };
    const job = workflow.jobs['standard-web'];
    expect(job?.environment).toBe('timeweb-standard-delivery');
    // A GitHub-hosted transport: there is no privileged self-hosted surface left to protect.
    expect(job?.['runs-on']).toBe('ubuntu-latest');
    expect(source).not.toContain('self-hosted');
    expect(source).toContain("github.event.workflow_run.event == 'push'");
    expect(source).toContain('LK2_STANDARD_DELIVERY_ENABLED');
    expect(source).not.toContain('actions/checkout');
    expect(source).not.toContain('pull_request_target');
    expect(source).not.toContain('secrets: inherit');
    const delivery = (job?.steps ?? []).filter((step) => (step.run ?? '').includes('ssh -i'));
    expect(delivery).toHaveLength(1);
    const command = delivery[0]?.run ?? '';
    expect(command).toContain('[[ "$SOURCE_CI_RUN_ID" =~ ^[1-9][0-9]*$ ]]');
    // The token and the run id travel over stdin: no inline secret, no remote command of its own.
    expect(command).toContain(
      `printf '%s\\n%s\\n' "$GH_TOKEN" "$SOURCE_CI_RUN_ID" | ssh -i ~/.ssh/operator`,
    );
    expect(command).not.toMatch(/GH_TOKEN=\S/);
    // No interpreter or package manager is invoked anywhere in the delivery step.
    expect(command).not.toMatch(/\b(node|npm|npx|sh -c|bash -c)\b/);
    expect(command).toContain('"phub-operator@$OPERATOR_HOST"');
    for (const option of [
      'BatchMode=yes',
      'IdentitiesOnly=yes',
      'StrictHostKeyChecking=yes',
      'ConnectTimeout=15',
    ]) {
      expect(command).toContain(option);
    }
    // The trigger and the job token stay fail-closed.
    expect(source).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(source).toContain('github.event.workflow_run.run_attempt == 1');
    expect(job?.permissions).toMatchObject({
      contents: 'read',
      actions: 'write',
      packages: 'read',
    });
    // sudoers cannot wildcard an argument, so the run id reaches the launcher through the
    // environment and the launcher validates it as decimal.
    expect(readFileSync('deploy/timeweb/run-standard-delivery.sh', 'utf8')).toContain(
      'PHUB_SOURCE_CI_RUN_ID',
    );
    // The forced operator entry and the fixed launcher are the host-side contract of this transport.
    const runbook = readFileSync('docs/runbooks/timeweb-standard-delivery.md', 'utf8');
    expect(runbook).toContain('/usr/local/sbin/phub-standard-delivery');
    expect(runbook).toContain('operator-entry');
    // The entry is the account's login shell: a forced command alone still starts that shell.
    expect(runbook).toContain("set that file as the account's login shell");
    // The security-critical host half is reviewed source, not operator prose.
    const entry = readFileSync('deploy/timeweb/operator-entry.sh', 'utf8');
    expect(entry).toContain('IFS= read -r GH_TOKEN');
    expect(entry).toContain('case "$RUN_ID" in \'\'|*[!0-9]*)');
    expect(entry).toContain('exec sudo -n --preserve-env=GH_TOKEN,PHUB_SOURCE_CI_RUN_ID');
    // The launcher takes the run id from the environment and rejects any argument.
    const launcher = readFileSync('deploy/timeweb/run-standard-delivery.sh', 'utf8');
    expect(launcher).toContain('[ "$#" -eq 0 ]');
    expect(launcher).toContain('PHUB_SOURCE_CI_RUN_ID');
  });
});
