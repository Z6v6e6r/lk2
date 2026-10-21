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
      validateCriticalWebSource, WEB_CONTROLLER_FILES, validateCriticalWebReceipt, validateCriticalWebRecoveryImages, validateCriticalWebSuccessEvidence, runCriticalWebTransition, observeCriticalWeb, WEB_COMPATIBILITY} from './scripts/timeweb-critical-web.js';
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
    assert.equal(WEB_CONTROLLER_FILES.size,8);
    for (const path of ['.github/workflows/publish-timeweb-amd64-images.yaml','scripts/timeweb-amd64-publication-workflow.test.ts']) {
      for (const status of ['A','M']) validateWebControllerDelta([{status,path}]);
      for (const status of ['R100','D','T','C100']) assert.throws(()=>validateWebControllerDelta([{status,path}]));
    }
    for (const path of ['package-lock.json','package.json','apps/web/src/styles.css','apps/web/src/auth-gateway.ts','apps/web/Dockerfile','contracts/openapi/user/v2/openapi.yaml','packages/api-sdk/src/index.ts','.github/workflows/reconcile-timeweb-amd64-publication.yaml','.github/workflows/publish-timeweb-amd64-images.yml','scripts/timeweb-amd64-publication-workflow.test.js','scripts/timeweb-amd64-registry-custody-retry.sh','scripts/presentation-boundary.js']) assert.throws(()=>validateWebControllerDelta([{status:'M',path}]));
    for (const status of ['R100','D','T','C100']) assert.throws(()=>validateWebControllerDelta([{status,path:'scripts/timeweb-critical-web.js'}]));
  `));
  it('requires regular non-executable blobs for each inert publisher path', () => {
    const raw = spawnSync(
      'git',
      [
        'diff',
        '--raw',
        '--no-abbrev',
        '--no-renames',
        '-z',
        '0d6078be7a50ed3f5761d66071527be003bd568f',
        '8960afe24211372320006fc4c5b18905923672f5',
      ],
      { encoding: 'utf8' },
    );
    expect(raw.status, raw.stderr).toBe(0);
    scenario(
      fixture +
        `
      const raw=${JSON.stringify(raw.stdout.trim())};
      for (const path of ['.github/workflows/publish-timeweb-amd64-images.yaml','scripts/timeweb-amd64-publication-workflow.test.ts']) {
        for (const mode of ['100644','100755','120000','160000']) {
          const runGit=args=>args[0]==='rev-parse' ? args[1]===op.candidateSha+'^{tree}' ? op.candidateTree : args[1]===WEB_COMPATIBILITY.baselineSource+'^{tree}' ? WEB_COMPATIBILITY.baselineTree : WEB_COMPATIBILITY.runtimeTree : args[0]==='diff' ? args.includes('--raw') ? raw : 'M\\0'+path+'\\0' : args[0]==='ls-tree' ? mode+' blob '+'e'.repeat(40)+'\\t'+path : '';
          if (mode==='100644') validateCriticalWebSource(op,runGit);
          else assert.throws(()=>validateCriticalWebSource(op,runGit),/CONTROLLER_FILE_MODE/);
        }
      }
    `,
    );
  });
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

const currentFixture =
  fixture +
  `
  const {API8158_WEB_COMPATIBILITY: current, API8158_WEB_SCHEMA, API8158_WEB_CONTROLLER_FILES,
    criticalWebDirectories,validateCriticalWebPlanBinding,criticalWebMonitoring}=await import('./scripts/timeweb-critical-web.js');
  op.schema=API8158_WEB_SCHEMA;
  op.expectedApi.releaseId=current.apiReleaseId;op.expectedApi.image=current.apiImage;
  op.expectedWeb.image=current.webImage;op.expectedWeb.releaseId=current.webReleaseId;
  op.confirmation='UPGRADE_API8158_WEB_AAAAAAAAAAAA_FROM_'+current.webImage.slice(-12).toUpperCase()+'_KEEP_API_8158AC445C9F';
`;
describe('closed Web over installed API8158', () => {
  it('separates immutable API and rollback Web identities and operation authority', () =>
    scenario(
      currentFixture +
        `
    validateCriticalWebOperation(op,now);
    for(const change of [v=>v.schema='PHUB_TIMEWEB_CRITICAL_PROFILE_V2_WEB_OPERATION_V1',v=>v.schema='PHUB_TIMEWEB_CRITICAL_WEB_OPERATION_V1',v=>v.expectedApi.releaseId=op.expectedWeb.releaseId,v=>v.expectedWeb.releaseId=current.apiReleaseId,v=>v.expectedWeb.releaseId=current.baselineSource+'-99-1',v=>v.expectedApi.image='ghcr.io/z6v6e6r/phub-api@sha256:'+'0'.repeat(64),v=>v.expectedWeb.image='ghcr.io/z6v6e6r/phub-web@sha256:'+'0'.repeat(64),v=>v.confirmation='UPGRADE_WEB_AAAAAAAAAAAA_FROM_'+current.webImage.slice(-12).toUpperCase()+'_KEEP_API_0D6078BE7A50']) {
      const bad=structuredClone(op);change(bad);assert.throws(()=>validateCriticalWebOperation(bad,now));
    }
    const dirs=criticalWebDirectories(op);
    assert.equal(dirs.transaction,'/opt/phub/timeweb-beta/backups/'+sha+'-22-1-web');
    assert.equal(dirs.backupDirectory,'/opt/phub/timeweb-beta/backups/'+sha+'-11-1-web');
    const plan={operationSha256:'e'.repeat(64),compatibility:current,backup:{path:dirs.backupDirectory+'/database-backup-receipt.json'}};
    validateCriticalWebPlanBinding(plan,op,'e'.repeat(64));
    for(const change of [v=>v.operationSha256='f'.repeat(64),v=>v.compatibility=WEB_COMPATIBILITY,v=>v.backup.path=dirs.transaction+'/database-backup-receipt.json']) {
      const bad=structuredClone(plan);change(bad);assert.throws(()=>validateCriticalWebPlanBinding(bad,op,'e'.repeat(64)));
    }
  `,
    ));
  it('requires all six modified inert paths with no subset, duplicate, rename or runtime drift', () =>
    scenario(
      currentFixture +
        `
    const entries=[...API8158_WEB_CONTROLLER_FILES].map(path=>({status:'M',path}));
    validateWebControllerDelta(entries,op);
    for(const bad of [[],entries.slice(1),[...entries,entries[0]],entries.map((v,i)=>i? v:{...v,status:'A'}),entries.map((v,i)=>i? v:{...v,status:'D'}),entries.map((v,i)=>i? v:{...v,path:'apps/web/src/App.tsx'}),entries.map((v,i)=>i? v:{...v,status:'R100'})]) assert.throws(()=>validateWebControllerDelta(bad,op));
    for(const path of ['package-lock.json','packages/api-sdk/src/index.ts','contracts/openapi/user/v1/openapi.yaml','deploy/timeweb/compose.beta.yaml','.github/workflows/publish-timeweb-amd64-images.yaml']) assert.throws(()=>validateWebControllerDelta([...entries,{status:'M',path}],op));
  `,
    ));
  it('checks actual reviewed whole-tree proof and exact regular blob paths', () =>
    scenario(
      currentFixture +
        `
    const {execFileSync}=await import('node:child_process');
    const raw=execFileSync('git',['diff','--raw','--no-abbrev','--no-renames','-z',current.baselineSource,current.runtimeSource],{encoding:'utf8'}).trim();
    const delta=[...API8158_WEB_CONTROLLER_FILES].map(path=>'M\\0'+path+'\\0').join('');
    const runGit=args=>args[0]==='rev-parse' ? args[1]===op.candidateSha+'^{tree}' ? op.candidateTree : execFileSync('git',args,{encoding:'utf8'}).trim() : args[0]==='merge-base' ? execFileSync('git',args[args.length-1]===op.candidateSha ? [...args.slice(0,-1),current.runtimeSource] : args,{encoding:'utf8'}).trim() : args[0]==='diff' ? args.includes('--raw') ? raw : delta : args[0]==='ls-tree' ? '100644 blob '+'e'.repeat(40)+'\\t'+args.at(-1) : '';
    validateCriticalWebSource(op,runGit);
    for(const mode of ['100755','120000','160000']) assert.throws(()=>validateCriticalWebSource(op,args=>args[0]==='ls-tree' ? mode+' blob '+'e'.repeat(40)+'\\t'+args.at(-1) : runGit(args)),/CONTROLLER_FILE_MODE/);
    assert.throws(()=>validateCriticalWebSource(op,args=>args[0]==='ls-tree' ? '100644 blob '+'e'.repeat(40)+'\\t'+'other' : runGit(args)),/CONTROLLER_FILE_MODE/);
    assert.throws(()=>validateCriticalWebSource(op,args=>args[0]==='diff'&&args.includes('--raw') ? raw+'changed' : runGit(args)),/RUNTIME_PROOF/);
    for(const path of ['packages/api-sdk/src/index.ts','contracts/openapi/user/v1/openapi.yaml','package-lock.json','apps/web/Dockerfile']) assert.equal(execFileSync('git',['rev-parse',current.apiSource+':'+path],{encoding:'utf8'}),execFileSync('git',['rev-parse',current.runtimeSource+':'+path],{encoding:'utf8'}));
  `,
    ));
  it('checks fresh provider and alert bytes against wall time using the tracked 0644 contract', () =>
    scenario(
      currentFixture +
        `
    const fs=await import('node:fs');
    const timestamp='2026-09-02T07:39:20.000Z';const clock=Date.parse(timestamp);
    const monitor=(id,name,url)=>({providerMonitorId:id,name,enabled:true,type:'HTTPS',method:'GET',url,expectedStatus:200,regions:['ru-1','nl-1'],intervalSeconds:60,timeoutSeconds:10,authorizationHeaderConfigured:true,lastCheckAt:'2026-09-02T07:39:00.000Z',successfulConsecutiveRounds:3,activeIncidentCount:0});
    const provider={schema:'PHUB_TIMEWEB_MONITOR_READBACK_V1',source:'timeweb-approved-read-only-readback',readAt:'2026-09-02T07:39:19.000Z',projectId:262717,monitors:[monitor('26ed404e-98e5-45c5-98e3-31b9dfd6f0f2','lk2-beta-api-ready','https://lk2.padlhub.su/health/ready'),monitor('b25e28a0-02d8-49e4-a0a1-f49f62abc02c','lk2-beta-web-root','https://lk2.padlhub.su/')]};
    const alerts={schema:'PHUB_TIMEWEB_ALERT_READBACK_V1',source:'approved-delivery-and-provider-readback',testId:'synthetic-incident',monitorNames:['lk2-beta-api-ready','lk2-beta-web-root'],triggeredAt:'2026-09-02T07:25:00.000Z',deliveries:['email','telegram'].map(channel=>({channel,deliveredAt:'2026-09-02T07:26:00.000Z'})),acknowledgedAt:'2026-09-02T07:33:13.000Z',acknowledgementKind:'release-owner-observed-active-incident',acknowledgedByRole:'release-owner',recoveredAt:'2026-09-02T07:34:00.000Z',recoveryKind:'provider-closed-after-all-regions-healthy',recoveryDeliveries:['email','telegram'].map(channel=>({channel,deliveredAt:'2026-09-02T07:35:00.000Z'}))};
    const read=(p,mode)=>{if(p.endsWith('api-web-observability.v1.json')){assert.equal(mode,0o644);return fs.readFileSync('deploy/timeweb/api-web-observability.v1.json');}return Buffer.from(JSON.stringify(p.endsWith('timeweb-monitor-readback.json')?provider:alerts));};
    const proof=criticalWebMonitoring(clock,read);assert.equal(proof.provider.toString(),JSON.stringify(provider));
    for(const change of [()=>provider.readAt='2026-09-02T07:38:49.000Z',()=>provider.readAt='2026-09-02T07:40:00.000Z',()=>provider.monitors[0].activeIncidentCount=1,()=>provider.monitors[0].lastCheckAt='2026-09-02T07:30:00.000Z',()=>alerts.triggeredAt='2026-08-30T07:25:00.000Z',()=>provider.monitors[0].authorizationHeader='Basic '+Buffer.from('synthetic-forbidden').toString('base64')]){
      const p=structuredClone(provider),a=structuredClone(alerts);change();assert.throws(()=>criticalWebMonitoring(clock,read));
      for(const key of Object.keys(provider))delete provider[key];Object.assign(provider,p);for(const key of Object.keys(alerts))delete alerts[key];Object.assign(alerts,a);
    }
  `,
    ));
});
