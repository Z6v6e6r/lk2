import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function scenario(body: string) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import {validateApiWebOperation,validateDirectApiWebOperation,validateDirectObservation,observeDirectApiWeb,directOwnerBytes,validateDirectInstalledEvidence,validateControllerDelta,apiWebComposeArgs,runApiWebTransition,recoverApiWebTransition,githubPublic,overlayBytes,validateRuntimeDelta,validateUpgradeReceipt,assertOverlayBytes,recoverApiWebPhase,validateUnchangedImages,writeUpgradeAtomic,reconcileApiWebPhase,normalizeUpgradeHardlink,hashUpgradeDescriptor,INERT_CONTROLLER_BRIDGE,validateControllerBridge,CALLBACK_RUNTIME_BRIDGE,parseRuntimeDelta,validateRuntimeUpgrade} from './scripts/timeweb-api-web-upgrade.js';
    ${body}
  `,
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
}
const operation = {
  schema: 'PHUB_TIMEWEB_API_WEB_OPERATION_V1',
  target: 'lk2.padlhub.su',
  controllerSha: 'c'.repeat(40),
  candidateSha: 'a'.repeat(40),
  candidateTree: 'b'.repeat(40),
  sourceCiRunId: '123',
  publicationRunId: '456',
  artifactId: '789',
  artifactDigest: `sha256:${'d'.repeat(64)}`,
  manifestSha256: 'e'.repeat(64),
  expectedApi: {
    id: 'f'.repeat(64),
    image: `ghcr.io/z6v6e6r/phub-api@sha256:${'1'.repeat(64)}`,
    releaseId: `${'2'.repeat(40)}-111-1`,
  },
  expectedWeb: {
    id: '3'.repeat(64),
    image: `ghcr.io/z6v6e6r/phub-web@sha256:${'4'.repeat(64)}`,
    releaseId: `${'5'.repeat(40)}-222-1`,
  },
  confirmation: 'DEPLOY_API_WEB_AAAAAAAAAAAA_FROM_222222222222_555555555555',
};
const directOperation = {
  schema: 'PHUB_TIMEWEB_API_WEB_OPERATION_V2',
  target: 'lk2.padlhub.su',
  controllerSha: 'c'.repeat(40),
  candidateSha: '0d6078be7a50ed3f5761d66071527be003bd568f',
  candidateTree: '5e50be3cb680e0c9db5faf3fcf3fca57ccdedaa4',
  sourceCiRunId: '37034485776',
  publicationRunId: '37038298584',
  artifactId: '11241473445',
  artifactDigest: 'sha256:64b2cbf7f6613d62f3aa08d6da6c65c6d5ff50ebc88e19c5bcbd2239237913e9',
  manifestSha256: '9d631c9adf4ffce0ab68527bcf99828faa72ee1c51f655bf5325c97f435d042e',
  expectedApi: {
    id: 'a'.repeat(64),
    image:
      'ghcr.io/z6v6e6r/phub-api@sha256:c798c0f881daecca72500d0e3e2d525f77ee4df500c2f662a346b521fa9d1681',
    releaseId: 'c43e9dc8da3eb19a1684ed28e989aafacdb5d8bf-36629104876-1',
  },
  expectedWeb: {
    id: 'b'.repeat(64),
    image:
      'ghcr.io/z6v6e6r/phub-web@sha256:887455ea273abc6138bdb176f4af82295c37d56ac9a7a96b83c006e5f4d72b9e',
    releaseId: 'c43e9dc8da3eb19a1684ed28e989aafacdb5d8bf-36629104876-1',
  },
  evidencePolicy: 'CALLBACK_DIRECT_OBSERVATION_V1',
  expiresAt: '2026-10-06T00:00:00.000Z',
  confirmation:
    'DEPLOY_API_WEB_0D6078BE7A50_FROM_C43E9DC8DA3E_C43E9DC8DA3E_DIRECT_15M_NO_PROVIDER_EVIDENCE',
};

describe('explicit API/Web upgrade boundary', () => {
  it('admits the one bounded direct-observation operation and no V1 fallback', () => {
    scenario(
      `const op=${JSON.stringify(directOperation)}; assert.equal(validateDirectApiWebOperation(op),op); for(const change of [v=>v.candidateSha='a'.repeat(40),v=>v.candidateTree='a'.repeat(40),v=>v.sourceCiRunId='1',v=>v.artifactDigest='sha256:'+'a'.repeat(64),v=>v.expectedApi.image=v.expectedWeb.image,v=>v.expectedWeb.releaseId='a'.repeat(40)+'-1-1',v=>v.evidencePolicy='OTHER',v=>v.confirmation='yes',v=>delete v.expiresAt]){const x=structuredClone(op);change(x);assert.throws(()=>validateApiWebOperation(x));} const v1=${JSON.stringify(operation)};assert.throws(()=>validateDirectApiWebOperation(v1));`,
    );
  });
  it('requires 61 real-shape rounds and threshold-safe direct observation', () => {
    scenario(
      `let now=Date.parse('2026-10-03T00:00:00.000Z'); const evidence=await observeDirectApiWeb({inspectService:()=>{},probeService:async()=>10,attest:async()=>{},now:()=>now,sleep:async ms=>{now+=ms;}});assert.equal(evidence.elapsedSeconds,900);assert.equal(evidence.samples.api.privateMs.length,61);validateDirectObservation(evidence);for(const [name,change] of Object.entries({short:v=>v.elapsedSeconds=1,count:v=>v.samples.api.privateMs.pop(),nan:v=>v.samples.web.publicMs[0]=NaN,p95:v=>v.samples.api.p95PublicMs=1501,tail:v=>v.samples.api.privateMs.splice(57,4,2000,2000,2000,2000),provider:v=>v.providerEvidence='PASS',expiry:v=>v.completedAt='2026-10-07T00:00:00.000Z'})){const x=structuredClone(evidence);change(x);assert.throws(()=>validateDirectObservation(x),name);}`,
    );
  });
  it('keeps V1 provider receipts and V2 owner receipts mutually exclusive', () => {
    scenario(
      `const plan='a'.repeat(64);const base={schema:'PHUB_TIMEWEB_API_WEB_RECEIPT_V2',status:'SUCCESS',planSha256:plan,evidencePolicy:'CALLBACK_DIRECT_OBSERVATION_V1',providerEvidenceStatus:'NOT_COLLECTED_EXPLICIT_OVERRIDE',observedAt:new Date().toISOString(),installedBaselineSha256:'b'.repeat(64),observationSha256:'c'.repeat(64),ownerObservationSha256:'d'.repeat(64),evidencePolicySha256:'e'.repeat(64)};validateUpgradeReceipt(base,plan);for(const change of [v=>v.providerReadbackSha256='f'.repeat(64),v=>delete v.ownerObservationSha256,v=>v.schema='PHUB_TIMEWEB_API_WEB_RECEIPT_V1']){const x=structuredClone(base);change(x);assert.throws(()=>validateUpgradeReceipt(x,plan));}`,
    );
  });
  it('requires exact target, candidate, independent previous identities and confirmation', () => {
    scenario(`const op=${JSON.stringify(operation)}; assert.equal(validateApiWebOperation(op),op);
      for(const change of [v=>v.target='elsewhere',v=>v.controllerSha='main',v=>v.publicationRunId='1;id',v=>v.expectedApi.image='latest',v=>v.expectedWeb.releaseId=v.expectedApi.releaseId,v=>v.confirmation='yes',v=>v.extra=true]) {
        const v=structuredClone(op);change(v);assert.throws(()=>validateApiWebOperation(v));
      }
    `);
  });
  it('allows controller-only ancestry delta and rejects runtime, policy widening and deletions', () => {
    scenario(`validateControllerDelta([{status:'M',path:'scripts/run-timeweb-standard-delivery.js'},{status:'A',path:'scripts/timeweb-api-web-upgrade.js'}]);
      for(const path of ['package-lock.json','apps/web/src/App.tsx','deploy/timeweb/compose.beta.yaml','scripts/timeweb-standard-policy.js','.github/workflows/pull-request.yaml'])
        assert.throws(()=>validateControllerDelta([{status:'M',path}]));
      for(const status of ['D','R100','T'])assert.throws(()=>validateControllerDelta([{status,path:'scripts/timeweb-api-web-upgrade.js'}]));
      assert.throws(()=>validateControllerDelta([]));
    `);
  });
  it('renders all profiles for config and limits mutating stages to exact API/Web', () => {
    scenario(`for(const s of ['api','web']) {
      const args=apiWebComposeArgs('/baseline','/overlay','up',s);
      const prefix=['compose','--env-file','/baseline','--env-file','/overlay','-f','/opt/phub/timeweb-beta/standard/source/deploy/timeweb/compose.beta.yaml'];
      assert.deepEqual(args,[...prefix,'up','-d','--no-deps',s]);
      assert(!args.includes('--profile'));assert(!args.includes('--remove-orphans'));
      const pull=apiWebComposeArgs('/baseline','/overlay','pull',s);
      assert.deepEqual(pull,[...prefix,'pull',s]);assert(!pull.includes('--profile'));
      const config=apiWebComposeArgs('/baseline','/overlay','config',s);
      assert.deepEqual(config,[...prefix,'--profile','*','config','--format','json']);
      assert.equal(config.filter(v=>v==='--profile').length,1);
      assert(!config.includes('up'));assert(!config.includes('pull'));
    }
    for(const s of ['worker','realtime','migrator','caddy'])for(const action of ['config','pull','up'])assert.throws(()=>apiWebComposeArgs('/baseline','/overlay',action,s));
    for(const action of ['down','restart','exec','run','build','create','start','rm'])assert.throws(()=>apiWebComposeArgs('/baseline','/overlay',action,'api'));
    `);
  });
  it('reads public metadata without credentials and stops on unavailable authority', () => {
    scenario(`const calls=[];
      globalThis.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({id:1})};};
      await githubPublic('actions/runs/123');assert.equal(calls.length,1);assert.equal(calls[0].options.headers.Authorization,undefined);assert.equal(calls[0].options.redirect,'error');
      await assert.rejects(()=>githubPublic('actions/workflows/publish/dispatches'));
      for(const status of [401,403,404,429,500]){globalThis.fetch=async()=>({ok:false,status});await assert.rejects(()=>githubPublic('actions/runs/123'));}
    `);
  });
  it('protects runtime definition even when candidate image references are unchanged', () => {
    scenario(`validateRuntimeDelta(['apps/web/src/App.tsx','package-lock.json']);
      for(const path of ['deploy/timeweb/compose.beta.yaml','deploy/timeweb/runtime-environment.contract.json','apps/api/Dockerfile','contracts/openapi/user/v1/openapi.yaml','packages/database/migrations/0097.sql','scripts/produce-timeweb-api-web-observability-evidence.js','scripts/verify-timeweb-api-web-observability.js'])assert.throws(()=>validateRuntimeDelta([path]));
    `);
  });
  it('accepts only the reviewed callback runtime bridge and rejects every changed trust field', () => {
    scenario(`const bridge=CALLBACK_RUNTIME_BRIDGE;
      const identity={previousSha:bridge.previousSha,candidateSha:bridge.candidateSha,candidateTree:bridge.candidateTree};
      const entries=structuredClone(bridge.transitions);
      validateRuntimeUpgrade(identity,entries);
      for(const key of Object.keys(identity))assert.throws(()=>validateRuntimeUpgrade({...identity,[key]:'f'.repeat(40)},entries));
      for(let i=0;i<entries.length;i++)for(const [key,value] of Object.entries({path:'other',status:'D',oldMode:'120000',newMode:'100755',oldOid:'f'.repeat(40),newOid:'f'.repeat(40),oldType:'tree',newType:'commit'})){
        const altered=structuredClone(entries);altered[i][key]=value;
        assert.throws(()=>validateRuntimeUpgrade(identity,altered),i+':'+key);
      }
      for(let i=0;i<entries.length;i++)assert.throws(()=>validateRuntimeUpgrade(identity,entries.filter((_,j)=>i!==j)));
      assert.throws(()=>validateRuntimeUpgrade(identity,[...entries,entries[0]]));
      for(const path of ['packages/database/migrations/0097.sql','contracts/openapi/user/v1/openapi.yaml','apps/api/Dockerfile','deploy/timeweb/compose.beta.yaml','scripts/produce-timeweb-api-web-observability-evidence.js'])
        assert.throws(()=>validateRuntimeUpgrade(identity,[...entries,{path}]),/runtime_definition_changed/);
      validateRuntimeUpgrade(identity,[...entries,{path:'apps/web/nginx.conf'}]);
      // API and Web baselines are validated independently before either can activate.
      for(const changed of ['api','web'])for(const service of ['api','web']){
        if(service===changed)assert.throws(()=>validateRuntimeUpgrade({...identity,previousSha:'f'.repeat(40)},entries));
        else validateRuntimeUpgrade(identity,entries);
      }
      for(const path of ['apps/api/src/app.ts','apps/api/src/main.ts','packages/database/package.json','packages/database/src/contact-reader.ts','contracts/openapi/user/v1/openapi.yaml','tsconfig.json'])
        assert.throws(()=>validateControllerDelta([{status:'M',path}]));
    `);
  });
  it('reads the actual reviewed Git range, including full modes and both blob types', () => {
    scenario(`const {execFileSync}=await import('node:child_process');
      const bridge=CALLBACK_RUNTIME_BRIDGE;
      const git=args=>execFileSync('git',args,{encoding:'utf8'}).trim();
      assert.equal(git(['rev-parse',bridge.candidateSha+'^{tree}']),bridge.candidateTree);
      const raw=git(['diff','--raw','--no-abbrev','--no-renames','-z',bridge.previousSha,bridge.candidateSha]);
      const entries=parseRuntimeDelta(raw).map(v=>({...v,oldType:v.oldOid==='0'.repeat(40)?null:git(['cat-file','-t',v.oldOid]),newType:v.newOid==='0'.repeat(40)?null:git(['cat-file','-t',v.newOid])}));
      validateRuntimeUpgrade(bridge,entries);
      assert.throws(()=>validateRuntimeDelta(entries.map(v=>v.path)),/runtime_definition_changed/);
      const identityPaths=['apps/api/src/app.ts','apps/api/src/main.ts','apps/api/Dockerfile','apps/migrator/Dockerfile','packages/database/package.json','packages/database/src/index.ts'];
      assert.equal(git(['diff','--name-only',bridge.previousSha,bridge.candidateSha,'--',...identityPaths]),'');
      const index=git(['show',bridge.candidateSha+':packages/database/src/index.ts']);
      assert(!index.includes('contact-repository'));
    `);
  });
  it('fails closed on malformed or renamed raw Git transitions', () => {
    scenario(`const header=':100644 100644 '+'a'.repeat(40)+' '+'b'.repeat(40)+' M';
      assert.deepEqual(parseRuntimeDelta(''),[]);
      assert.equal(parseRuntimeDelta(header+'\\0path\\0')[0].path,'path');
      for(const raw of [header+'\\0path',header+'\\0\\0',header+'\\0path\\0extra\\0',header.replace(' M',' R100')+'\\0old\\0new\\0',header.replace('a'.repeat(40),'a'.repeat(7))+'\\0path\\0'])assert.throws(()=>parseRuntimeDelta(raw));
    `);
  });
  it('derives independent previous overlay bytes and detects changed command inputs', () => {
    scenario(`const op=${JSON.stringify(operation)};const plan={candidate:{api:{releaseId:op.candidateSha+'-456-1',image:op.expectedApi.image},web:{releaseId:op.candidateSha+'-456-1',image:op.expectedWeb.image}},previous:{api:op.expectedApi,web:op.expectedWeb}};
      assert.equal(overlayBytes(plan,'previous-api'), 'PHUB_RELEASE_ID='+op.expectedApi.releaseId+'\\nAPI_IMAGE_DIGEST='+op.expectedApi.image.split('@')[1]+'\\n');
      assert.equal(overlayBytes(plan,'previous-web'), 'PHUB_RELEASE_ID='+op.expectedWeb.releaseId+'\\nWEB_IMAGE_DIGEST='+op.expectedWeb.image.split('@')[1]+'\\n');
      assertOverlayBytes(plan,'candidate',Buffer.from(overlayBytes(plan,'candidate')));
      for(const name of ['candidate','previous-api','previous-web']) {const altered=overlayBytes(plan,name).replace('sha256:','sha512:');assert.throws(()=>assertOverlayBytes(plan,name,Buffer.from(altered)));}
      assert.throws(()=>overlayBytes(plan,'worker'));
    `);
  });
  it('rejects unknown/corrupt receipts and binds terminal reconciliation to its prior status', () => {
    scenario(`const hash='a'.repeat(64);const base={schema:'PHUB_TIMEWEB_API_WEB_RECEIPT_V1',status:'PREPARING',planSha256:hash,observedAt:new Date().toISOString()};
      validateUpgradeReceipt(base,hash);
      for(const change of [v=>v.status='UNKNOWN',v=>v.schema='anything',v=>v.planSha256='b'.repeat(64),v=>v.extra=true,v=>v.observedAt='invalid']){const v=structuredClone(base);change(v);assert.throws(()=>validateUpgradeReceipt(v,hash));}
      validateUpgradeReceipt({...base,status:'RECONCILED',reconciledStatus:'ROLLED_BACK'},hash);
      assert.throws(()=>validateUpgradeReceipt({...base,status:'RECONCILED',reconciledStatus:'OBSERVING'},hash));
      validateUpgradeReceipt({...base,status:'SUCCESS',installedBaselineSha256:'c'.repeat(64),observationSha256:'d'.repeat(64),providerReadbackSha256:'e'.repeat(64),alertReadbackSha256:'f'.repeat(64)},hash);
      assert.throws(()=>validateUpgradeReceipt({...base,status:'SUCCESS'},hash));
    `);
  });
  it('refuses tagged or foreign excluded images before recording installed baseline', () => {
    scenario(`validateUnchangedImages({worker:null,realtime:'ghcr.io/z6v6e6r/phub-realtime@sha256:'+'a'.repeat(64)});
      for(const image of ['ghcr.io/z6v6e6r/phub-worker:latest','ghcr.io/other/phub-worker@sha256:'+'a'.repeat(64),'undefined'])assert.throws(()=>validateUnchangedImages({worker:image,realtime:null}));
    `);
  });
  it('leaves automatic eligibility and forced numeric launcher outside manual mode', () => {
    scenario(`const {standardReleasePlan}=await import('./scripts/timeweb-standard-policy.js');
      assert.equal(standardReleasePlan({paths:['apps/web/src/App.tsx','package-lock.json'],presentationVerified:false,safeWebVerified:false,backendUnchanged:false}).eligible,false);
    `);
    const launcher = readFileSync('deploy/timeweb/operator-entry.sh', 'utf8');
    expect(launcher).not.toContain('--critical-api-web');
  });
});

describe('API/Web transaction recovery', () => {
  it.each([
    'preflight',
    'pullAndSmoke',
    'PREPARED',
    'API_INTENT',
    'api',
    'API_ACTIVE',
    'WEB_INTENT',
    'web',
    'OBSERVING',
    'observe',
    'attest',
    'installBaseline',
    'SUCCESS',
  ])('failure at %s never propagates or declares success', (point) => {
    scenario(`const calls=[];let failed=false;const point=${JSON.stringify(point)};
        const call=async name=>{calls.push(name);if(name===point&&!failed){failed=true;throw Error('fixture');}};
        const ops={preflight:()=>call('preflight'),pullAndSmoke:()=>call('pullAndSmoke'),journal:s=>call(s),activate:s=>call(s),observe:()=>call('observe'),attest:()=>call('attest'),restore:s=>call('restore-'+s),abort:()=>call('abort'),installBaseline:()=>call('installBaseline')};
        await assert.rejects(()=>runApiWebTransition(ops));
        assert(failed);assert.notEqual(calls.at(-1),'SUCCESS');
        if(['preflight','pullAndSmoke','PREPARED'].includes(point)){assert(!calls.includes('api'));assert(!calls.includes('restore-api'));assert(calls.includes('ABORTED'));assert(calls.includes('abort'));}
        else {assert(calls.includes('ROLLED_BACK'));assert(calls.indexOf('restore-web')<calls.indexOf('restore-api'));}
      `);
  });
  it('activates API then Web and fsyncs an intent before each action', () => {
    scenario(`const calls=[];const call=async s=>{calls.push(s);};
      await runApiWebTransition({preflight:()=>call('preflight'),pullAndSmoke:()=>call('pull'),journal:call,activate:call,observe:()=>call('observe'),attest:()=>call('attest'),installBaseline:()=>call('installBaseline'),abort:()=>{throw Error('unexpected');},restore:()=>{throw Error('unexpected');}});
      assert.deepEqual(calls,['preflight','pull','PREPARED','API_INTENT','api','API_ACTIVE','WEB_INTENT','web','OBSERVING','observe','attest','installBaseline','SUCCESS']);
    `);
  });
  it.each(['PREPARING', 'PREPARED'])(
    'crash recovery at %s uses readback abort and never restarts services',
    (phase) => {
      scenario(`const calls=[];const status=await recoverApiWebPhase(${JSON.stringify(phase)},{abort:async()=>calls.push('readback'),journal:async status=>calls.push(status),restore:async()=>{throw Error('must not restart');}});
      assert.equal(status,'ABORTED');assert.deepEqual(calls,['readback','ABORTED']);
    `);
    },
  );
  it('crash recovery restores both independent previous services and never activates candidate', () => {
    scenario(`const calls=[];await recoverApiWebTransition({journal:async s=>calls.push(s),restore:async s=>calls.push(s),attest:async()=>calls.push('unchanged')});
      assert.deepEqual(calls,['ROLLBACK_INTENT','web','api','unchanged','ROLLED_BACK']);
    `);
  });
  it('attempts API restoration after a failed Web restore and retains failed state', () => {
    scenario(`const calls=[];await assert.rejects(()=>recoverApiWebTransition({journal:async s=>calls.push(s),restore:async s=>{calls.push(s);if(s==='web')throw Error('fixture');},attest:async()=>calls.push('attest')}));
      assert.deepEqual(calls,['ROLLBACK_INTENT','web','api','ROLLBACK_FAILED']);
    `);
  });
  it('never declares recovery safe when excluded components or secrets drift', () => {
    scenario(`const calls=[];await assert.rejects(()=>recoverApiWebTransition({journal:async s=>calls.push(s),restore:async()=>{},attest:async()=>{throw Error('drift');}}));
      assert.deepEqual(calls,['ROLLBACK_INTENT','ROLLBACK_FAILED']);
    `);
  });
});

describe('durable exclusion and terminal recovery', () => {
  it('admits exactly one concurrent candidate and leaves no loser plan or partial pointer', () => {
    scenario(`
      const {mkdtempSync,readFileSync,existsSync,readdirSync,lstatSync,rmSync}=await import('node:fs');
      const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {spawn}=await import('node:child_process');
      const root=mkdtempSync(join(tmpdir(),'phub-upgrade-lock-'));const lock=join(root,'active');
      try {
        const script="import {writeUpgradeAtomic} from './scripts/timeweb-api-web-upgrade.js';const [lock,plan,name]=process.argv.slice(1);try{writeUpgradeAtomic(lock,name,true);writeUpgradeAtomic(plan,'plan',true);}catch{process.exitCode=23;}";
        const results=await Promise.all(['a','b'].map(name=>new Promise(resolve=>{const child=spawn(process.execPath,['--input-type=module','-e',script,lock,join(root,'plan-'+name),name]);child.on('exit',resolve);})));
        assert.deepEqual(results.sort((a,b)=>a-b),[0,23]);
        const winner=readFileSync(lock,'utf8');assert(['a','b'].includes(winner));
        assert(existsSync(join(root,'plan-'+winner)));assert(!existsSync(join(root,'plan-'+(winner==='a'?'b':'a'))));
        assert.equal(lstatSync(lock).nlink,1);assert.equal(lstatSync(lock).mode&0o777,0o600);
        assert(!readdirSync(root).some(name=>name.includes('.incoming-')));
      } finally {rmSync(root,{recursive:true,force:true});}
    `);
  });
  it.each(['SUCCESS', 'ROLLED_BACK', 'ABORTED'])(
    'reconciles terminal %s after a crash without activation',
    (status) => {
      scenario(`const calls=[];const ops={attestTerminal:async s=>calls.push('attest-'+s),journalReconciled:async s=>calls.push('journal-'+s),releaseLock:async()=>calls.push('unlock')};
      assert.equal(await reconcileApiWebPhase({status:${JSON.stringify(status)}},ops),'RECONCILED');
      assert.deepEqual(calls,['attest-'+${JSON.stringify(status)},'journal-'+${JSON.stringify(status)},'unlock']);
      calls.length=0;await reconcileApiWebPhase({status:'RECONCILED',reconciledStatus:${JSON.stringify(status)}},ops);assert.equal(calls.at(-1),'unlock');
      calls.length=0;await assert.rejects(()=>reconcileApiWebPhase({status:'OBSERVING'},ops));assert.equal(calls.length,0);
    `);
    },
  );
  it('retains the lock when terminal readback or durable reconciliation fails', () => {
    scenario(`for(const point of ['attestTerminal','journalReconciled']) {
      let unlocked=false;const ops={attestTerminal:async()=>{},journalReconciled:async()=>{},releaseLock:async()=>{unlocked=true;}};ops[point]=async()=>{throw Error('fixture');};
      await assert.rejects(()=>reconcileApiWebPhase({status:'SUCCESS'},ops));assert.equal(unlocked,false);
    }`);
  });
});

it('recovers writer hardlink custody after child loss and rejects unrelated twins', () => {
  scenario(`const {mkdtempSync,openSync,writeFileSync,closeSync,linkSync,readFileSync,lstatSync,existsSync,rmSync,chmodSync}=await import('node:fs');const {spawnSync}=await import('node:child_process');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
    const root=mkdtempSync(join(tmpdir(),'phub-hardlink-crash-'));const path=join(root,'active');const twin=path+'.incoming-'+'a'.repeat(24);
    try {
      const script="import {openSync,writeFileSync,fsyncSync,closeSync,linkSync} from 'node:fs';const [path,twin]=process.argv.slice(1);const fd=openSync(twin,'wx',0o600);writeFileSync(fd,'owned-pointer');fsyncSync(fd);closeSync(fd);linkSync(twin,path);process.kill(process.pid,'SIGKILL');";
      const crash=spawnSync(process.execPath,['--input-type=module','-e',script,path,twin]);assert.equal(crash.signal,'SIGKILL');assert.equal(lstatSync(path).nlink,2);
      assert(normalizeUpgradeHardlink(path,process.getuid(),process.getgid()));assert.equal(lstatSync(path).nlink,1);assert(!existsSync(twin));assert.equal(readFileSync(path,'utf8'),'owned-pointer');
      assert.equal(normalizeUpgradeHardlink(path,process.getuid(),process.getgid()),false);
      const other=join(root,'unrelated');linkSync(path,other);assert.throws(()=>normalizeUpgradeHardlink(path,process.getuid(),process.getgid()));
    }finally{rmSync(root,{recursive:true,force:true});}
  `);
});

it('pins nonexecuted bridge additions without admitting runtime or later drift', () => {
  scenario(`const b=INERT_CONTROLLER_BRIDGE;const entries=Object.entries(b.blobs).map(([path,oid])=>({status:'A',mode:'100644',type:'blob',path,oid}));
    validateControllerBridge(b.candidate,b.sha,entries);
    for(const change of [v=>v.status='M',v=>v.status='D',v=>v.status='R100',v=>v.mode='100755',v=>v.mode='120000',v=>v.type='tree',v=>v.oid='0'.repeat(40),v=>v.path='packages/database/migrations/0097.sql']) {
      const altered=structuredClone(entries);change(altered[0]);assert.throws(()=>validateControllerBridge(b.candidate,b.sha,altered));
    }
    assert.throws(()=>validateControllerBridge('a'.repeat(40),b.sha,entries));assert.throws(()=>validateControllerBridge(b.candidate,'b'.repeat(40),entries));
    assert.throws(()=>validateControllerBridge(b.candidate,b.sha,entries.slice(1)));assert.throws(()=>validateControllerBridge(b.candidate,b.sha,[...entries,entries[0]]));
    assert.throws(()=>validateControllerDelta(entries));assert.throws(()=>validateRuntimeDelta(entries.map(v=>v.path)));
  `);
});
it('hashes backups above 1 GiB with bounded memory and rejects invalid size', () => {
  scenario(`const {mkdtempSync,openSync,closeSync,ftruncateSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createHash}=await import('node:crypto');
    const root=mkdtempSync(join(tmpdir(),'phub-backup-hash-'));const fd=openSync(join(root,'backup'),'wx+',0o600);
    try {
      assert.throws(()=>hashUpgradeDescriptor(fd));
      const size=1024**3+1;ftruncateSync(fd,size);assert.throws(()=>hashUpgradeDescriptor(fd,1024**3));
      const expected=createHash('sha256');const block=Buffer.alloc(1024**2);for(let i=0;i<1024;i++)expected.update(block);expected.update(Buffer.alloc(1));
      assert.equal(hashUpgradeDescriptor(fd),expected.digest('hex'));
    }finally{closeSync(fd);rmSync(root,{recursive:true,force:true});}
  `);
});

function directScenario(body: string) {
  scenario(`
    const {createHash}=await import('node:crypto');
    const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
    const bytes=value=>Buffer.from(JSON.stringify(value)+'\\n');
    const op=${JSON.stringify(directOperation)};
    const operationBytes=bytes(op);
    const ownerBytes=directOwnerBytes(op,sha(operationBytes));
    const owner=JSON.parse(ownerBytes);
    let clock=Date.parse('2026-10-03T00:00:00.000Z');
    const probes={inspectService:()=>{},probeService:async()=>10,attest:async()=>{},now:()=>clock,sleep:async ms=>{clock+=ms;}};
    const observation=await observeDirectApiWeb(probes);
    const observationBytes=bytes(observation);
    const releaseId=op.candidateSha+'-'+op.publicationRunId+'-1';
    const images={api:'ghcr.io/z6v6e6r/phub-api@sha256:'+'7'.repeat(64),web:'ghcr.io/z6v6e6r/phub-web@sha256:'+'8'.repeat(64)};
    const plan={schema:'PHUB_TIMEWEB_API_WEB_PLAN_V2',controllerSha:op.controllerSha,operationSha256:sha(operationBytes),evidencePolicy:op.evidencePolicy,evidencePolicySha256:owner.policySha256,ownerObservationSha256:sha(ownerBytes),manifestSha256:op.manifestSha256,artifactDigest:op.artifactDigest,previous:{api:op.expectedApi,web:op.expectedWeb},candidate:{api:{releaseId,image:images.api},web:{releaseId,image:images.web}}};
    const planBytes=bytes(plan);
    const receipt={schema:'PHUB_TIMEWEB_API_WEB_RECEIPT_V2',status:'SUCCESS',planSha256:sha(planBytes),observedAt:observation.completedAt,evidencePolicy:op.evidencePolicy,providerEvidenceStatus:'NOT_COLLECTED_EXPLICIT_OVERRIDE',installedBaselineSha256:'b'.repeat(64),observationSha256:sha(observationBytes),ownerObservationSha256:sha(ownerBytes),evidencePolicySha256:owner.policySha256};
    ${body}
  `);
}

describe('direct observation custody and failure recovery', () => {
  it('binds contextual receipts to persisted plan bytes including the newline', () => {
    directScenario(`validateUpgradeReceipt(receipt,sha(planBytes),op,plan,planBytes);
      assert.throws(()=>validateUpgradeReceipt(receipt,sha(planBytes),op,plan,Buffer.from(JSON.stringify(plan))),/receipt_context/);
      assert.throws(()=>validateUpgradeReceipt(receipt,sha(planBytes),op,{...plan,controllerSha:'f'.repeat(40)},planBytes),/receipt_context/);
      assert.throws(()=>validateUpgradeReceipt(receipt,sha(planBytes),${JSON.stringify(operation)},plan,planBytes),/receipt_context/);
      assert.throws(()=>validateUpgradeReceipt({...receipt,evidencePolicy:'OTHER'},sha(planBytes),op,plan,planBytes));`);
  });
  it('accepts historical evidence after current-time expiry but refuses a new deployment', () => {
    directScenario(`const original=Date.now;Date.now=()=>Date.parse('2026-10-07T00:00:00.000Z');try{
      assert.throws(()=>validateDirectApiWebOperation(op,true));
      validateDirectApiWebOperation(op);
      validateDirectInstalledEvidence(receipt,planBytes,operationBytes,ownerBytes,observationBytes,releaseId,images);
      const late=structuredClone(observation);late.completedAt='2026-10-07T00:00:00.000Z';late.elapsedSeconds=(Date.parse(late.completedAt)-Date.parse(late.startedAt))/1000;
      assert.throws(()=>validateDirectObservation(late));
      const calls=[];await recoverApiWebPhase('OBSERVING',{journal:async s=>calls.push(s),restore:async s=>calls.push(s),attest:async()=>{}});
      assert.deepEqual(calls,['ROLLBACK_INTENT','web','api','ROLLED_BACK']);
    }finally{Date.now=original;}`);
  });
  it('rejects changed exact scope, policy and prior service identities', () => {
    directScenario(`for(const change of [v=>v.controllerSha='main',v=>v.target='other',v=>v.publicationRunId='1',v=>v.artifactId='1',v=>v.manifestSha256='f'.repeat(64),v=>v.expectedApi.releaseId='f'.repeat(40)+'-1-1',v=>v.expectedWeb.image=v.expectedApi.image,v=>v.expiresAt='2026-10-04T00:00:00.000Z',v=>v.expiresAt='2026-10-07T00:00:00.000Z',v=>v.confirmation=v.confirmation.replace('_DIRECT_15M_NO_PROVIDER_EVIDENCE',''),v=>delete v.evidencePolicy]){
      const altered=structuredClone(op);change(altered);assert.throws(()=>validateApiWebOperation(altered));
    }`);
  });
  it.each(['private', 'public', 'identity', 'attest'])(
    'rolls back a %s direct-observation failure',
    (point) => {
      directScenario(`const point=${JSON.stringify(point)};const calls=[];
      const failing={...probes,inspectService:s=>{if(point==='identity')throw Error('restart');},probeService:async(s,publicProbe)=>{if((point==='public'&&publicProbe)||(point==='private'&&!publicProbe))throw Error('readiness');return 10;},attest:async()=>{if(point==='attest')throw Error('owner_drift');}};
      await assert.rejects(()=>runApiWebTransition({preflight:async()=>{},pullAndSmoke:async()=>{},journal:async s=>calls.push(s),activate:async()=>{},observe:()=>observeDirectApiWeb(failing),attest:async()=>{},installBaseline:async()=>{},restore:async s=>calls.push('restore-'+s),abort:async()=>{}}));
      assert(!calls.includes('SUCCESS'));assert(calls.includes('ROLLED_BACK'));assert(calls.indexOf('restore-web')<calls.indexOf('restore-api'));`);
    },
  );
  it('derives latency and timing evidence from raw samples', () => {
    directScenario(`for(const change of [v=>v.samples.api.privateMs[0]=-1,v=>v.elapsedSeconds=NaN,v=>v.samples.api.p95PrivateMs=0,v=>v.samples.api.timestamps[1]=v.samples.api.timestamps[0],v=>v.samples.web.timestamps[0]='2026-09-01T00:00:00.000Z']){const altered=structuredClone(observation);change(altered);assert.throws(()=>validateDirectObservation(altered));}
      const split=structuredClone(observation);split.samples.api.privateMs.splice(0,3,1600,1600,1600);split.samples.api.publicMs.splice(3,3,1600,1600,1600);assert.throws(()=>validateDirectObservation(split));
      await assert.rejects(()=>observeDirectApiWeb({...probes,sleep:async()=>{}}));`);
  });
  it('binds historical operation, plan, owner and component descriptors', () => {
    directScenario(`validateDirectInstalledEvidence(receipt,planBytes,operationBytes,ownerBytes,observationBytes,releaseId,images);
      for(const change of [v=>v.operationSha256='f'.repeat(64),v=>v.ownerObservationSha256='f'.repeat(64),v=>v.controllerSha='f'.repeat(40),v=>v.schema='PHUB_TIMEWEB_API_WEB_PLAN_V1',v=>v.evidencePolicy='OTHER',v=>v.candidate.api.image=images.web,v=>v.candidate.web.releaseId='f'.repeat(40)+'-1-1',v=>v.previous.api.id='f'.repeat(64),v=>v.manifestSha256='f'.repeat(64)]){
        const altered=structuredClone(plan);change(altered);const alteredBytes=bytes(altered);const alteredReceipt={...receipt,planSha256:sha(alteredBytes)};
        assert.throws(()=>validateDirectInstalledEvidence(alteredReceipt,alteredBytes,operationBytes,ownerBytes,observationBytes,releaseId,images));
      }
      assert.throws(()=>validateDirectInstalledEvidence(receipt,planBytes,operationBytes,Buffer.from('tampered'),observationBytes,releaseId,images));
      assert.throws(()=>validateDirectInstalledEvidence(receipt,planBytes,operationBytes,ownerBytes,Buffer.from('tampered'),releaseId,images));
      assert.throws(()=>validateDirectInstalledEvidence(receipt,planBytes,operationBytes,ownerBytes,observationBytes,'f'.repeat(40)+'-1-1',images));`);
  });
});
