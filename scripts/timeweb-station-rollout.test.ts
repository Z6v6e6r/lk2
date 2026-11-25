import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  STATION_ALERT_STATUS,
  STATION_ALERT_WAIVER_SHA256,
  STATION_BACKUP,
  STATION_OPERATION,
  STATION_PREVIOUS,
  STATION_WAIVER_SHA256,
  stationScopeHash,
  validateStationBackupMetadata,
  validateStationDatabaseReadback,
  validateStationRetainedAdmission,
  validateStationRuntimeEnvironment,
  validateStationSourceTail,
  validateStationWindow,
} from './timeweb-station-rollout.js';

function operation() {
  const op = {
    schema: STATION_OPERATION,
    profile: 'production',
    target: 'lk2.padlhub.su',
    controllerSha: 'a'.repeat(40),
    candidateSha: 'a'.repeat(40),
    candidateTree: 'b'.repeat(40),
    sourceCiRunId: '123',
    publicationRunId: '456',
    artifactId: '789',
    artifactDigest: `sha256:${'c'.repeat(64)}`,
    manifestSha256: 'd'.repeat(64),
    expectedApi: { ...STATION_PREVIOUS.api },
    expectedWeb: { ...STATION_PREVIOUS.web },
    expectedWorker: { ...STATION_PREVIOUS.worker },
    expiresAt: '2026-11-25T10:30:00.000Z',
    confirmation:
      'DEPLOY_API_WEB_AAAAAAAAAAAA_FROM_43D4BD64E5AE_43D4BD64E5AE_ONE_OFF_STATION_MANUAL_DUMP',
    ownerDecision: {
      schema: 'PHUB_TIMEWEB_STATION_OWNER_DECISION_V2',
      authority: 'ROOT_OPERATOR_ATTESTED_OWNER_MESSAGE_V1',
      decision: STATION_BACKUP.policy,
      waiverMessageSha256: STATION_WAIVER_SHA256,
      waiverReference: `codex-user-message-sha256:${STATION_WAIVER_SHA256}`,
      alertWaiverMessageSha256: STATION_ALERT_WAIVER_SHA256,
      releaseAuthorizationSha256: 'e'.repeat(64),
      receivedAt: '2026-11-25T09:40:00.000Z',
      acceptedSnapshotAgeSeconds: 3600,
      scopeSha256: '',
    },
  };
  op.ownerDecision.scopeSha256 = stationScopeHash(op);
  return op;
}

function run(body: string) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { readFileSync } from 'node:fs';
    import { validateApiWebOperation, validateUpgradeReceipt, buildApiWebInstalledDescriptor,
      runApiWebTransition, apiWebComposeArgs, validateInstalledCutoverKind, validateStationMonitoring, validateUpgradeMonitoring } from './scripts/timeweb-api-web-upgrade.js';
    import { STATION_BACKUP, STATION_KIND, STATION_PLAN, STATION_RECEIPT, STATION_ALERT_STATUS, validateStationObservation } from './scripts/timeweb-station-rollout.js';
    const op = ${JSON.stringify(operation())};
    ${body}
  `,
    ],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
}

describe('Timeweb station one-off rollout', () => {
  it('binds operator scope to the manifest and to the exact three predecessors', () => {
    run(`
      assert.equal(validateApiWebOperation(op), op);
      assert.throws(() => validateApiWebOperation({...op, publicationRunId:'457'}), /owner_scope/);
      assert.throws(() => validateApiWebOperation({...op, expectedWorker:{...op.expectedWorker, revision:'f'.repeat(40)}}), /operation/);
      assert.throws(() => validateApiWebOperation({...op, expectedWeb:{...op.expectedWeb, id:'f'.repeat(64)}}), /operation/);
      assert.throws(() => validateApiWebOperation({...op, controllerSha:'f'.repeat(40)}), /operation/);
      assert.throws(() => validateApiWebOperation({...op, skipMonitoring:true}), /invalid_keys/);
      assert.throws(() => validateApiWebOperation({...op, ownerDecision:{...op.ownerDecision, waiverMessageSha256:'f'.repeat(64)}}), /owner_scope/);
      assert.throws(() => validateApiWebOperation({...op, ownerDecision:{...op.ownerDecision, alertWaiverMessageSha256:'f'.repeat(64)}}), /owner_scope/);
      assert.throws(() => validateApiWebOperation({...op, schema:'PHUB_TIMEWEB_STATION_ROLLOUT_OPERATION_V1'}), /invalid_keys/);
      assert.throws(() => validateApiWebOperation({...op, ownerDecision:{...op.ownerDecision, acceptedSnapshotAgeSeconds:1800}}), /operation/);
    `);
  });

  it('rejects expired, overlong, and too-short execution windows', () => {
    const op = operation();
    expect(() =>
      validateStationWindow(op, Date.parse('2026-11-25T09:50:00Z'), 900_000),
    ).not.toThrow();
    expect(() => validateStationWindow(op, Date.parse('2026-11-25T10:20:00Z'), 900_000)).toThrow(
      'expired',
    );
    expect(() => validateStationWindow(op, Date.parse(op.expiresAt))).toThrow('expired');
    expect(() => validateStationWindow(op, Date.parse('2026-11-25T09:30:00Z'))).toThrow('expired');
    expect(() =>
      validateStationWindow(
        { expiresAt: '2026-11-26T09:34:00Z' },
        Date.parse('2026-11-26T09:00:00Z'),
      ),
    ).toThrow('expired');
  });

  it('requires the reviewed controller-only source tail and its regular blob modes', () => {
    const make = (path: string, status: string) => ({
      path,
      status,
      newMode: '100644',
      newType: 'blob',
      oldMode: status === 'A' ? '000000' : '100644',
      oldType: status === 'A' ? null : 'blob',
    });
    const entries = [
      make('scripts/timeweb-api-web-upgrade.js', 'M'),
      make('scripts/verify-timeweb-api-web-observability.js', 'M'),
      make('scripts/verify-timeweb-api-web-observability.d.ts', 'M'),
      make('scripts/timeweb-station-rollout.js', 'A'),
      make('scripts/timeweb-station-rollout.d.ts', 'A'),
      make('scripts/timeweb-station-rollout.test.ts', 'A'),
      make('docs/runbooks/timeweb-standard-delivery.md', 'M'),
      {
        ...make(
          'deploy/jetson/generated/communities-staging-role-split-trusted-inventory-runtime.mjs',
          'M',
        ),
        oldOid: '955d237156a6a73aa89135b7a57934291b818abb',
        newOid: '8b633b272f8456949222201c4c91ce696e028b2e',
      },
    ];
    expect(() => validateStationSourceTail(entries)).not.toThrow();
    expect(() =>
      validateStationSourceTail([
        ...entries.slice(0, -1),
        { ...entries.at(-1), newOid: 'f'.repeat(40) },
      ]),
    ).toThrow('source_tail');
    expect(() =>
      validateStationSourceTail([...entries, make('deploy/timeweb/compose.beta.yaml', 'M')]),
    ).toThrow('source_tail');
    expect(() => validateStationSourceTail([entries[0], entries[0], ...entries.slice(2)])).toThrow(
      'source_tail',
    );
    expect(() =>
      validateStationSourceTail([{ ...entries[0], newMode: '120000' }, ...entries.slice(1)]),
    ).toThrow('source_tail');
  });

  it('rejects foreign backup evidence and requires exact current 0119 readback', () => {
    const value = { state: 'COMMITTED', catalogSha256: STATION_BACKUP.cupCatalogSha256 };
    expect(() => validateStationDatabaseReadback(value)).not.toThrow();
    for (const state of ['PREIMAGE', 'DRIFT'])
      expect(() => validateStationDatabaseReadback({ ...value, state })).toThrow('database');
    expect(() =>
      validateStationDatabaseReadback({ ...value, catalogSha256: '0'.repeat(64) }),
    ).toThrow('database');
    expect(() =>
      validateStationBackupMetadata(
        Buffer.from('{}'),
        Buffer.from('toc'),
        Buffer.from('{}'),
        Buffer.from('{}'),
      ),
    ).toThrow('backup_metadata');
  });

  it('retains dump admission, a provider hash and the explicit alert decision', () => {
    const op = operation();
    const proof = {
      ...STATION_BACKUP,
      ownerScopeSha256: op.ownerDecision.scopeSha256,
      providerSha256: 'a'.repeat(64),
      alertTestStatus: STATION_ALERT_STATUS,
    };
    expect(() => validateStationRetainedAdmission(proof, op)).not.toThrow();
    expect(() => validateStationRetainedAdmission({ ...proof, restoreVerified: true }, op)).toThrow(
      'retained_admission',
    );
    expect(() =>
      validateStationRetainedAdmission({ ...proof, alertTestStatus: 'PASS' }, op),
    ).toThrow('retained_admission');
  });

  it('rejects environment overrides that image replacement would silently discard', () => {
    const image = ['NODE_ENV=production', 'DEFAULT=initial'];
    const compose = { DEFAULT: 'runtime', AUTOCONFIRM: 'false' };
    const effective = ['AUTOCONFIRM=false', 'DEFAULT=runtime', 'NODE_ENV=production'];
    expect(() => validateStationRuntimeEnvironment(effective, image, compose)).not.toThrow();
    expect(() =>
      validateStationRuntimeEnvironment([...effective, 'EXTRA=unknown'], image, compose),
    ).toThrow('runtime_environment');
    expect(() => validateStationRuntimeEnvironment(effective.slice(1), image, compose)).toThrow(
      'runtime_environment',
    );
  });

  it('links the three-service journal and installed descriptor to the new schema', () => {
    run(
      `
      const plan = {
        schema: STATION_PLAN, controllerSha: op.controllerSha,
        databaseAdmission: {...STATION_BACKUP, ownerScopeSha256: op.ownerDecision.scopeSha256,
          providerSha256: 'a'.repeat(64), alertTestStatus: STATION_ALERT_STATUS},
        previous: {}, unchangedServiceImages: {}, secretSetReleaseId: op.expectedApi.releaseId,
        candidate: Object.fromEntries(['api','worker','web'].map(service => [
          service, {image:'ghcr.io/z6v6e6r/phub-'+service+'@sha256:'+'d'.repeat(64)}
        ]))
      };
      const sha = (value) => createHash('sha256').update(value).digest('hex');
      const planBytes = Buffer.from(JSON.stringify(plan));
      const planHash = sha(planBytes);
      const receipt = {schema: STATION_RECEIPT, status:'WORKER_INTENT', planSha256:planHash,
        observedAt:'2026-11-25T10:00:00Z', databaseAdmissionSha256:sha(JSON.stringify(plan.databaseAdmission)),
        alertTestStatus:STATION_ALERT_STATUS};
      const success = {...receipt,status:'SUCCESS', installedBaselineSha256:'f'.repeat(64),
        observationSha256:'e'.repeat(64), providerReadbackSha256:'d'.repeat(64)};
      assert.equal(validateUpgradeReceipt(success, planHash, op, plan, planBytes), success);
      const reconciled = {...success,status:'RECONCILED',reconciledStatus:'SUCCESS'};
      assert.equal(validateUpgradeReceipt(reconciled, planHash, op, plan, planBytes), reconciled);
      assert.throws(() => validateUpgradeReceipt({...success, alertReadbackSha256:'b'.repeat(64)}, planHash, op, plan, planBytes), /invalid_keys/);
      assert.throws(() => validateUpgradeReceipt({...success, providerReadbackSha256:''}, planHash, op, plan, planBytes), /invalid_receipt/);
      assert.equal(validateUpgradeReceipt(receipt, planHash, op, plan, planBytes), receipt);
      assert.throws(() => validateUpgradeReceipt({...receipt, databaseAdmissionSha256:'a'.repeat(64)}, planHash, op, plan, planBytes), /receipt_context/);
      const id = op.candidateSha+'-456-1';
      const env = buildApiWebInstalledDescriptor({PHUB_RELEASE_ID:op.expectedApi.releaseId}, plan, id, '/backup/receipt');
      assert.match(env.toString(), new RegExp('PHUB_COMPONENT_ROLLOUT_KIND='+STATION_KIND));
      validateInstalledCutoverKind(STATION_KIND, STATION_RECEIPT);
      assert.throws(() => validateInstalledCutoverKind('API_WEB', STATION_RECEIPT), /installed_station_kind/);
    `,
    );
  });

  it('waives delivery proof only for station and continues to reject unsafe monitor evidence', () => {
    run(`
      const contract = JSON.parse(readFileSync('deploy/timeweb/api-web-observability.v1.json','utf8'));
      const observedAt = '2026-11-25T10:00:00.000Z';
      const provider = {
        schema:'PHUB_TIMEWEB_MONITOR_READBACK_V1', source:'timeweb-approved-read-only-readback',
        readAt:'2026-11-25T09:59:30.000Z', projectId:262717,
        monitors:contract.monitoring.monitors.map(({service, ...definition}, index) => ({
          ...definition, enabled:true,
          providerMonitorId:['26ed404e-98e5-45c5-98e3-31b9dfd6f0f2','b25e28a0-02d8-49e4-a0a1-f49f62abc02c'][index],
          regions:['nl-1','ru-1'], intervalSeconds:60, timeoutSeconds:10,
          authorizationHeaderConfigured:true, lastCheckAt:'2026-11-25T09:59:00.000Z',
          successfulConsecutiveRounds:3, activeIncidentCount:0,
        })),
      };
      validateStationMonitoring(provider, contract, observedAt);
      assert.throws(() => validateUpgradeMonitoring(provider, null, contract, observedAt), /producer_alert_readback/);
      assert.throws(() => validateStationMonitoring({...provider, readAt:'2026-11-25T09:59:29.999Z'}, contract, observedAt), /monitoring_stale/);
      assert.throws(() => validateStationMonitoring({...provider, projectId:1}, contract, observedAt), /provider_readback_identity/);
      provider.monitors[0].activeIncidentCount = 1;
      assert.throws(() => validateStationMonitoring(provider, contract, observedAt), /observability_abort_active_incident/);
      provider.monitors[0].activeIncidentCount = 0;
      provider.monitors[0].successfulConsecutiveRounds = 2;
      assert.throws(() => validateStationMonitoring(provider, contract, observedAt), /observability_evidence_monitor_rounds/);
    `);
  });

  it('rejects absent and slow public health samples before recording success', () => {
    run(`
      const privateChecks = (body) => assert.equal(body.elapsedSeconds, 900);
      const steady = { elapsedSeconds:900, publicLatencyMs:{api:Array(61).fill(400),web:Array(61).fill(200)} };
      validateStationObservation(steady, privateChecks);
      assert.throws(() => validateStationObservation({elapsedSeconds:900}, privateChecks), /public_latency/);
      steady.publicLatencyMs.web.fill(1200);
      assert.throws(() => validateStationObservation(steady, privateChecks), /public_latency/);
    `);
  });

  it('rolls back only the three components after a failed observation', () => {
    run(`
      const events=[];
      await assert.rejects(runApiWebTransition({
        workerMode:'legacy-roster-cutover', journal:async(s)=>events.push(s),
        preflight:async()=>{}, pullAndSmoke:async()=>{}, containWorker:async(recovery)=>events.push('stop:'+recovery),
        activate:async(service)=>events.push('up:'+service),
        observe:async()=>{throw new Error('stale-provider');},
        restore:async(service)=>events.push('restore:'+service),
        removeCandidateBaseline:async()=>{}, attestRestored:async()=>{},
      }), /stale-provider/);
      assert.deepEqual(events.filter(s => s.includes(':')),
        ['stop:false','up:api','up:worker','up:web','stop:true','restore:web','restore:api','restore:worker']);
      assert.equal(events.at(-1), 'ROLLED_BACK');
      for (const service of ['api','worker','web']) {
        const args = apiWebComposeArgs('/baseline','/overlay','up',service,true);
        assert.deepEqual(args.slice(-4), ['up','-d','--no-deps',service]);
        assert.equal(args.includes('migrator'),false);
        assert.equal(args.includes('realtime'),false);
      }
    `);
  });
});
