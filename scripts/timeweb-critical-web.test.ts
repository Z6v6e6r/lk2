import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function scenario(code: string) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import {validateCriticalWebOperation, validateWebControllerDelta, validateCriticalWebRequestStat,
      validateCriticalWebSource, validateCriticalWebReceipt, validateCriticalWebRecoveryImages, validateCriticalWebSuccessEvidence, runCriticalWebTransition, observeCriticalWeb, WEB_COMPATIBILITY} from './scripts/timeweb-critical-web.js';
    ${code}`,
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
}
const fixture = `
  const now=Date.parse('2026-10-10T10:00:00.000Z');
  const sha='a'.repeat(40); const source=WEB_COMPATIBILITY.baselineSource;
  const op={schema:'PHUB_TIMEWEB_CRITICAL_WEB_OPERATION_V1',target:{hostname:'lk2.padlhub.su',serverId:8886471,projectId:262717},component:'web',controllerSha:sha,controllerSourceCiRunId:'11',candidateSha:sha,candidateTree:'b'.repeat(40),sourceCiRunId:'11',publicationRunId:'22',artifactId:'33',artifactDigest:'sha256:'+'c'.repeat(64),manifestSha256:'d'.repeat(64),
    expectedApi:{id:'e'.repeat(64),image:'ghcr.io/z6v6e6r/phub-api@sha256:'+'1'.repeat(64),releaseId:source+'-44-1'},
    expectedWeb:{id:'f'.repeat(64),image:'ghcr.io/z6v6e6r/phub-web@sha256:'+'2'.repeat(64),releaseId:source+'-44-1'},
    expiresAt:'2026-10-10T10:40:00.000Z',confirmation:'UPGRADE_WEB_AAAAAAAAAAAA_FROM_222222222222_KEEP_API_'+source.slice(0,12).toUpperCase()};
`;
const operations = `
  const calls=[];
  const names=['preflight','pull','artifactSmoke','authorizeActivation','activate','observe','attestCandidate','attestPrevious','attestBackend','rollback','unlock'];
  const ops=Object.fromEntries(names.map(name=>[name,async()=>{calls.push(name);} ]));
  ops.activate=async(markMutating)=>{calls.push('activate');markMutating();};
  ops.journal=async(status)=>calls.push(status);
`;
describe('closed critical Web delivery', () => {
  it('rejects scope, source, target, provenance, expiry and authorization drift', () =>
    scenario(
      fixture +
        `
    assert.equal(validateCriticalWebOperation(op,now),op);
    for (const change of [v=>v.extra='ignored',v=>v.component='api',v=>v.target.hostname='other.invalid',v=>v.target.serverId=1,v=>v.candidateSha='b'.repeat(40),v=>v.sourceCiRunId='12',v=>v.publicationRunId=22,v=>v.artifactDigest='latest',v=>v.manifestSha256='',v=>v.expectedApi.releaseId='b'.repeat(40)+'-44-1',v=>v.expectedWeb.image='ghcr.io/z6v6e6r/phub-web:latest',v=>v.expectedApi.id='',v=>v.expiresAt='2026-10-10T10:10:00.000Z',v=>v.expiresAt='2026-10-10T12:00:00.000Z',v=>v.confirmation='yes']) {
      const changed=structuredClone(op);change(changed);assert.throws(()=>validateCriticalWebOperation(changed,now));
    }
    // Recovery can restore the old Web after expiry; it cannot replay deployment.
    validateCriticalWebOperation({...op,expiresAt:'2026-10-09T10:00:00.000Z'});
    assert.throws(()=>validateCriticalWebOperation({...op,expiresAt:'2026-10-09T10:00:00.000Z'},now));
  `,
    ));
  it('freezes every build input beyond the reviewed whole-runtime anchor', () =>
    scenario(`
    validateWebControllerDelta([{status:'A',path:'scripts/timeweb-critical-web.js'},{status:'M',path:'docs/runbooks/timeweb-standard-delivery.md'}]);
    for (const path of ['package-lock.json','package.json','apps/web/src/styles.css','apps/web/src/auth-gateway.ts','apps/web/Dockerfile','contracts/openapi/user/v2/openapi.yaml','packages/api-sdk/src/index.ts','.github/workflows/publish-timeweb-amd64-images.yaml','scripts/presentation-boundary.js']) assert.throws(()=>validateWebControllerDelta([{status:'M',path}]));
    for (const status of ['R100','D','T','C100']) assert.throws(()=>validateWebControllerDelta([{status,path:'scripts/timeweb-critical-web.js'}]));
  `));
  it('rejects substituted trees and raw runtime proof before any activation', () =>
    scenario(
      fixture +
        `
    assert.throws(()=>validateCriticalWebSource(op,()=>''),/SOURCE_TREE/);
    const git=args=>args[0]==='rev-parse' ? args[1]===op.candidateSha+'^{tree}' ? op.candidateTree : args[1]===WEB_COMPATIBILITY.baselineSource+'^{tree}' ? WEB_COMPATIBILITY.baselineTree : WEB_COMPATIBILITY.runtimeTree : args[0]==='diff' ? 'changed' : '';
    assert.throws(()=>validateCriticalWebSource(op,git),/RUNTIME_PROOF/);
  `,
    ));
  it('rejects symlinks, hardlinks, non-root inputs and permissive request files', () =>
    scenario(`
    const info={isFile:()=>true,isSymbolicLink:()=>false,uid:0,gid:0,nlink:1,mode:0o100600,size:1};
    validateCriticalWebRequestStat(info);
    for (const change of [{isFile:()=>false},{isSymbolicLink:()=>true},{uid:501},{gid:501},{nlink:2},{mode:0o100644},{size:0},{size:65537}]) assert.throws(()=>validateCriticalWebRequestStat({...info,...change}));
  `));
  it('journals before up, publishes nothing and finishes only after backend attestation', () =>
    scenario(
      operations +
        `
    assert.equal(await runCriticalWebTransition(ops,'deploy','PREPARED'),'SUCCESS');
    assert.deepEqual(calls,['attestPrevious','preflight','pull','artifactSmoke','authorizeActivation','ACTIVATING','activate','OBSERVING','observe','attestCandidate','attestBackend','SUCCESS','unlock']);
  `,
    ));
  it.each([
    'preflight',
    'authorizeActivation',
    'pull',
    'artifactSmoke',
    'activate',
    'observe',
    'attestCandidate',
    'attestBackend',
  ])('handles failure at %s without changing another service', (failure) =>
    scenario(
      operations +
        `
      const original=ops.${failure};let failed=false;ops.${failure}=async(...args)=>{await original(...args);if(!failed){failed=true;throw Error('fixture');}};
      await assert.rejects(()=>runCriticalWebTransition(ops,'deploy','PREPARED'));
      assert.equal(calls.includes('rollback'),${['activate', 'observe', 'attestCandidate', 'attestBackend'].includes(failure)});
      assert(!calls.includes('unlock'));assert(!calls.includes('SUCCESS'));
      assert(calls.includes(${JSON.stringify(['activate', 'observe', 'attestCandidate', 'attestBackend'].includes(failure) ? 'ROLLED_BACK' : 'PREPARATION_FAILED')}));
    `,
    ),
  );
  it('retains uncertainty on failed rollback, and never retries a recovery up', () =>
    scenario(
      operations +
        `
    ops.rollback=async()=>{calls.push('rollback');throw Error('fixture');};
    await assert.rejects(()=>runCriticalWebTransition(ops,'recover','OBSERVING'),/ROLLBACK_UNPROVEN/);
    assert.equal(calls.filter(v=>v==='rollback').length,1);assert(calls.includes('ROLLBACK_FAILED'));assert(!calls.includes('unlock'));
  `,
    ));
  it('reconciles terminal receipts without up and does not rollback after durable SUCCESS unlock failure', () =>
    scenario(
      operations +
        `
    await runCriticalWebTransition(ops,'reconcile','SUCCESS');assert(!calls.includes('activate'));assert(!calls.includes('rollback'));assert(calls.includes('unlock'));
    calls.length=0;ops.unlock=async()=>{calls.push('unlock');throw Error('fsync fixture');};
    await assert.rejects(()=>runCriticalWebTransition(ops,'deploy','PREPARED'));
    assert(calls.includes('SUCCESS'));assert(!calls.includes('rollback'));assert(!calls.includes('ROLLBACK_INTENT'));
  `,
    ));
  it('aborts incomplete preparation without up and rejects recovery of unknown phases', () =>
    scenario(
      operations +
        `
    await runCriticalWebTransition(ops,'recover','PREPARED');assert.deepEqual(calls,['attestPrevious','attestBackend','ABORTED']);
    for (const mode of ['deploy','recover','reconcile']) await assert.rejects(()=>runCriticalWebTransition(ops,mode,'UNKNOWN'));
  `,
    ));
  it('requires 900 seconds, private/public samples, fresh attestations and latency budgets', () =>
    scenario(`
    let clock=0;let attests=0;const probes=[];
    const ops={now:()=>clock,sleep:async ms=>{clock+=ms;},attest:async()=>{attests++;},probe:async(s,p)=>{probes.push([s,p]);return 10;}};
    const result=await observeCriticalWeb(ops);assert.equal(clock,900000);assert.equal(result.samples.length,61);assert.equal(probes.length,244);assert.equal(attests,62);
    clock=0;await assert.rejects(()=>observeCriticalWeb({...ops,probe:async()=>2000}),/LATENCY_THRESHOLD/);
    clock=0;await assert.rejects(()=>observeCriticalWeb({...ops,sleep:async()=>{}}),/OBSERVATION_WINDOW/);
    await assert.rejects(()=>observeCriticalWeb({...ops,attest:async()=>{throw Error('backend drift');}}),/backend drift/);
  `));
  it('stops stale-Web/expired-authority races before pull or up, without restoring a stale baseline', () =>
    scenario(
      operations +
        `
    ops.attestPrevious=async()=>{calls.push('attestPrevious');throw Error('post-lock drift');};
    await assert.rejects(()=>runCriticalWebTransition(ops,'deploy','PREPARED'));
    assert(!calls.includes('pull'));assert(!calls.includes('ACTIVATING'));assert(!calls.includes('rollback'));
    calls.length=0;ops.attestPrevious=async()=>{};
    ops.authorizeActivation=async()=>{calls.push('authorizeActivation');throw Error('drift after smoke');};
    await assert.rejects(()=>runCriticalWebTransition(ops,'deploy','PREPARED'));
    assert(calls.includes('artifactSmoke'));assert(!calls.includes('ACTIVATING'));assert(!calls.includes('activate'));assert(!calls.includes('rollback'));
    calls.length=0;ops.authorizeActivation=async()=>{};
    ops.activate=async()=>{calls.push('pre-up gate');throw Error('immediate drift');};
    await assert.rejects(()=>runCriticalWebTransition(ops,'deploy','PREPARED'));
    assert(!calls.includes('rollback'));assert(calls.includes('PREPARATION_FAILED'));
  `,
    ));
  it('validates strict terminal receipt schema and preserves its observation time', () =>
    scenario(`
    const {createHash}=await import('node:crypto');const bytes=Buffer.from('synthetic');const h=createHash('sha256').update(bytes).digest('hex');
    const receipt={schema:'PHUB_TIMEWEB_CRITICAL_WEB_RECEIPT_V1',status:'SUCCESS',planSha256:h,operationSha256:h,observedAt:'2026-10-10T10:00:00.000Z',userOutcome:'requires-product-feedback',observationSha256:h,providerSha256:h,alertSha256:h};
    validateCriticalWebReceipt(receipt,h,h,()=>bytes);
    for (const change of [{extra:true},{planSha256:'wrong'},{operationSha256:'wrong'},{observedAt:'invalid'},{status:'UNKNOWN'},{reconciledAt:receipt.observedAt}]) assert.throws(()=>validateCriticalWebReceipt({...receipt,...change},h,h,()=>bytes));
    validateCriticalWebReceipt({...receipt,status:'RECONCILED',reconciledStatus:'SUCCESS',reconciledAt:'2026-10-10T10:30:00.000Z'},h,h,()=>bytes);
  `));
  it('rejects duplicate or foreign Web containers without mutation while allowing a missing failed target', () =>
    scenario(`
    const plan={candidate:{image:'candidate',releaseId:'new'},previous:{web:{image:'previous',releaseId:'old'}}};
    const row={Config:{Image:'candidate',Labels:{'phub.release-id':'new'}}};
    validateCriticalWebRecoveryImages([],plan);validateCriticalWebRecoveryImages([row],plan);
    assert.throws(()=>validateCriticalWebRecoveryImages([row,row],plan),/WEB_AMBIGUOUS/);
    assert.throws(()=>validateCriticalWebRecoveryImages([{Config:{Image:'foreign',Labels:{'phub.release-id':'new'}}}],plan),/WEB_UNKNOWN/);
  `));
  it('requires all three durable success evidence hashes before releasing an uncertain lock', () =>
    scenario(`
    const {createHash}=await import('node:crypto');
    const bytes=Buffer.from('synthetic');const hash=createHash('sha256').update(bytes).digest('hex');
    const receipt={observationSha256:hash,providerSha256:hash,alertSha256:hash};
    validateCriticalWebSuccessEvidence(receipt,()=>bytes);
    for (const field of ['observationSha256','providerSha256','alertSha256']) assert.throws(()=>validateCriticalWebSuccessEvidence({...receipt,[field]:''},()=>bytes));
    for (const name of ['observation.json','provider-final.json','alerts-final.json']) {
      assert.throws(()=>validateCriticalWebSuccessEvidence(receipt,path=>path===name ? Buffer.from('tampered') : bytes));
      assert.throws(()=>validateCriticalWebSuccessEvidence(receipt,path=>{if(path===name) throw Error('missing');return bytes;}));
    }
  `));
  it('has a distinct token-free manual executor and Web-only mutations', () => {
    const source = readFileSync('scripts/timeweb-critical-web.js', 'utf8');
    expect(source).not.toMatch(
      /GH_TOKEN|workflow_dispatch|dispatches|method:\s*['"]POST|runManualApiWebUpgrade\(/,
    );
    expect(source).toContain("apiWebArtifactSmokeArgs('web'");
    expect(source).toContain('standardWebComposeArgs(COMPOSE');
    expect(source).not.toContain('installed-components.env');
  });
});
