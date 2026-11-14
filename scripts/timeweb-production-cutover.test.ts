import { spawnSync } from 'node:child_process';
import type * as NativeFs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

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
const rosterOperation = String.raw`
  const profile=await import('./scripts/timeweb-production-cutover.js');
  const engine=await import('./scripts/timeweb-api-web-upgrade.js');
  op.schema=profile.ROSTER_CUTOVER_OPERATION;
  op.expectedWorker={id:b.containers.worker.id,image:b.containers.worker.image,releaseId:null};
  const rosterConfirm=()=>{op.confirmation='CUTOVER_PRODUCTION_API_WORKER_WEB_'+op.candidateSha.slice(0,12).toUpperCase()+'_FROM_'+legacyBaselineHash(b).slice(0,12).toUpperCase()+'_KEEP_DATA_AND_ACCOUNTS';};rosterConfirm();
`;
describe('three-service roster cutover inside the existing canonical controller', () => {
  it('binds the Worker preimage and cannot be relabeled as the old API/Web operation', () => {
    scenario(`${rosterOperation}
      assert.equal(validateApiWebOperation(op),op);
      for(const mutation of [v=>delete v.expectedWorker,v=>v.expectedWorker.id='f'.repeat(64),v=>v.expectedWorker.image='ghcr.io/z6v6e6r/phub-worker@sha256:'+'f'.repeat(64),v=>v.expectedWorker.releaseId='release',v=>v.expectedWorker.extra=true,v=>v.schema='PHUB_TIMEWEB_API_WEB_PRODUCTION_CUTOVER_V1',v=>v.confirmation=v.confirmation.replace('API_WORKER_WEB_','')]){const bad=structuredClone(op);mutation(bad);assert.throws(()=>validateApiWebOperation(bad));}
      assert.equal(profile.cutoverPlanSchema(op),profile.ROSTER_CUTOVER_PLAN);
      assert.equal(profile.cutoverReceiptSchema(op),profile.ROSTER_CUTOVER_RECEIPT);`);
  });
  it('renders only explicit Worker stages and smoke checks both immutable entrypoints without network', () => {
    scenario(`${rosterOperation}
      const image='ghcr.io/z6v6e6r/phub-worker@sha256:'+'9'.repeat(64);
      for(const action of ['config','pull','up']){
        assert.throws(()=>engine.apiWebComposeArgs('/baseline','/overlay',action,'worker'));
        const args=engine.apiWebComposeArgs('/baseline','/overlay',action,'worker',true);
        assert.ok(args.includes('--profile'));assert.ok(!args.includes('build'));
        if(action==='up')assert.deepEqual(args.slice(-4),['up','-d','--no-deps','worker']);
      }
      for(const s of ['realtime','migrator'])assert.throws(()=>engine.apiWebComposeArgs('/b','/o','up',s,true));
      assert.throws(()=>engine.apiWebArtifactSmokeArgs('worker',image));
      const smoke=engine.apiWebArtifactSmokeArgs('worker',image,true);assert.ok(smoke.includes('none'));assert.ok(smoke.includes('--read-only'));assert.ok(smoke.at(-1).includes('dist/main.js'));assert.ok(smoke.at(-1).includes('dist/repair-legacy-game-rosters.js'));
      const p={candidate:{api:{image:b.containers.api.image,releaseId:op.candidateSha+'-101-1'},web:{image:b.containers.web.image},worker:{image,releaseId:null,revision:op.candidateSha}},previous:b.containers,secretSetReleaseId:b.secretSetReleaseId,unchangedServiceImages:{realtime:b.containers.realtime.image},legacyBaselineSha256:legacyBaselineHash(b)};
      const candidate=engine.overlayBytes(p,'candidate');assert.ok(candidate.includes('WORKER_IMAGE_DIGEST='+image.split('@')[1]));assert.ok(!candidate.includes('PHUB_WORKER_ENABLED'));
      assert.equal(engine.overlayBytes(p,'previous-worker'),'PHUB_RELEASE_ID='+b.containers.api.releaseId+'\\nWORKER_IMAGE_DIGEST='+b.containers.worker.image.split('@')[1]+'\\n');
      engine.validateUnchangedImages(p.unchangedServiceImages,true);assert.throws(()=>engine.validateUnchangedImages({...p.unchangedServiceImages,worker:image},true));
      const descriptor=buildApiWebInstalledDescriptor({},p,op.candidateSha+'-101-1','/synthetic/rollout-receipt.json').toString();assert.ok(descriptor.includes('PHUB_COMPONENT_ROLLOUT_KIND='+profile.ROSTER_CUTOVER_KIND+'\\n'));assert.ok(descriptor.includes('WORKER_IMAGE_DIGEST='+image.split('@')[1]));`);
  });
  const lifecycle = String.raw`
    const calls=[];let failed=false;
    const call=async label=>{calls.push(label);if(label===failure&&!failed){failed=true;throw Error('injected:'+label);}};
    const ops={workerMode:'legacy-roster-cutover',preflight:()=>call('preflight'),pullAndSmoke:()=>call('pull'),journal:s=>call('journal:'+s),containWorker:()=>call('contain'),activate:s=>call('activate:'+s),observe:()=>call('observe'),attest:()=>call('attest'),installBaseline:()=>call('baseline'),restore:s=>call('restore:'+s),removeCandidateBaseline:()=>call('removeBaseline'),attestRestored:()=>call('restored'),abort:()=>call('abort')};
  `;
  it('journals containment before API, Worker and Web activation and seals all three together', () => {
    scenario(`${rosterOperation}const failure='';${lifecycle}
      await runApiWebTransition(ops);assert.deepEqual(calls,['preflight','pull','journal:PREPARED','journal:WORKER_STOP_INTENT','contain','journal:WORKER_STOPPED','journal:API_INTENT','activate:api','journal:API_ACTIVE','journal:WORKER_INTENT','activate:worker','journal:WORKER_ACTIVE','journal:WEB_INTENT','activate:web','journal:OBSERVING','observe','attest','journal:BASELINE_INTENT','baseline','journal:SUCCESS']);`);
  });
  it('recovers every injected boundary failure and lost acknowledgement in one isolated runtime', () => {
    const failures = [
      'preflight',
      'pull',
      'journal:PREPARED',
      'journal:WORKER_STOP_INTENT',
      'contain',
      'journal:WORKER_STOPPED',
      'journal:API_INTENT',
      'activate:api',
      'journal:API_ACTIVE',
      'journal:WORKER_INTENT',
      'activate:worker',
      'journal:WORKER_ACTIVE',
      'journal:WEB_INTENT',
      'activate:web',
      'journal:OBSERVING',
      'observe',
      'attest',
      'journal:BASELINE_INTENT',
      'baseline',
      'journal:SUCCESS',
    ];
    scenario(`${rosterOperation}for(const failure of ${JSON.stringify(failures)}){${lifecycle}
      await assert.rejects(()=>runApiWebTransition(ops),/injected/);
      if(['preflight','pull','journal:PREPARED'].includes(failure)){assert.ok(calls.includes('abort'));assert.ok(!calls.includes('contain'));assert.equal(calls.at(-1),'journal:ABORTED');}
      else{const index=calls.indexOf('journal:ROLLBACK_INTENT');assert.ok(index>=0,failure);assert.deepEqual(calls.slice(index),['journal:ROLLBACK_INTENT','contain','restore:web','restore:api','restore:worker','removeBaseline','restored','journal:ROLLED_BACK'],failure);}}`);
  });
  it('recovers every durable phase without replaying forward activation', () => {
    const phases = [
      'WORKER_STOP_INTENT',
      'WORKER_STOPPED',
      'API_INTENT',
      'API_ACTIVE',
      'WORKER_INTENT',
      'WORKER_ACTIVE',
      'WEB_INTENT',
      'OBSERVING',
      'BASELINE_INTENT',
      'ROLLBACK_INTENT',
      'ROLLBACK_FAILED',
    ];
    scenario(`${rosterOperation}for(const phase of ${JSON.stringify(phases)}){const failure='';${lifecycle}
      assert.equal(await engine.recoverApiWebPhase(phase,ops),'ROLLED_BACK',phase);assert.deepEqual(calls,['journal:ROLLBACK_INTENT','contain','restore:web','restore:api','restore:worker','removeBaseline','restored','journal:ROLLED_BACK'],phase);
      if(${JSON.stringify(['WORKER_STOP_INTENT', 'WORKER_STOPPED', 'WORKER_INTENT', 'WORKER_ACTIVE', 'BASELINE_INTENT'])}.includes(phase)){delete ops.workerMode;await assert.rejects(()=>engine.recoverApiWebPhase(phase,ops),/invalid_recovery_phase/);}}`);
  });
  it('retains failed rollback for each containment and component restoration failure', () => {
    scenario(`${rosterOperation}for(const failure of ['contain','restore:web','restore:api','restore:worker']){${lifecycle}
      await assert.rejects(()=>engine.recoverApiWebTransition(ops),/rollback_failed/);for(const service of ['web','api','worker'])assert.equal(calls.includes('restore:'+service),failure!=='contain',failure);assert.equal(calls.at(-1),'journal:ROLLBACK_FAILED',failure);assert.ok(!calls.includes('journal:ROLLED_BACK'),failure);}`);
  });
  it('contains only an exact recognized Worker, including a stopped Worker after lost stop ACK', () => {
    scenario(`${rosterOperation}
      const plan={previous:{worker:b.containers.worker},candidate:{worker:{image:'ghcr.io/z6v6e6r/phub-worker@sha256:'+'9'.repeat(64),releaseId:null,revision:op.candidateSha}}};
      const v=b.containers.worker;let state={Id:v.id,Image:v.imageId,Config:{Image:v.image,Labels:{'phub.release-id':null,'org.opencontainers.image.revision':null}},State:{Status:'running',Running:true}};
      const actions=[];const docker=args=>{actions.push(args);if(args[0]==='ps')return v.id;if(args[0]==='inspect')return JSON.stringify([state]);if(args[0]==='image')return JSON.stringify([{Id:v.imageId,RepoDigests:[v.image]}]);if(args[0]==='stop'){state.State={Status:'exited',Running:false};return v.id;}throw Error('unexpected');};
      assert.equal(engine.containRosterCutoverWorker(plan,docker),v.id);assert.equal(actions.filter(a=>a[0]==='stop').length,1);engine.containRosterCutoverWorker(plan,docker);assert.equal(actions.filter(a=>a[0]==='stop').length,1);
      for(const mutate of [s=>s.Config.Image='foreign',s=>s.Config.Labels['org.opencontainers.image.revision']='f'.repeat(40),s=>s.Config.Labels['phub.release-id']='foreign',s=>s.Image='sha256:'+'e'.repeat(64)]){const saved=structuredClone(state);mutate(state);assert.throws(()=>engine.containRosterCutoverWorker(plan,docker));state=saved;}
      assert.throws(()=>engine.containRosterCutoverWorker(plan,args=>args[0]==='ps'?'':docker(args)),/containment_count/);`);
  });
  it('rejects mismatched installed kinds and malformed or short three-service observations', () => {
    scenario(`${rosterOperation}
      engine.validateInstalledCutoverKind('API_WEB','PHUB_TIMEWEB_API_WEB_RECEIPT_V1');
      assert.throws(()=>engine.validateInstalledCutoverKind(profile.ROSTER_CUTOVER_KIND,'PHUB_TIMEWEB_API_WEB_RECEIPT_V1'));
      assert.throws(()=>engine.validateInstalledCutoverKind('API_WEB',profile.ROSTER_CUTOVER_RECEIPT));
      engine.validateInstalledCutoverKind(profile.ROSTER_CUTOVER_KIND,profile.ROSTER_CUTOVER_RECEIPT);
      const value={windowSeconds:900,samplesPerService:61,latencyMs:{api:Array(61).fill(1),worker:Array(61).fill(1),web:Array(61).fill(1)},serverErrors:0,startedAt:'2026-11-13T17:00:00.000Z',completedAt:'2026-11-13T17:15:00.000Z',elapsedSeconds:900};
      profile.validateRosterCutoverObservation(value,'2026-11-13T17:16:00.000Z');
      for(const mutate of [v=>v.latencyMs.worker.pop(),v=>v.latencyMs.worker[0]=-1,v=>v.latencyMs.worker[0]=10001,v=>v.latencyMs.web=Array(61).fill(1001),v=>v.serverErrors=1,v=>v.elapsedSeconds=899,v=>v.extra=true]){const bad=structuredClone(value);mutate(bad);assert.throws(()=>profile.validateRosterCutoverObservation(bad));}
      assert.throws(()=>profile.validateRosterCutoverObservation(value,'2026-11-13T17:14:00.000Z'));`);
  });
});
// The real retained-terminal controller runs against an entirely in-memory root/host fixture.
// Unrelated monitoring parser semantics have their own suites; this fixture tests custody,
// evidence hash binding, all three runtime identities and the actual lock-release path.
it.each(['SUCCESS', 'ROLLED_BACK', 'ABORTED'] as const)(
  'reconciles a real V2 %s controller transaction before releasing its retained lock',
  async (terminal) => {
    const { createHash } = await import('node:crypto');
    const profile = await import('./timeweb-production-cutover.js');
    const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
    const json = (value: unknown) => Buffer.from(JSON.stringify(value));
    const root = '/opt/phub/timeweb-beta',
      source = `${root}/standard/source`,
      runtime = '/etc/phub/timeweb-beta';
    const id = `${operation.candidateSha}-${operation.publicationRunId}-1`,
      tx = `${root}/backups/${id}-api-web`;
    const lockPath = `${root}/standard/active`,
      receiptPath = `${tx}/rollout-receipt.json`;
    const files = new Map<string, Buffer>();
    const put = (path: string, value: string | Buffer) => files.set(path, Buffer.from(value));
    const b = structuredClone(baseline);
    for (const name of Object.keys(b.secretHashes)) {
      const value =
        name === '.release-identity.json'
          ? json({ schema: 'PHUB_TIMEWEB_SECRET_SET_V1', releaseId: b.secretSetReleaseId })
          : Buffer.from('SYNTHETIC=1\n');
      put(`${runtime}/${name}`, value);
      b.secretHashes[name] = hash(value);
    }
    const legacyEnv = Buffer.from(
      `PHUB_RELEASE_ID=${b.containers.api!.releaseId}\nTIMEWEB_RUNTIME_ENV_ROOT=${runtime}\nTIMEWEB_FCM_CREDENTIAL_SOURCE=/etc/phub/timeweb-beta-fcm/fcm-service-account.json\n${b.buildRecords.map((v) => `${v.component.toUpperCase()}_IMAGE_DIGEST=${v.imageDigest}`).join('\n')}\n`,
    );
    b.releaseEnvSha256 = hash(legacyEnv);
    put(`${root}/beta-lane/releases/${b.sourceSha}.env`, legacyEnv);
    const laneCurrent = `${b.sourceSha}\n`,
      laneHistory = `2026-11-12T10:00:00Z ${b.sourceSha}\n`;
    put(`${root}/beta-lane/current`, laneCurrent);
    put(`${root}/beta-lane/history`, laneHistory);
    b.laneCurrentSha256 = hash(laneCurrent);
    b.laneHistorySha256 = hash(laneHistory);
    for (const record of b.buildRecords) {
      const archive = Buffer.from('synthetic legacy build record');
      record.archiveDigest = `sha256:${hash(archive)}`;
      put(`${root}/legacy-baselines/${b.sourceSha}/build-${record.component}.tar.gz`, archive);
    }
    const producer = json({ synthetic: 'sealed producer request' }),
      dump = Buffer.from('complete synthetic dump');
    const op = {
      ...operation,
      schema: profile.ROSTER_CUTOVER_OPERATION,
      legacyBaseline: b,
      expectedWorker: {
        id: b.containers.worker!.id,
        image: b.containers.worker!.image,
        releaseId: null,
      },
      backupOperationSha256: hash(producer),
    };
    op.confirmation = `CUTOVER_PRODUCTION_API_WORKER_WEB_${op.candidateSha.slice(0, 12).toUpperCase()}_FROM_${profile.legacyBaselineHash(b).slice(0, 12).toUpperCase()}_KEEP_DATA_AND_ACCOUNTS`;
    const backup = json({ backupSha256: hash(dump) }),
      provider = json({ readAt: '2026-11-13T17:16:00.000Z', synthetic: 'provider' }),
      alerts = json({ synthetic: 'alerts' });
    const composePath = `${source}/deploy/timeweb/compose.beta.yaml`;
    put(composePath, 'synthetic compose');
    const plan = {
      schema: profile.ROSTER_CUTOVER_PLAN,
      operationSha256: hash(json(op)),
      controllerSha: op.controllerSha,
      manifestSha256: op.manifestSha256,
      artifactDigest: op.artifactDigest,
      composeSha256: hash(files.get(composePath)!),
      legacyBaselineSha256: profile.legacyBaselineHash(b),
      previous: { api: b.containers.api!, web: b.containers.web!, worker: b.containers.worker! },
      candidate: Object.fromEntries(
        ['api', 'worker', 'web'].map((service, n) => [
          service,
          {
            image: `ghcr.io/z6v6e6r/phub-${service}@sha256:${String(n + 6).repeat(64)}`,
            releaseId: service === 'worker' ? null : id,
            ...(service === 'worker' ? { revision: op.candidateSha } : {}),
          },
        ]),
      ),
      excluded: [] as {
        id: string;
        image: string;
        imageId: string;
        restarts: number;
        startedAt: string;
        status: string;
        health: string;
      }[],
      unchangedServiceImages: { realtime: b.containers.realtime!.image },
      secretSetReleaseId: b.secretSetReleaseId,
      baselineSha256: hash(legacyEnv),
      secretHashes: Object.fromEntries(
        ['api.env', 'worker.env', 'realtime.env', 'migrator.env', '.release-identity.json'].map(
          (name) => [name, b.secretHashes[name]],
        ),
      ),
      backup: {
        path: `${tx}/database-backup-receipt.json`,
        sha256: hash(backup),
        receiptPath: `${tx}/database-backup-receipt.json`,
        receiptSha256: hash(backup),
        operationPath: `${tx}/backup-operation.json`,
        operationSha256: hash(producer),
        dumpSha256: hash(dump),
      },
      monitoring: { providerSha256: hash(provider), alertSha256: hash(alerts) },
      createdAt: '2026-11-13T17:00:00.000Z',
    };
    const values = profile.legacyEnvironment(b, legacyEnv, {
      schema: 'PHUB_TIMEWEB_SECRET_SET_V1',
      releaseId: b.secretSetReleaseId,
    });
    const rows = Object.fromEntries(
      ['api', 'worker', 'web', 'realtime'].map((service, n) => {
        const legacy = b.containers[service]!;
        const candidate = plan.candidate[service];
        const selected =
          terminal === 'SUCCESS' && candidate
            ? {
                ...legacy,
                ...candidate,
                id: String(n + 6).repeat(64),
                imageId: `sha256:${String(n + 6).repeat(64)}`,
                revision: op.candidateSha,
              }
            : legacy;
        return [
          service,
          {
            Id: selected.id,
            Image: selected.imageId,
            Config: {
              Image: selected.image,
              Labels: {
                'com.docker.compose.project': 'phub-timeweb-beta',
                'com.docker.compose.service': service,
                'phub.release-id': selected.releaseId,
                'org.opencontainers.image.revision': selected.revision,
              },
            },
            State: {
              Status: 'running',
              Running: true,
              Health: { Status: 'healthy' },
              StartedAt: selected.startedAt,
            },
            RestartCount: 0,
          },
        ];
      }),
    );
    plan.excluded = [
      {
        id: rows.realtime!.Id,
        image: rows.realtime!.Config.Image,
        imageId: rows.realtime!.Image,
        restarts: 0,
        startedAt: rows.realtime!.State.StartedAt,
        status: 'running',
        health: 'healthy',
      },
    ];
    const observation = json({
      windowSeconds: 900,
      samplesPerService: 61,
      latencyMs: { api: Array(61).fill(1), worker: Array(61).fill(1), web: Array(61).fill(1) },
      serverErrors: 0,
      startedAt: '2026-11-13T17:00:00.000Z',
      completedAt: '2026-11-13T17:15:00.000Z',
      elapsedSeconds: 900,
    });
    for (const [path, value] of [
      [`${tx}/operation.json`, json(op)],
      [`${tx}/plan.json`, json(plan)],
      [`${tx}/legacy-predecessor-attestation.json`, json(b)],
      [`${tx}/legacy-release.env`, legacyEnv],
      [`${tx}/backup-operation.json`, producer],
      [`${tx}/database-backup-receipt.json`, backup],
      [`${tx}/database.pgcustom`, dump],
      [`${tx}/timeweb-monitor-readback.json`, provider],
      [`${tx}/alert-test-readback.json`, alerts],
      [`${tx}/observation.json`, observation],
      [`${root}/operator/api-web-upgrade.json`, json(op)],
      [
        '/etc/phub/timeweb-beta-standard-delivery.json',
        json({ schema: 1, enabled: true, controllerSha: op.controllerSha }),
      ],
    ] as [string, Buffer][])
      put(path, value);
    put(`${tx}/backup.complete`, `${hash(json(plan))}\n`);
    put(lockPath, `${tx}/plan.json\n`);
    put(`${root}/observability/timeweb-monitor-readback.json`, provider);
    put(`${root}/observability/alert-test-readback.json`, alerts);
    put(`${source}/deploy/timeweb/api-web-observability.v1.json`, json({ synthetic: 'contract' }));
    const descriptors = new Map<number, string>();
    let nextFd = 100;
    const stat = (path: string) => ({
      uid: 0,
      gid: 0,
      mode: files.has(path)
        ? path === composePath || path.endsWith('api-web-observability.v1.json')
          ? 0o644
          : 0o600
        : 0o700,
      nlink: 1,
      ino: 1,
      dev: 1,
      size: files.get(path)?.length ?? 0,
      isSymbolicLink: () => false,
      isDirectory: () => !files.has(path),
      isFile: () => files.has(path),
    });
    const inspected = new Set<string>();
    const mutations: string[] = [];
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof NativeFs>();
      return {
        ...actual,
        existsSync: (path: string) => files.has(path),
        lstatSync: stat,
        openSync: (path: string, flags: number | string) => {
          if (typeof flags === 'number' && flags & actual.constants.O_CREAT) put(path, '');
          const fd = nextFd++;
          descriptors.set(fd, path);
          return fd;
        },
        fstatSync: (fd: number) => stat(descriptors.get(fd)!),
        readFileSync: (path: string | number | URL, options?: 'utf8') => {
          if (
            typeof path !== 'number' &&
            (typeof path !== 'string' ||
              (!path.startsWith(root + '/') && !path.startsWith('/etc/phub/')))
          )
            return actual.readFileSync(path, options);
          const name = typeof path === 'number' ? descriptors.get(path)! : path;
          const value = files.get(name);
          if (!value) throw Error('unexpected fixture read:' + name);
          return value;
        },
        readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
          files.get(descriptors.get(fd)!)!.copy(buffer, offset, position, position + length),
        closeSync: (fd: number) => descriptors.delete(fd),
        fsyncSync: () => {},
        writeFileSync: (fd: number, value: string | Buffer) => put(descriptors.get(fd)!, value),
        renameSync: (from: string, to: string) => {
          put(to, files.get(from)!);
          files.delete(from);
        },
        linkSync: (from: string, to: string) => put(to, files.get(from)!),
        unlinkSync: (path: string) => {
          if (path === lockPath)
            expect(
              (JSON.parse(files.get(receiptPath)!.toString()) as { status: string }).status,
            ).toBe('RECONCILED');
          files.delete(path);
        },
      };
    });
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<object>()),
      execFileSync: (program: string, args: string[]) => {
        if (program === '/usr/bin/git') {
          if (args.includes('HEAD')) return op.controllerSha + '\n';
          if (args.includes(`${op.candidateSha}^{tree}`)) return op.candidateTree + '\n';
          if (args.includes(`${b.sourceSha}^{tree}`)) return b.sourceTree + '\n';
          if (args.includes('status') || args.includes('ls-files') || args.includes('merge-base'))
            return '';
          throw Error('unexpected fixture git:' + args.join(' '));
        }
        if (program !== '/usr/bin/docker') throw Error('unexpected fixture command');
        if (args[0] === 'ps') {
          const service = args
            .find((v) => v.startsWith('label=com.docker.compose.service='))
            ?.split('=')
            .at(-1);
          return service
            ? (rows[service]?.Id ?? '')
            : Object.values(rows)
                .map((v) => v.Id)
                .join('\n');
        }
        if (args[0] === 'inspect') {
          const entry = Object.entries(rows).find(([, v]) => v.Id === args[1]);
          if (!entry) throw Error('foreign fixture container');
          inspected.add(entry[0]);
          return JSON.stringify([entry[1]]);
        }
        mutations.push(args.join(' '));
        throw Error('unexpected fixture Docker write');
      },
    }));
    vi.doMock('./produce-timeweb-api-web-observability-evidence.js', () => ({
      validateTimewebMonitorReadback: () => ({}),
      validateTimewebAlertReadback: () => ({}),
    }));
    vi.doMock('./verify-timeweb-api-web-observability.js', () => ({
      validateTimewebMonitoringEvidence: () => {},
    }));
    const uid = vi.spyOn(process, 'getuid').mockReturnValue(0);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 200,
      text: () => Promise.resolve('<div id="phub-app"></div>'),
    } as Response);
    try {
      vi.resetModules();
      const controller = await import('./timeweb-api-web-upgrade.js');
      for (const name of ['candidate', 'previous-api', 'previous-worker', 'previous-web'])
        put(`${tx}/${name}.env`, controller.overlayBytes(plan, name));
      const descriptor = controller.buildApiWebInstalledDescriptor(values, plan, id, receiptPath);
      if (terminal === 'SUCCESS')
        put(`${root}/releases/${id}/installed-components.env`, descriptor);
      const receipt = {
        schema: profile.ROSTER_CUTOVER_RECEIPT,
        status: terminal,
        planSha256: hash(json(plan)),
        legacyBaselineSha256: profile.legacyBaselineHash(b),
        observedAt: '2026-11-13T17:16:00.000Z',
        ...(terminal === 'SUCCESS'
          ? {
              installedBaselineSha256: hash(descriptor),
              observationSha256: hash(observation),
              providerReadbackSha256: hash(provider),
              alertReadbackSha256: hash(alerts),
            }
          : {}),
      };
      put(receiptPath, json(receipt));
      if (terminal === 'SUCCESS') {
        // Direct reader negatives avoid readiness retry delays and prove terminal identity gates.
        for (const mutate of [
          (v: NonNullable<typeof rows.worker>) => (v.RestartCount = 1),
          (v: NonNullable<typeof rows.worker>) =>
            (v.Config.Labels['org.opencontainers.image.revision'] = 'e'.repeat(40)),
          (v: NonNullable<typeof rows.worker>) => (v.Config.Labels['phub.release-id'] = id),
          (v: NonNullable<typeof rows.worker>) =>
            (v.Config.Image = 'ghcr.io/z6v6e6r/phub-worker@sha256:' + '0'.repeat(64)),
        ]) {
          const saved = structuredClone(rows.worker!);
          mutate(rows.worker!);
          expect(() => controller.readInstalledApiBaseline(id)).toThrow();
          rows.worker = saved;
          expect(files.get(receiptPath)!.equals(json(receipt))).toBe(true);
          expect(files.has(lockPath)).toBe(true);
        }
        put(
          `${tx}/observation.json`,
          json({
            ...(JSON.parse(observation.toString()) as Record<string, unknown>),
            samplesPerService: 60,
          }),
        );
        expect(() => controller.readInstalledApiBaseline(id)).toThrow();
        put(`${tx}/observation.json`, observation);
      } else {
        const path = `${root}/releases/${id}/installed-components.env`;
        put(path, descriptor);
        await expect(
          controller.runManualApiWebUpgrade('reconcile', `${root}/operator/api-web-upgrade.json`),
        ).rejects.toThrow('non_success_candidate_descriptor');
        expect(files.get(receiptPath)!.equals(json(receipt))).toBe(true);
        expect(files.has(lockPath)).toBe(true);
        files.delete(path);
      }
      const result = await controller.runManualApiWebUpgrade(
        'reconcile',
        `${root}/operator/api-web-upgrade.json`,
      );
      expect(result.status).toBe('RECONCILED');
      expect(files.has(lockPath)).toBe(false);
      const reconciled = JSON.parse(files.get(receiptPath)!.toString()) as Record<string, unknown>;
      const { observedAt, ...preservedReceipt } = receipt;
      expect(reconciled).toMatchObject({
        ...preservedReceipt,
        status: 'RECONCILED',
        reconciledStatus: terminal,
      });
      expect(Date.parse(String(reconciled.observedAt))).toBeGreaterThanOrEqual(
        Date.parse(observedAt),
      );
      expect([...inspected]).toEqual(expect.arrayContaining(['api', 'worker', 'web']));
      expect(mutations).toEqual([]);
    } finally {
      uid.mockRestore();
      fetch.mockRestore();
      for (const name of [
        'node:fs',
        'node:child_process',
        './produce-timeweb-api-web-observability-evidence.js',
        './verify-timeweb-api-web-observability.js',
      ])
        vi.doUnmock(name);
      vi.resetModules();
    }
  },
  30000,
);

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
      String.raw`const pg={...b.containers.api,id:'7'.repeat(64),image:'docker.io/library/postgres@sha256:'+'8'.repeat(64),imageId:'sha256:'+'8'.repeat(64),releaseId:null};const producer={schema:'PHUB_TIMEWEB_BACKUP_ATTESTED_BETA122_API_WEB_V1',profile:'production',candidateSha:op.candidateSha,controllerSha:op.controllerSha,controllerTree:op.candidateTree,toolCommit:op.controllerSha,publicationRunId:op.publicationRunId,releaseId:op.candidateSha+'-'+op.publicationRunId+'-1',expectedApi:b.containers.api,expectedPostgres:pg,predecessorAttestationSha256:legacyBaselineHash(b),expectedDatabaseTarget:b.databaseTarget,expectedLedgerSha256:b.ledgerSha256,toolFileSha256:'a'.repeat(64),controllerConfigSha256:'c'.repeat(64)};const facts={directory:'/opt/phub/timeweb-beta/backups/'+producer.releaseId+'-api-web',postgres:pg,toolFileSha256:producer.toolFileSha256,configSha256:producer.controllerConfigSha256};const original=Buffer.from(JSON.stringify(producer));op.backupOperationSha256=hash(original);validateCutoverBackupOperation(op,original,facts);const disk={...producer,schema:'PHUB_TIMEWEB_BACKUP_ATTESTED_BETA122_DISK_V2'};const diskBytes=Buffer.from(JSON.stringify(disk));op.backupOperationSha256=hash(diskBytes);validateCutoverBackupOperation(op,diskBytes,facts);op.backupOperationSha256=hash(original);for(const change of [v=>v.profile='beta',v=>v.releaseId='other',v=>v.expectedApi.id='f'.repeat(64),v=>v.expectedPostgres.id='e'.repeat(64),v=>v.expectedLedgerSha256='f'.repeat(64),v=>v.predecessorAttestationSha256='f'.repeat(64),v=>v.toolFileSha256='f'.repeat(64)]){const bad=structuredClone(producer);change(bad);const bytes=Buffer.from(JSON.stringify(bad));assert.throws(()=>validateCutoverBackupOperation(op,bytes,facts),/backup_operation_hash/);op.backupOperationSha256=hash(bytes);assert.throws(()=>validateCutoverBackupOperation(op,bytes,facts),/backup_operation/);op.backupOperationSha256=hash(original);}assert.throws(()=>validateCutoverBackupOperation(op,original,{...facts,directory:facts.directory+'-copied'}));`,
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
