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
    assert.equal(WEB_CONTROLLER_FILES.size,14);
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
const web712Fixture =
  fixture +
  `
  const {WEB712_SCHEMA,WEB712_COMPATIBILITY:current,assertCriticalWebMain,criticalWebDirectories,
    validateCriticalWebPlanBinding,validateWeb712RestoreBinding,web712Backup,attestWeb712BackupScope}=await import('./scripts/timeweb-critical-web.js');
  const {createHash}=await import('node:crypto');
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  op.schema=WEB712_SCHEMA;
  op.expectedApi.releaseId=current.apiReleaseId;op.expectedApi.image=current.apiImage;
  op.expectedWeb.releaseId=current.webReleaseId;op.expectedWeb.image=current.webImage;
  op.confirmation='UPGRADE_WEB_712_DIRECT_AAAAAAAAAAAA_FROM_'+current.webImage.slice(-12).toUpperCase()+'_KEEP_API_492937113C0F';
  const postgres={id:'6'.repeat(64),image:'postgres@sha256:'+'7'.repeat(64)};
  const backup={schema:'PHUB_TIMEWEB_WEB_712_FRESH_BACKUP_V1',profile:'production',expiresAt:op.expiresAt,
    target:op.target,expectedApi:op.expectedApi,expectedWeb:op.expectedWeb,expectedPostgres:postgres,
    controllerSha:sha,controllerTree:op.candidateTree,toolCommit:sha,candidateSha:sha,
    publicationRunId:op.publicationRunId,releaseId:sha+'-22-1'};
  const bytes=Buffer.from(JSON.stringify(backup));
  op.backupOperationSha256=digest(bytes);
  const evidenceNames=['snapshot-witness.json','restore-admission-reference.json','owner-restore-decision.json'];
  const {backupDirectory}=criticalWebDirectories(op);
  const dumpIdentity={dev:1,ino:2,size:345,mtimeMs:4,ctimeMs:5};
  const receipt={schema:'PHUB_TIMEWEB_WEB_712_FRESH_DUMP_V1',
    operationSha256:op.backupOperationSha256,baselineReleaseId:op.expectedApi.releaseId,
    freshDumpRestored:false,freshDumpIntegrityStatus:'PG16_TOC_PARSE_VERIFIED',
    restoreAdmissionPolicy:'WEB_712_INTEGRITY_ONLY_V1',backupFile:backupDirectory+'/database.pgcustom',
    backupSha256:'b'.repeat(64),dumpLimitBytes:4*1024**3,dumpBytes:dumpIdentity.size,
    completedAt:new Date(now-1000).toISOString()};
`;
describe('closed Web rollout of #712', () => {
  it('records direct checks without claiming provider monitoring or alert delivery', () =>
    scenario(
      web712Fixture +
        `
    const observation=Buffer.from('synthetic direct Web and API observation');
    const h='a'.repeat(64);
    const result={schema:'PHUB_TIMEWEB_CRITICAL_WEB_RECEIPT_V1',status:'SUCCESS',
      planSha256:h,operationSha256:h,observedAt:new Date(now).toISOString(),
      userOutcome:'requires-product-feedback',observationSha256:digest(observation),
      providerMonitoringStatus:'NOT_COLLECTED_EXPLICIT_OVERRIDE',
      alertTestStatus:'NOT_TESTED_EXPLICIT_OVERRIDE'};
    const read=name=>{assert.equal(name,'observation.json');return observation;};
    validateCriticalWebReceipt(result,h,h,read,true);
    assert.throws(()=>validateCriticalWebReceipt(result,h,h,read),/RECEIPT/);
    for (const bad of [{providerSha256:h},{alertSha256:h},{alertTestStatus:'PASSED'}])
      assert.throws(()=>validateCriticalWebReceipt({...result,...bad},h,h,read,true),/RECEIPT/);
    assert.throws(()=>validateCriticalWebReceipt(result,h,h,()=>Buffer.from('changed'),true),/SUCCESS_EVIDENCE/);
  `,
    ));

  it('binds activation to the exact previous Web, unchanged API and current main', () =>
    scenario(
      web712Fixture +
        `
    validateCriticalWebOperation(op,now);
    for (const overrides of [
      {component:'api'}, {backupOperationSha256:'bad'}, {controllerSha:'d'.repeat(40)},
      {expectedApi:{...op.expectedApi,image:op.expectedApi.image.replace(/.$/,'0')}},
      {expectedWeb:{...op.expectedWeb,releaseId:current.baselineSource+'-99-1'}},
      {confirmation:op.confirmation.replace('UPGRADE_WEB_712','UPGRADE_WEB')},
    ]) assert.throws(()=>validateCriticalWebOperation({...op,...overrides},now));
    assertCriticalWebMain(op,args=>{
      assert.deepEqual(args,['-C','/','-c','protocol.https.allow=always','-c','http.followRedirects=false','ls-remote',
        'https://github.com/Z6v6e6r/lk2.git','refs/heads/main']);
      return sha+'\\trefs/heads/main';
    });
    for (const bad of [sha+'\\trefs/heads/wrong',current.runtimeSource+'\\trefs/heads/main',
      sha+'\\trefs/heads/main\\n'+sha+'\\trefs/heads/main']) {
      assert.throws(()=>assertCriticalWebMain(op,()=>bad),/MAIN_DRIFT/);
    }
  `,
    ));

  it('requires the six-file application delta and exact controller-only tail', () =>
    scenario(
      web712Fixture +
        `
    const {execFileSync}=await import('node:child_process');
    const real=args=>execFileSync('git',args,{encoding:'utf8'}).trim();
    const raw=real(['diff','--raw','--no-abbrev','--no-renames','-z',current.baselineSource,current.runtimeSource]);
    assert.equal(digest(raw),current.runtimeDeltaSha256);
    assert.equal(raw.split('\\0').filter(Boolean).length,12);
    const paths=['scripts/timeweb-critical-web.js','scripts/timeweb-critical-web.test.ts','docs/runbooks/timeweb-standard-delivery.md',
      'scripts/control-timeweb-database-backup.py','scripts/test-timeweb-database-backup.py'];
    const tail=paths.map(path=>'M\\0'+path+'\\0').join('');
    const runGit=args=>{
      if(args[0]==='rev-parse') {
        if(args[1]==='HEAD') return sha;
        if([sha+'^{tree}','HEAD^{tree}'].includes(args[1])) return op.candidateTree;
        return real(args);
      }
      if(args[0]==='status') return '';
      if(args[0]==='merge-base') return real(args.map(value=>value===sha?'HEAD':value));
      if(args[0]==='diff') return args.includes('--raw')?raw:tail;
      if(args[0]==='ls-tree') return '100644 blob '+'e'.repeat(40)+'\\t'+args.at(-1);
      throw Error('unexpected Git command');
    };
    validateCriticalWebSource(op,runGit);
    assert.equal(attestWeb712BackupScope(backup,{runGit,readService:name=>name==='api'?op.expectedApi:op.expectedWeb}),
      'APP_ONLY_BACKUP_SCOPE_VERIFIED');
    assert.throws(()=>attestWeb712BackupScope(backup,{runGit,readService:()=>op.expectedApi}),/BACKUP_BASELINE/);
    assert.throws(()=>validateCriticalWebSource(op,args=>args.includes('--raw')?raw+'x':runGit(args)),/RUNTIME_PROOF/);
    for (const delta of [tail+'M\\0apps/web/src/App.tsx\\0',tail.replace('M','R'),tail.slice(2),'']) {
      assert.throws(()=>validateCriticalWebSource(op,args=>args.includes('--name-status')?delta:runGit(args)),/SOURCE_DELTA/);
    }
    assert.throws(()=>validateCriticalWebSource(op,args=>args[0]==='ls-tree'?runGit(args).replace('100644','100755'):runGit(args)),/CONTROLLER_FILE_MODE/);
  `,
    ));

  it('requires a recent integrity-checked dump for the same releases and running database', () =>
    scenario(
      web712Fixture +
        `
    const dirs=criticalWebDirectories(op);
    assert.equal(dirs.backupDirectory,'/opt/phub/timeweb-beta/backups/'+sha+'-22-1-api-web');
    const input={op,operationBytes:bytes,receipt,api:op.expectedApi,postgres,now};
    validateWeb712RestoreBinding(input);
    for (const overrides of [
      {operationBytes:Buffer.concat([bytes,Buffer.from(' ')])},
      {api:{...input.api,id:'0'.repeat(64)}},
      {postgres:{...postgres,id:'0'.repeat(64)}},
      {receipt:{...receipt,freshDumpRestored:true}},
      {receipt:{...receipt,freshDumpIntegrityStatus:'UNCHECKED'}},
      {receipt:{...receipt,dumpLimitBytes:7*1024**3}},
      {receipt:{...receipt,operationSha256:'0'.repeat(64)}},
      {receipt:{...receipt,completedAt:new Date(now-3600001).toISOString()}},
      {receipt:{...receipt,completedAt:new Date(now+1).toISOString()}},
    ]) assert.throws(()=>validateWeb712RestoreBinding({...input,...overrides}),/BACKUP_INTEGRITY/);
    const h='9'.repeat(64);
    const plan={operationSha256:h,compatibility:current,backup:{
      path:dirs.backupDirectory+'/database-backup-receipt.json',
      operationPath:dirs.backupDirectory+'/backup-operation.json',
      operationSha256:op.backupOperationSha256,
      terminalPath:dirs.backupDirectory+'/FRESH_DUMP_INTEGRITY_VERIFIED.json',terminalSha256:h,
      dumpSha256:h,evidence:Object.fromEntries(evidenceNames.map(name=>[name,h])),
    }};
    validateCriticalWebPlanBinding(plan,op,h);
    assert.throws(()=>validateCriticalWebPlanBinding({...plan,backup:{...plan.backup,terminalPath:'elsewhere'}},op,h),/PLAN_BINDING/);
  `,
    ));
});

describe('closed Web fresh backup verification', () => {
  it('verifies terminal custody, sealed evidence and live database state', () =>
    scenario(
      web712Fixture +
        `
    const {execFileSync}=await import('node:child_process');
    const {readFileSync,readdirSync}=await import('node:fs');
    const root='packages/database/migrations/';
    const rows=readdirSync(root)
      .filter(name=>/^\\d{4}_.*\\.sql$/.test(name)&&Number(name.slice(0,4))<=120).sort()
      .map(name=>[name,digest(readFileSync(root+name))]);
    const ledger=JSON.stringify(rows)+'\\n';
    const expectedDatabaseTarget={databaseName:'synthetic-postgres',systemIdentifier:'1234567890123456789'};
    const restoreBytes=Buffer.from(JSON.stringify({
      ...backup,expectedDatabaseTarget,expectedLedgerSha256:digest(ledger),toolFileSha256:'a'.repeat(64),
    }));
    op.backupOperationSha256=digest(restoreBytes);
    const receiptPath=backupDirectory+'/database-backup-receipt.json';
    const operationPath=backupDirectory+'/backup-operation.json';
    const terminalPath=backupDirectory+'/FRESH_DUMP_INTEGRITY_VERIFIED.json';
    const supportPaths=evidenceNames.map(name=>backupDirectory+'/'+name);
    const files=new Map([
      [receiptPath,Buffer.from(JSON.stringify({...receipt,operationSha256:op.backupOperationSha256}))],
      [operationPath,restoreBytes],[terminalPath,Buffer.from('synthetic verified producer journal')],
      ...supportPaths.map(path=>[path,Buffer.from('synthetic sealed evidence')]),
    ]);
    const run=(failure, changedPath, heldProof)=>web712Backup(backupDirectory,op.expectedApi,op,{
      read:path=>files.get(path),readPostgres:()=>postgres,now:()=>now,readDumpIdentity:()=>dumpIdentity,heldProof,
      runPython:(file,args,options)=>{
        assert.equal(file,'/usr/bin/python3');
        assert.deepEqual(args.slice(0,-1),['-I','-S','-B','-c']);
        assert.equal(options.input,restoreBytes);
        assert.deepEqual(Object.keys(options.env).sort(),['HOME','LANG','PATH']);
        if(failure==='process') throw Error('synthetic process failure');
        const stub=[
          'import hashlib, importlib.util, json, types',
          'failure='+JSON.stringify(failure),
          'expected='+JSON.stringify(JSON.stringify({target:expectedDatabaseTarget,ledger})),
          'fixture=json.loads(expected)',
          'def verify(name, op):',
          ' assert op["profile"]=="production" and failure!=name',
          'def read_only(query, pg):',
          ' assert pg=='+JSON.stringify(postgres.id),
          ' if query=="target":',
          '  return json.dumps({**fixture["target"],"inRecovery":failure=="target"})',
          ' return fixture["ledger"] if failure!="ledger" else "[]"+chr(10)',
          'module=types.SimpleNamespace(strict=json.loads, digest=lambda value: hashlib.sha256(value).hexdigest(),',
          ' validate_operation=lambda op,*args,**kwargs: verify("operation",op),',
          ' tool_custody=lambda op:verify("tool",op),',
          ' attest_integrity_only_restore_message=lambda op:verify("decision",op),',
          ' validate_fresh_terminal=lambda op,raw:verify("terminal",op),',
          ' SOURCE_CUTOVER_TARGET="target", SOURCE_LEDGER="ledger", source_query=read_only,',
          ' ledger_bytes=lambda text:text.encode("utf8"))',
          'importlib.util.spec_from_file_location=lambda *args:types.SimpleNamespace(loader=types.SimpleNamespace(exec_module=lambda m:None))',
          'importlib.util.module_from_spec=lambda _:module',
        ].join('\\n');
        const output=execFileSync(file,[...args.slice(0,-1),stub+'\\n'+args.at(-1)],options);
        if (changedPath) files.set(changedPath,Buffer.from('changed after verification'));
        return failure==='extra-output'?output+'extra':output;
      }
    });
    const proof=run('');
    assert.deepEqual(proof,{
      path:receiptPath,sha256:digest(files.get(receiptPath)),
      operationPath,operationSha256:op.backupOperationSha256,
      terminalPath,terminalSha256:digest(files.get(terminalPath)),
      dumpIdentity,dumpSha256:receipt.backupSha256,
      evidence:Object.fromEntries(evidenceNames.map((name,i)=>[name,digest(files.get(supportPaths[i]))])),
    });
    assert.deepEqual(run('terminal',undefined,proof),proof);
    for(const failure of ['operation','tool','decision','terminal','target','ledger','process','extra-output'])
      assert.throws(()=>run(failure),/BACKUP_INTEGRITY/);
    assert.throws(()=>run('ledger',undefined,proof),/BACKUP_INTEGRITY/);
    for(const path of [receiptPath,operationPath,terminalPath,...supportPaths]){
      const original=files.get(path);
      assert.throws(()=>run('',path),/BACKUP_DRIFT/);
      files.set(path,original);
    }
  `,
    ));
});

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
  it('requires exactly the reviewed modified inert paths with no subset, duplicate, rename or runtime drift', () =>
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
    const real=args=>execFileSync('git',args,{encoding:'utf8'}).trim();
    // The ancestry check must use the real checked-out candidate, never the anchor itself.
    const runGit=args=>args[0]==='rev-parse' ? args[1]===op.candidateSha+'^{tree}' ? op.candidateTree : real(args) : args[0]==='merge-base' ? real([...args.slice(0,-1),args.at(-1)===op.candidateSha?'HEAD':args.at(-1)]) : args[0]==='diff' ? args.includes('--raw') ? raw : delta : args[0]==='ls-tree' ? '100644 blob '+'e'.repeat(40)+'\\t'+args.at(-1) : '';
    validateCriticalWebSource(op,runGit);
    // A candidate that does not descend from the reviewed anchor must reject.
    assert.throws(()=>validateCriticalWebSource(op,args=>args[0]==='merge-base' ? real([...args.slice(0,-1),current.baselineSource]) : runGit(args)));
    for(const mode of ['100755','120000','160000']) assert.throws(()=>validateCriticalWebSource(op,args=>args[0]==='ls-tree' ? mode+' blob '+'e'.repeat(40)+'\\t'+args.at(-1) : runGit(args)),/CONTROLLER_FILE_MODE/);
    assert.throws(()=>validateCriticalWebSource(op,args=>args[0]==='ls-tree' ? '100644 blob '+'e'.repeat(40)+'\\t'+'other' : runGit(args)),/CONTROLLER_FILE_MODE/);
    assert.throws(()=>validateCriticalWebSource(op,args=>args[0]==='diff'&&args.includes('--raw') ? raw+'changed' : runGit(args)),/RUNTIME_PROOF/);
    // Reviewed re-anchor: only the Web Dockerfile stays byte-identical to API8158. The SDK,
    // user-v1 OpenAPI and lockfile advanced with current main and are reviewed by the dead-code
    // guards below plus this runbook record.
    assert.equal(execFileSync('git',['rev-parse',current.apiSource+':apps/web/Dockerfile'],{encoding:'utf8'}),execFileSync('git',['rev-parse',current.runtimeSource+':apps/web/Dockerfile'],{encoding:'utf8'}));
    const fs=await import('node:fs');
    const gateway=fs.readFileSync('apps/web/src/auth-gateway.ts','utf8');
    const games=fs.readFileSync('apps/web/src/GamesPage.tsx','utf8');
    // Dead paid-JOIN capability: the production browser gateway only declares the advisory
    // join-conditions method and never implements it, so canPaidJoin is false and the paid path
    // (join-conditions, join-operation, commercial join body) is unreachable over API8158.
    // Both occurrences are the single optional declaration and its indexed-access type; there
    // is no implementation in the production browser gateway.
    assert.equal((gateway.match(/getGameJoinConditions/g)||[]).length,2);
    assert.ok(gateway.includes("readonly getGameJoinConditions?: PadlHubApiClient['getGameJoinConditions'];"));
    assert.ok(games.includes("typeof gateway.getGameJoinConditions === 'function'"));
    assert.ok(games.includes("typeof gateway.joinPaidGame === 'function'"));
    // The reviewed runbook records that paid JOIN stays disabled over API8158.
    assert.match(fs.readFileSync('docs/runbooks/timeweb-standard-delivery.md','utf8'),/paid JOIN stays disabled over API8158/);
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
