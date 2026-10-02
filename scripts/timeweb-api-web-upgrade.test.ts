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
    import {validateApiWebOperation,validateControllerDelta,apiWebComposeArgs,runApiWebTransition,recoverApiWebTransition,githubPublic,overlayBytes,validateRuntimeDelta,validateUpgradeReceipt,assertOverlayBytes,recoverApiWebPhase,validateUnchangedImages,writeUpgradeAtomic,reconcileApiWebPhase,normalizeUpgradeHardlink,hashUpgradeDescriptor,INERT_CONTROLLER_BRIDGE,validateControllerBridge} from './scripts/timeweb-api-web-upgrade.js';
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

describe('explicit API/Web upgrade boundary', () => {
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
  it('uses only exact API/Web Compose stages with no dependency/profile/ingress action', () => {
    scenario(`for(const s of ['api','web']) {
      const args=apiWebComposeArgs('/baseline','/overlay','up',s);
      assert.deepEqual(args.slice(-4),['up','-d','--no-deps',s]);
      assert(!args.includes('--profile'));assert(!args.includes('--remove-orphans'));
      assert.deepEqual(apiWebComposeArgs('/baseline','/overlay','pull',s).slice(-2),['pull',s]);
    }
    for(const s of ['worker','realtime','migrator','caddy'])assert.throws(()=>apiWebComposeArgs('/baseline','/overlay','up',s));
    for(const action of ['down','restart','exec'])assert.throws(()=>apiWebComposeArgs('/baseline','/overlay',action,'api'));
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
