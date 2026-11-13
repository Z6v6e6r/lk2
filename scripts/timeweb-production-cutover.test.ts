import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const legacySha = '759083e37b4026f9690a3775a391f59f68f716a5';
const components = ['api', 'web', 'worker', 'realtime', 'migrator'];
const containers = Object.fromEntries(
  components.slice(0, 4).map((name, n) => [
    name,
    {
      id: String(n + 1).repeat(64),
      image: `ghcr.io/z6v6e6r/phub-${name}@sha256:${String(n + 1).repeat(64)}`,
      imageId: `sha256:${String(n + 1).repeat(64)}`,
      releaseId: n < 2 ? `lk2-beta-${legacySha.slice(0, 12)}` : null,
      revision: null,
      restarts: 0,
      startedAt: '2026-11-12T10:57:44.208238957Z',
    },
  ]),
);
const baseline = {
  schema: 'LEGACY_TEST_STAND_RUNTIME_V1',
  sourceSha: legacySha,
  sourceTree: 'a'.repeat(40),
  sourceCiRunId: '43199615483',
  testStandRunId: '43202079490',
  capturedAt: '2026-11-13T17:00:00.000Z',
  releaseEnvSha256: 'a'.repeat(64),
  secretSetReleaseId: `${'b'.repeat(40)}-10-1`,
  secretHashes: Object.fromEntries(
    ['.release-identity.json', 'api.env', 'worker.env', 'realtime.env', 'migrator.env'].map((v) => [
      v,
      'c'.repeat(64),
    ]),
  ),
  containers,
  excludedSha256: 'd'.repeat(64),
  laneCurrentSha256: 'e'.repeat(64),
  laneHistorySha256: 'f'.repeat(64),
  databaseTarget: { databaseName: 'phub_beta', systemIdentifier: '7679125609183186977' },
  ledgerSha256: '9'.repeat(64),
  buildRecords: components.map((name, n) => ({
    component: name,
    artifactId: String(n + 10),
    artifactName: `Z6v6e6r~lk2~REC${n}.dockerbuild`,
    archiveDigest: `sha256:${'a'.repeat(64)}`,
    imageDigest: `sha256:${String(n + 1).repeat(64)}`,
  })),
};
const expected = (service: string) => ({
  id: containers[service]!.id,
  image: containers[service]!.image,
  releaseId: containers[service]!.releaseId,
});
const operation = {
  schema: 'PHUB_TIMEWEB_API_WEB_PRODUCTION_CUTOVER_V1',
  profile: 'production',
  target: 'lk2.padlhub.su',
  controllerSha: 'f'.repeat(40),
  candidateSha: 'f'.repeat(40),
  candidateTree: 'e'.repeat(40),
  sourceCiRunId: '100',
  publicationRunId: '101',
  artifactId: '102',
  artifactDigest: `sha256:${'a'.repeat(64)}`,
  manifestSha256: 'b'.repeat(64),
  backupOperationSha256: 'e'.repeat(64),
  expectedApi: expected('api'),
  expectedWeb: expected('web'),
  legacyBaseline: baseline,
  expiresAt: '2026-11-13T19:00:00.000Z',
  confirmation: '',
};
function scenario(body: string) {
  const code = `import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
    import {validateProductionCutover,validateLegacyBaseline,legacyBaselineHash,legacyEnvironment,validateLegacyRuntime,validateLegacyRun,validateLegacyArtifact,validateLegacyBuildRecord,validateCutoverLineage,validateCutoverBackupOperation,assertCutoverBackupFiles,assertCutoverReadbackFreshness,CUTOVER_RECEIPT,CUTOVER_PLAN} from './scripts/timeweb-production-cutover.js';
    import {validateApiWebOperation,readInstalledApiBaseline,buildApiWebInstalledDescriptor,runApiWebTransition,waitUpgradeService,validateUpgradeReceipt,attestApiWebTerminal,reconcileApiWebPhase,retainLegacyAttestation,readLegacyPredecessor} from './scripts/timeweb-api-web-upgrade.js';
    const hash=v=>createHash('sha256').update(v).digest('hex');
    const op=${JSON.stringify(operation)};const b=op.legacyBaseline;
    const confirm=()=>{op.confirmation='CUTOVER_PRODUCTION_'+op.candidateSha.slice(0,12).toUpperCase()+'_FROM_'+legacyBaselineHash(b).slice(0,12).toUpperCase()+'_KEEP_DATA_AND_ACCOUNTS';};confirm();
    ${body}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
}
describe('explicit production cutover from the observed noncanonical predecessor', () => {
  it('admits only the explicit new schema and leaves ordinary baseline readers closed', () => {
    scenario(
      String.raw`assert.equal(validateApiWebOperation(op),op);validateProductionCutover(op,true,Date.parse('2026-11-13T17:01:00.000Z'));assert.throws(()=>readInstalledApiBaseline(op.expectedApi.releaseId),/baseline_release_id/);const old=structuredClone(op);old.schema='PHUB_TIMEWEB_API_WEB_OPERATION_V1';assert.throws(()=>validateApiWebOperation(old));`,
    );
  });
  it.each([
    "op.profile='beta'",
    "op.target='other'",
    "op.candidateSha='a'.repeat(40)",
    'op.extra=true',
    "op.confirmation='yes'",
    "b.sourceSha='a'.repeat(40)",
    "b.sourceCiRunId='1'",
    "b.testStandRunId='1'",
    "b.databaseTarget.systemIdentifier='1'",
    'b.containers.api.revision=b.sourceSha',
    "b.containers.api.image='latest'",
    'b.containers.web.restarts=1',
    "b.containers.worker.releaseId='canonical'",
    "b.containers.api.id='bad'",
    "b.secretHashes['api.env']='bad'",
    'b.buildRecords.pop()',
    "b.buildRecords[1].component='api'",
    "b.buildRecords[0].imageDigest='sha256:'+'f'.repeat(64)",
    "op.expectedApi.id='f'.repeat(64)",
    "b.ledgerSha256='bad'",
  ])('rejects %s without changing the ordinary schemas', (mutation) => {
    scenario(`${mutation};assert.throws(()=>validateApiWebOperation(op));`);
  });
  it('rejects expired activation but still validates truthful historical custody', () => {
    scenario(
      String.raw`validateProductionCutover(op);assert.throws(()=>validateProductionCutover(op,true,Date.parse('2026-11-14T00:00:00.000Z')),/expired/);b.capturedAt='2026-11-13T15:00:00.000Z';confirm();assert.throws(()=>validateProductionCutover(op,true,Date.parse('2026-11-13T17:01:00.000Z')),/expired/);`,
    );
  });
  it('allows a completed long backup and preparation while retaining the two-hour capture bound', () => {
    scenario(
      String.raw`op.expiresAt='2026-11-13T20:00:00.000Z';validateProductionCutover(op,true,Date.parse('2026-11-13T18:10:00.000Z'));assert.throws(()=>validateProductionCutover(op,true,Date.parse('2026-11-13T19:00:00.001Z')),/expired/);`,
    );
  });
  it('validates only the fixed runtime paths and exact five digests, without inheriting stale publication claims', () => {
    scenario(
      String.raw`const text='PHUB_RELEASE_ID='+b.containers.api.releaseId+'\nTIMEWEB_RUNTIME_ENV_ROOT=/etc/phub/timeweb-beta\nTIMEWEB_FCM_CREDENTIAL_SOURCE=/etc/phub/timeweb-beta-fcm/fcm-service-account.json\n'+b.buildRecords.map(v=>v.component.toUpperCase()+'_IMAGE_DIGEST='+v.imageDigest).join('\n')+'\n';const bytes=Buffer.from(text);b.releaseEnvSha256=hash(bytes);const identity={schema:'PHUB_TIMEWEB_SECRET_SET_V1',releaseId:b.secretSetReleaseId};const env=legacyEnvironment(b,bytes,identity);assert.equal(env.PHUB_MIGRATOR_ENABLED,'false');assert.equal(env.PHUB_RUNTIME_SECRET_SET_RELEASE_ID,b.secretSetReleaseId);assert.equal(env.PHUB_CANONICAL_MANIFEST,undefined);for(const bad of [text+'EXTRA=1\n',text+'PHUB_RELEASE_ID=other\n',text.replace('/etc/phub/timeweb-beta\n','/tmp/runtime\n')]){const v=Buffer.from(bad);b.releaseEnvSha256=hash(v);assert.throws(()=>legacyEnvironment(b,v,identity));}b.releaseEnvSha256=hash(bytes);assert.throws(()=>legacyEnvironment(b,bytes,{...identity,releaseId:'other'}));`,
    );
  });
  it('detects excluded containers and secret-file drift before any activation', () => {
    scenario(
      String.raw`const excluded=[{id:'untouched'}];b.excludedSha256=hash(JSON.stringify(excluded));validateLegacyRuntime(b,b.containers,excluded,b.secretHashes);assert.throws(()=>validateLegacyRuntime(b,b.containers,[],b.secretHashes));assert.throws(()=>validateLegacyRuntime(b,b.containers,excluded,{...b.secretHashes,'api.env':'f'.repeat(64)}));const changed=structuredClone(b.containers);changed.api.startedAt='2026-11-13T00:00:00.000Z';assert.throws(()=>validateLegacyRuntime(b,changed,excluded,b.secretHashes));`,
    );
  });
  it('binds the authenticated Test stand run and immutable artifact identity', () => {
    scenario(
      String.raw`const run={id:Number(b.testStandRunId),head_sha:b.sourceSha,head_branch:'main',run_attempt:1,status:'completed',conclusion:'success',event:'workflow_run',path:'.github/workflows/test-stand.yaml'};validateLegacyRun(run,b);for(const delta of [{run_attempt:2},{head_sha:'a'.repeat(40)},{event:'workflow_dispatch'},{conclusion:'failure'}])assert.throws(()=>validateLegacyRun({...run,...delta},b));const r=b.buildRecords[0];const a={id:Number(r.artifactId),name:r.artifactName,digest:r.archiveDigest,expired:false,workflow_run:{id:Number(b.testStandRunId),head_sha:b.sourceSha}};validateLegacyArtifact(a,r,b);for(const delta of [{digest:'sha256:'+'f'.repeat(64)},{expired:true},{name:'other'}])assert.throws(()=>validateLegacyArtifact({...a,...delta},r,b));`,
    );
  });
  it('validates build-record blob hashes, exact source and actual result instead of trusting mutable tags', () => {
    scenario(
      String.raw`const blobs=new Map();const store=v=>{const bytes=Buffer.from(JSON.stringify(v));const digest='sha256:'+hash(bytes);blobs.set(digest,bytes);return digest;};const result=store({schemaVersion:2,manifests:[{platform:{os:'linux',architecture:'amd64'}}]});b.buildRecords[0].imageDigest=result;b.containers.api.image='ghcr.io/z6v6e6r/phub-api@'+result;op.expectedApi.image=b.containers.api.image;const h={FrontendAttrs:{'vcs:revision':b.sourceSha,'vcs:source':'https://github.com/Z6v6e6r/lk2','vcs:localdir:dockerfile':'apps/api',filename:'Dockerfile',platform:'linux/amd64','build-arg:PHUB_RELEASE':b.sourceSha,'attest:provenance':'type=provenance,builder-id=https://github.com/Z6v6e6r/lk2/actions/runs/'+b.testStandRunId+'/attempts/1,mode=max'},Result:{Results:{'0':{digest:result}}},CompletedAt:'valid'};const archive=Buffer.from('synthetic archive');b.buildRecords[0].archiveDigest='sha256:'+hash(archive);const indexFor=history=>Buffer.from(JSON.stringify({schemaVersion:2,manifests:[{digest:store({config:{mediaType:'application/vnd.buildkit.historyrecord.v0',digest:store(history)}})}]}));validateLegacyBuildRecord(b,'api',archive,indexFor(h),d=>blobs.get(d));h.FrontendAttrs['vcs:revision']='a'.repeat(40);assert.throws(()=>validateLegacyBuildRecord(b,'api',archive,indexFor(h),d=>blobs.get(d)),/build_source/);assert.throws(()=>validateLegacyBuildRecord(b,'api',Buffer.from('changed'),indexFor(h),d=>blobs.get(d)),/archive/);`,
    );
  });
  it('binds the exact backup capsule, producer source, PostgreSQL preimage and candidate transaction', () => {
    scenario(
      String.raw`const pg={...b.containers.api,id:'7'.repeat(64),image:'docker.io/library/postgres@sha256:'+'8'.repeat(64),imageId:'sha256:'+'8'.repeat(64),releaseId:null};const producer={schema:'PHUB_TIMEWEB_BACKUP_ATTESTED_BETA122_API_WEB_V1',profile:'production',candidateSha:op.candidateSha,controllerSha:op.controllerSha,controllerTree:op.candidateTree,toolCommit:op.controllerSha,publicationRunId:op.publicationRunId,releaseId:op.candidateSha+'-'+op.publicationRunId+'-1',expectedApi:b.containers.api,expectedPostgres:pg,predecessorAttestationSha256:legacyBaselineHash(b),expectedDatabaseTarget:b.databaseTarget,expectedLedgerSha256:b.ledgerSha256,toolFileSha256:'a'.repeat(64),controllerConfigSha256:'c'.repeat(64)};const facts={directory:'/opt/phub/timeweb-beta/backups/'+producer.releaseId+'-api-web',postgres:pg,toolFileSha256:producer.toolFileSha256,configSha256:producer.controllerConfigSha256};const original=Buffer.from(JSON.stringify(producer));op.backupOperationSha256=hash(original);validateCutoverBackupOperation(op,original,facts);for(const change of [v=>v.profile='beta',v=>v.releaseId='other',v=>v.expectedApi.id='f'.repeat(64),v=>v.expectedPostgres.id='e'.repeat(64),v=>v.expectedLedgerSha256='f'.repeat(64),v=>v.predecessorAttestationSha256='f'.repeat(64),v=>v.toolFileSha256='f'.repeat(64)]){const bad=structuredClone(producer);change(bad);const bytes=Buffer.from(JSON.stringify(bad));assert.throws(()=>validateCutoverBackupOperation(op,bytes,facts),/backup_operation_hash/);op.backupOperationSha256=hash(bytes);assert.throws(()=>validateCutoverBackupOperation(op,bytes,facts),/backup_operation/);op.backupOperationSha256=hash(original);}assert.throws(()=>validateCutoverBackupOperation(op,original,{...facts,directory:facts.directory+'-copied'}));`,
    );
  });
  it('requires a distinct cutover receipt and seals the manual lineage instead of accepting a V1 receipt', () => {
    scenario(
      String.raw`const bytes=Buffer.from(JSON.stringify(op));const digest=legacyBaselineHash(b);const plan={schema:CUTOVER_PLAN,operationSha256:hash(bytes),controllerSha:op.controllerSha,legacyBaselineSha256:digest,backup:{operationSha256:op.backupOperationSha256}};const receipt={schema:CUTOVER_RECEIPT,status:'PREPARING',planSha256:hash(JSON.stringify(plan)),observedAt:'2026-11-13T17:01:00.000Z',legacyBaselineSha256:digest};validateUpgradeReceipt(receipt,receipt.planSha256,op,plan,Buffer.from(JSON.stringify(plan)));const descriptor={PHUB_LEGACY_PREDECESSOR_SHA256:digest,PHUB_LEGACY_PREDECESSOR_RELEASE_ID:op.expectedApi.releaseId};validateCutoverLineage(receipt,plan,op,descriptor,bytes);assert.throws(()=>validateCutoverLineage({...receipt,schema:'PHUB_TIMEWEB_API_WEB_RECEIPT_V1'},plan,op,descriptor,bytes));assert.throws(()=>validateCutoverLineage(receipt,plan,op,{...descriptor,PHUB_LEGACY_PREDECESSOR_SHA256:'f'.repeat(64)},bytes));assert.throws(()=>validateUpgradeReceipt({...receipt,schema:'PHUB_TIMEWEB_API_WEB_RECEIPT_V1'},receipt.planSha256));`,
    );
  });
  it('rejects stale provider evidence at the wall clock, including the former October snapshot', () => {
    scenario(
      String.raw`const now=Date.parse('2026-11-13T17:01:00.000Z');assertCutoverReadbackFreshness('2026-11-13T17:00:45.000Z',now);for(const readAt of ['2026-10-22T14:46:44.179Z','2026-11-13T17:00:29.999Z','2026-11-13T17:01:01.000Z','invalid'])assert.throws(()=>assertCutoverReadbackFreshness(readAt,now),/monitoring_stale/);`,
    );
  });
  it('rechecks the actual dump and exact sealed backup/monitor keys before forward activation', () => {
    scenario(
      String.raw`const tx='/opt/phub/timeweb-beta/backups/'+op.candidateSha+'-'+op.publicationRunId+'-1-api-web';const files=new Map([[tx+'/database.pgcustom',Buffer.from('synthetic dump')],[tx+'/backup-operation.json',Buffer.from('synthetic producer request')]]);op.backupOperationSha256=hash(files.get(tx+'/backup-operation.json'));const dumpSha=hash(files.get(tx+'/database.pgcustom'));const receipt=Buffer.from(JSON.stringify({backupSha256:dumpSha}));files.set(tx+'/database-backup-receipt.json',receipt);const p={backup:{path:tx+'/database-backup-receipt.json',sha256:hash(receipt),receiptPath:tx+'/database-backup-receipt.json',receiptSha256:hash(receipt),operationPath:tx+'/backup-operation.json',operationSha256:op.backupOperationSha256,dumpSha256:dumpSha},monitoring:{providerSha256:'a'.repeat(64),alertSha256:'b'.repeat(64)}};const read=path=>{if(!files.has(path))throw Error('missing');return files.get(path);};assertCutoverBackupFiles(op,p,tx,read,path=>hash(read(path)));const original=files.get(tx+'/database.pgcustom');files.delete(tx+'/database.pgcustom');assert.throws(()=>assertCutoverBackupFiles(op,p,tx,read,path=>hash(read(path))));files.set(tx+'/database.pgcustom',Buffer.from('changed'));assert.throws(()=>assertCutoverBackupFiles(op,p,tx,read,path=>hash(read(path))),/backup_drift/);files.set(tx+'/database.pgcustom',original);for(const bad of [{...p,backup:{...p.backup,extra:true}},{...p,monitoring:{...p.monitoring,extra:true}}])assert.throws(()=>assertCutoverBackupFiles(op,bad,tx,read,path=>hash(read(path))));`,
    );
  });
  it('recovers API-first/Web-second failure by waiting for the real legacy null-revision pair', () => {
    scenario(
      String.raw`const cp=await import('node:child_process');const {syncBuiltinESMExports}=await import('node:module');const state=structuredClone(b.containers);const calls=[];cp.default.execFileSync=(program,args)=>{assert.equal(program,'/usr/bin/docker');if(args[0]==='ps'){const filter=args.find(v=>v.startsWith('label=com.docker.compose.service='));return state[filter.split('=').at(-1)].id;}if(args[0]==='inspect'){const v=Object.values(state).find(v=>v.id===args[1]);return JSON.stringify([{Id:v.id,Image:v.imageId,Config:{Image:v.image,Labels:{'phub.release-id':v.releaseId,'org.opencontainers.image.revision':v.revision}},State:{Status:'running',Health:{Status:'healthy'},StartedAt:v.startedAt},RestartCount:0}]);}throw Error('unexpected docker action');};syncBuiltinESMExports();globalThis.fetch=async()=>({status:200,text:async()=>'<div id="phub-app"></div>'});const journals=[];await assert.rejects(runApiWebTransition({preflight:async()=>{for(const s of ['api','web'])await waitUpgradeService(s,b.containers[s]);},pullAndSmoke:async()=>{},journal:async v=>journals.push(v),activate:async s=>{calls.push('activate-'+s);if(s==='web')throw Error('web start failed');state.api={...state.api,id:'9'.repeat(64),releaseId:op.candidateSha+'-101-1',revision:op.candidateSha};},restore:async s=>{calls.push('restore-'+s);state[s]={...structuredClone(b.containers[s]),id:(s==='api'?'9':'8').repeat(64),startedAt:'2026-11-13T17:02:00.000Z'};const restored=await waitUpgradeService(s,b.containers[s]);assert.equal(restored.imageId,b.containers[s].imageId);assert.equal(restored.revision,null);assert.notEqual(restored.id,b.containers[s].id);assert.notEqual(restored.startedAt,b.containers[s].startedAt);},attestRestored:async()=>{assert.deepEqual(state.worker,b.containers.worker);assert.deepEqual(state.realtime,b.containers.realtime);},installBaseline:async()=>{throw Error('must not install');}}),/web start failed/);assert.deepEqual(calls,['activate-api','activate-web','restore-web','restore-api']);assert.equal(journals.at(-1),'ROLLED_BACK');`,
    );
  });
  it('keeps rollback explicit and removes predecessor claims on the next ordinary release', () => {
    scenario(
      String.raw`const p={candidate:{api:{image:'ghcr.io/z6v6e6r/phub-api@sha256:'+'a'.repeat(64)},web:{image:'ghcr.io/z6v6e6r/phub-web@sha256:'+'b'.repeat(64)}},previous:{api:{releaseId:b.containers.api.releaseId}},secretSetReleaseId:b.secretSetReleaseId,unchangedServiceImages:{worker:b.containers.worker.image,realtime:b.containers.realtime.image},legacyBaselineSha256:legacyBaselineHash(b)};const env={PHUB_RELEASE_ID:b.containers.api.releaseId};const id=op.candidateSha+'-101-1';const path='/opt/phub/timeweb-beta/backups/'+id+'-api-web/rollout-receipt.json';const parse=x=>Object.fromEntries(x.toString().trim().split('\n').map(v=>v.split('=')));const installed=parse(buildApiWebInstalledDescriptor(env,p,id,path));assert.equal(installed.PHUB_ROLLBACK_MODE,'attested-previous-runtime');assert.equal(installed.PHUB_LEGACY_PREDECESSOR_RELEASE_ID,b.containers.api.releaseId);assert.equal(installed.PHUB_LEGACY_PREDECESSOR_SHA256,p.legacyBaselineSha256);const next=structuredClone(p);delete next.legacyBaselineSha256;assert.equal(parse(buildApiWebInstalledDescriptor(installed,next,id,path)).PHUB_LEGACY_PREDECESSOR_SHA256,undefined);`,
    );
  });
  it.each([
    ['preflight', 'dump'],
    ['api', 'dump'],
    ['web', 'dump'],
    ['web', 'monitor'],
  ])(
    'can abort or roll back and reconcile after admission proof changes at %s (%s)',
    (failure, proof) => {
      scenario(String.raw`
        const failure=${JSON.stringify(failure)},proof=${JSON.stringify(proof)};let dump=true,monitor=true,lock=true,status='PREPARING';
        const state=structuredClone(b.containers),calls=[];
        const invalidate=()=>{if(proof==='dump')dump=false;else monitor=false;};
        const attest=recovering=>{assert.deepEqual(state.worker,b.containers.worker);assert.deepEqual(state.realtime,b.containers.realtime);if(!recovering&&(!dump||!monitor))throw Error('admission proof changed');};
        const pair=()=>{for(const s of ['api','web'])assert.deepEqual(state[s],b.containers[s]);};
        await assert.rejects(runApiWebTransition({
          journal:async v=>{status=v;},preflight:async()=>{if(failure==='preflight')invalidate();attest(false);},pullAndSmoke:async()=>{},
          activate:async s=>{calls.push('activate-'+s);if(s===failure){invalidate();attest(false);}state[s]={...state[s],releaseId:op.candidateSha+'-101-1'};},
          abort:async()=>{await attestApiWebTerminal('ABORTED',attest);pair();},
          restore:async s=>{calls.push('restore-'+s);state[s]=structuredClone(b.containers[s]);},
          attestRestored:async()=>{await attestApiWebTerminal('ROLLED_BACK',attest);pair();}
        }),/admission proof changed/);
        assert.equal(status,failure==='preflight'?'ABORTED':'ROLLED_BACK');pair();
        if(failure==='preflight')assert.deepEqual(calls,[]);else assert.deepEqual(calls.slice(-2),['restore-web','restore-api']);
        await reconcileApiWebPhase({status},{attestTerminal:async terminal=>{await attestApiWebTerminal(terminal,attest);pair();},journalReconciled:async()=>{status='RECONCILED';},releaseLock:async()=>{lock=false;}});
        assert.equal(status,'RECONCILED');assert.equal(lock,false);
        await assert.rejects(()=>attestApiWebTerminal('SUCCESS',attest),/admission proof changed/);
      `);
    },
  );
  it('reuses only the exact retained predecessor attestation after interrupted preparation', () => {
    scenario(String.raw`
      const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');
      const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phub-cutover-attestation-')),file=path.join(dir,'legacy-predecessor-attestation.json');
      const bytes=Buffer.from(JSON.stringify(b));let writes=0;
      const create=(p,data,exclusive)=>{assert.equal(exclusive,true);writes++;fs.writeFileSync(p,data,{flag:'wx',mode:0o600});};
      try{retainLegacyAttestation(file,bytes,fs.readFileSync,create);const ino=fs.statSync(file).ino;
        // Preparation was interrupted before a plan existed; retry retains the sealed preimage.
        retainLegacyAttestation(file,bytes,fs.readFileSync,create);assert.equal(writes,1);assert.equal(fs.statSync(file).ino,ino);
        fs.writeFileSync(file,'foreign');assert.throws(()=>retainLegacyAttestation(file,bytes,fs.readFileSync,create),/legacy_attestation_drift/);assert.equal(writes,1);
      }finally{fs.rmSync(dir,{recursive:true});}
    `);
  });
  it('uses the retained runtime env for recovery when original lane/build evidence disappears', () => {
    scenario(String.raw`
      const fs=await import('node:fs'),cp=await import('node:child_process'),{syncBuiltinESMExports}=await import('node:module');
      const root='/opt/phub/timeweb-beta',tx=root+'/backups/'+op.candidateSha+'-'+op.publicationRunId+'-1-api-web';
      const bytes=Buffer.from('PHUB_RELEASE_ID='+b.containers.api.releaseId+'\nTIMEWEB_RUNTIME_ENV_ROOT=/etc/phub/timeweb-beta\nTIMEWEB_FCM_CREDENTIAL_SOURCE=/etc/phub/timeweb-beta-fcm/fcm-service-account.json\n'+b.buildRecords.map(v=>v.component.toUpperCase()+'_IMAGE_DIGEST='+v.imageDigest).join('\n')+'\n');b.releaseEnvSha256=hash(bytes);
      const identity=Buffer.from(JSON.stringify({schema:'PHUB_TIMEWEB_SECRET_SET_V1',releaseId:b.secretSetReleaseId}));
      const files=new Map([[tx+'/legacy-release.env',bytes],['/etc/phub/timeweb-beta/.release-identity.json',identity]]);
      for(const name of Object.keys(b.secretHashes)){const path='/etc/phub/timeweb-beta/'+name;if(!files.has(path))files.set(path,Buffer.from('synthetic '+name));b.secretHashes[name]=hash(files.get(path));}
      files.set(tx+'/legacy-predecessor-attestation.json',Buffer.from(JSON.stringify(b)));confirm();
      const stat=p=>({uid:0,gid:0,mode:files.has(p)?0o600:0o700,nlink:1,ino:1,dev:1,size:files.get(p)?.length??0,isSymbolicLink:()=>false,isDirectory:()=>!files.has(p),isFile:()=>files.has(p)});
      fs.default.lstatSync=stat;fs.default.openSync=p=>p;fs.default.fstatSync=stat;fs.default.closeSync=()=>{};fs.default.readFileSync=p=>{if(!files.has(p))throw Error('original evidence missing');return files.get(p);};
      cp.default.execFileSync=()=>{throw Error('must not read Git in recovery');};syncBuiltinESMExports();
      const recovered=readLegacyPredecessor(op,true);assert.equal(recovered.path,tx+'/legacy-release.env');assert.deepEqual(recovered.bytes,bytes);
      assert.throws(()=>readLegacyPredecessor(op),/insecure_path/);
      files.set(tx+'/legacy-release.env',Buffer.from('changed'));assert.throws(()=>readLegacyPredecessor(op,true),/environment_hash/);
    `);
  });
});
