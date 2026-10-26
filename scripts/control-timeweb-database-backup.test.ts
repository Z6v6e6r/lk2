import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStrictJson } from './strict-json.js';
import { describe, expect, it } from 'vitest';

describe('Timeweb backup/isolated restore preparation', () => {
  it.skipIf(process.platform !== 'linux' || process.env.GITHUB_ACTIONS !== 'true')(
    'rehearses private networking and before/after owned slice stop ACK on the isolated CI host',
    () => {
      const result = spawnSync(
        'sudo',
        ['-n', 'python3', '-I', '-S', '-B', 'scripts/rehearse-timeweb-backup-early-exit.py'],
        { encoding: 'utf8', timeout: 120_000, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
      );
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(parseStrictJson(result.stdout)).toMatchObject({ status: 'PHYSICAL_REHEARSAL_PASS' });
    },
    125_000,
  );

  it.skipIf(process.env.TIMEWEB_STANDARD_DOCKER_VERIFY !== '1')(
    'captures containers without a healthcheck in the real Docker boundary',
    () => {
      const helper = spawnSync(
        'python3',
        [
          '-I',
          '-S',
          '-B',
          '-c',
          "import importlib.util;spec=importlib.util.spec_from_file_location('backup','scripts/control-timeweb-database-backup.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);print(m.INSPECT_FORMAT)",
        ],
        { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
      );
      expect(helper.status, helper.stderr).toBe(0);
      const created = spawnSync(
        'docker',
        [
          'create',
          '--pull',
          'never',
          '--network',
          'none',
          '--entrypoint',
          '/bin/true',
          'redis:7-alpine',
        ],
        { encoding: 'utf8', timeout: 15_000 },
      );
      expect(created.status, created.stderr).toBe(0);
      const id = created.stdout.trim();
      expect(id).toMatch(/^[a-f0-9]{64}$/u);
      try {
        const absent = spawnSync(
          'docker',
          ['inspect', '--format', '{{json (index .State "Health")}}', id],
          { encoding: 'utf8', timeout: 10_000 },
        );
        expect(absent.status, absent.stderr).toBe(0);
        expect(JSON.parse(absent.stdout)).toBeNull();
        const legacy = spawnSync(
          'docker',
          [
            'inspect',
            '--format',
            '{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}',
            id,
          ],
          { encoding: 'utf8', timeout: 10_000 },
        );
        // CLI versions differ on missing map keys; LK2's strict client rejects this legacy lookup.
        if (legacy.status === 0) expect(JSON.parse(legacy.stdout)).toBeNull();
        else expect(legacy.stderr).toContain('Health');
        const inspected = spawnSync('docker', ['inspect', '--format', helper.stdout.trim(), id], {
          encoding: 'utf8',
          timeout: 10_000,
        });
        expect(inspected.status, inspected.stderr).toBe(0);
        const boundary = parseStrictJson<{
          Id: string;
          State: { Status: string; Health: { Status: string | null } };
        }>(inspected.stdout);
        expect(boundary.Id).toBe(id);
        expect(boundary.State.Status).toBe('created');
        expect(boundary.State.Health.Status).toBeNull();
      } finally {
        const removed = spawnSync('docker', ['rm', '--volumes', id], {
          encoding: 'utf8',
          timeout: 15_000,
        });
        expect(removed.status, removed.stderr).toBe(0);
      }
    },
    60_000,
  );
  it.each(['--emit-consumer-fixture', '--emit-disk-pre99-consumer-fixture'])(
    'accepts the Web receipt from %s through its owning validator and rejects drift',
    (fixtureMode) => {
      const directory = mkdtempSync(join(tmpdir(), 'phub-backup-consumer-'));
      try {
        const fixture = spawnSync(
          'python3',
          ['-I', '-S', '-B', 'scripts/test-timeweb-database-backup.py', fixtureMode, directory],
          {
            encoding: 'utf8',
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmpdir() },
          },
        );
        expect(fixture.status, fixture.stderr).toBe(0);
        const { transaction } = parseStrictJson<{ transaction: string }>(fixture.stdout);
        expect(transaction).toMatch(/[a-f0-9]{40}-(?:38060874880|38170498441)-1-web$/u);
        const program = `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import {syncBuiltinESMExports} from 'node:module';
        // Only root custody metadata is simulated. Bytes/digests and the owning validator are real.
        const original=fs.lstatSync;
        fs.lstatSync=(path)=>{const value=original(path);return Object.assign(Object.create(Object.getPrototypeOf(value)),value,{uid:0,gid:0,mode:(value.mode & ~0o777)|(value.isDirectory()?0o700:0o600)});};
        syncBuiltinESMExports();
        const {validateUpgradeBackup}=await import('./scripts/timeweb-api-web-upgrade.js');
        const directory=process.argv[1];
        const path=directory+'/database-backup-receipt.json';
        const bytes=fs.readFileSync(path);
        const receipt=JSON.parse(bytes);
        assert.equal(validateUpgradeBackup(directory,{releaseId:receipt.baselineReleaseId}).path,path);
        const negatives=[['schema','OTHER'],['backupFile',directory+'/other.pgcustom'],['backupSha256','f'.repeat(64)],['completedAt',new Date(Date.now()-3600001).toISOString()],['completedAt',new Date(Date.now()+60000).toISOString()],['restoredLedgerSha256','f'.repeat(64)],['restoreVerified',false]];
        for(const [key,value]of negatives){fs.writeFileSync(path,JSON.stringify({...receipt,[key]:value}));assert.throws(()=>validateUpgradeBackup(directory,{releaseId:receipt.baselineReleaseId}));}
        fs.writeFileSync(path,bytes);
        assert.throws(()=>validateUpgradeBackup(directory,{releaseId:'other'}));
        assert.equal(validateUpgradeBackup(directory,{releaseId:receipt.baselineReleaseId}).path,path);
        // Beta may bind a deterministic degraded marker; production must fail closed without a receipt.
        fs.renameSync(path,path+'.held');
        assert.ok(validateUpgradeBackup(directory,{releaseId:receipt.baselineReleaseId},'beta').path.endsWith('degraded-backup-proof.json'));
        assert.throws(()=>validateUpgradeBackup(directory,{releaseId:receipt.baselineReleaseId},'production'));
        fs.renameSync(path+'.held',path);
        console.log(JSON.stringify({status:'CONSUMER_COMPATIBILITY_PASS',negativeCases:negatives.length+1}));
      `;
        const result = spawnSync(
          process.execPath,
          ['--input-type=module', '-e', program, transaction],
          { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(parseStrictJson(result.stdout)).toEqual({
          status: 'CONSUMER_COMPATIBILITY_PASS',
          negativeCases: 8,
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it.each(['--emit-api-worker-consumer-fixture', '--emit-disk-post101-consumer-fixture'])(
    'accepts the API/Worker receipt from %s through both backup and packaged-ledger validators',
    (fixtureMode) => {
      const directory = mkdtempSync(join(tmpdir(), 'phub-backup-consumer-'));
      try {
        const fixture = spawnSync(
          'python3',
          ['-I', '-S', '-B', 'scripts/test-timeweb-database-backup.py', fixtureMode, directory],
          {
            encoding: 'utf8',
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmpdir() },
          },
        );
        expect(fixture.status, fixture.stderr).toBe(0);
        const { transaction } = parseStrictJson<{ transaction: string }>(fixture.stdout);
        expect(transaction).toMatch(
          /8158ac445c9ff3e4b4bcee95bbd8e10c564b9a8d-39366813227-1-api-worker$/u,
        );
        const program = `
        import assert from 'node:assert/strict';
        import { createHash } from 'node:crypto';
        import fs from 'node:fs';
        import { readFileSync } from 'node:fs';
        import {syncBuiltinESMExports} from 'node:module';
        const original=fs.lstatSync;
        fs.lstatSync=(path)=>{const value=original(path);return Object.assign(Object.create(Object.getPrototypeOf(value)),value,{uid:0,gid:0,mode:(value.mode & ~0o777)|(value.isDirectory()?0o700:0o600)});};
        syncBuiltinESMExports();
        const {validateUpgradeBackup}=await import('./scripts/timeweb-api-web-upgrade.js');
        const {validateApiWorkerBackupLedger}=await import('./scripts/timeweb-api-worker-upgrade.js');
        const transaction=process.argv[1], candidate=process.argv[2], baseline=process.argv[3];
        const receiptPath=transaction+'/database-backup-receipt.json', bytes=fs.readFileSync(receiptPath), receipt=JSON.parse(bytes);
        const hash=(v)=>createHash('sha256').update(v).digest('hex');
        const packaged=JSON.parse(readFileSync('scripts/fixtures/timeweb-api-worker-ledger-8158ac44.json','utf8')).ledger;
        assert.equal(validateUpgradeBackup(transaction,{releaseId:baseline}).path,receiptPath);
        validateApiWorkerBackupLedger(receipt,packaged);
        for(const [key,value] of [['sourceLedgerSha256','f'.repeat(64)],['restoredLedgerSha256','f'.repeat(64)],['restoreImage','postgres:latest']]) {
          fs.writeFileSync(receiptPath,JSON.stringify({...receipt,[key]:value}));
          assert.throws(()=>validateApiWorkerBackupLedger(JSON.parse(fs.readFileSync(receiptPath)),packaged));
        }
        fs.writeFileSync(receiptPath,JSON.stringify({...receipt,backupFile:transaction+'/manual-move.pgcustom'}));
        assert.throws(()=>validateUpgradeBackup(transaction,{releaseId:baseline}));
        fs.writeFileSync(receiptPath,bytes);
        const moved=transaction+'-manual-move'; fs.mkdirSync(moved); fs.copyFileSync(transaction+'/database.pgcustom',moved+'/database.pgcustom'); fs.copyFileSync(receiptPath,moved+'/database-backup-receipt.json');
        assert.throws(()=>validateUpgradeBackup(moved,{releaseId:baseline}));
        assert.equal(receipt.backupFile,transaction+'/database.pgcustom');
        assert.equal(candidate,'8158ac445c9ff3e4b4bcee95bbd8e10c564b9a8d-39366813227-1');
        console.log(JSON.stringify({status:'API_WORKER_CONSUMER_COMPATIBILITY_PASS',negativeCases:5}));
      `;
        const result = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            program,
            transaction,
            '8158ac445c9ff3e4b4bcee95bbd8e10c564b9a8d-39366813227-1',
            '0d6078be7a50ed3f5761d66071527be003bd568f-37038298584-1',
          ],
          { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(parseStrictJson(result.stdout)).toEqual({
          status: 'API_WORKER_CONSUMER_COMPATIBILITY_PASS',
          negativeCases: 5,
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it('runs mock-only custody, isolation, recovery and receipt regression scenarios', () => {
    // This child runs the whole Python suite alongside CI's other integration tests.
    const result = spawnSync(
      'python3',
      ['-I', '-S', '-B', 'scripts/test-timeweb-database-backup.py', '-v'],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeout: 120_000 },
    );
    const diagnostic = JSON.stringify({
      error: result.error?.message,
      signal: result.signal,
      stderr: result.stderr,
    });
    expect(result.error, diagnostic).toBeUndefined();
    expect(result.status, diagnostic).toBe(0);
    expect(result.stderr).toContain('OK');
  }, 125_000);
  it('refuses an unapproved entry before any host mutation', () => {
    const result = spawnSync(
      'python3',
      ['-I', '-S', '-B', 'scripts/control-timeweb-database-backup.py'],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'STOP',
      code: 'ENTRY',
      replayAllowed: false,
    });
  });
  it('refuses optimized Python before any host mutation', () => {
    const result = spawnSync(
      'python3',
      ['-I', '-S', '-B', '-O', 'scripts/control-timeweb-database-backup.py'],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } },
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'STOP',
      code: 'ISOLATED_NONOPTIMIZED_PYTHON_REQUIRED',
    });
  });
});

it.each(['--emit-web8158-fixture', '--emit-web8158-namespace-fixture'])(
  'binds a current API backup from %s to the Web operation and rejects cross-operation proofs',
  (fixtureMode) => {
    const directory = mkdtempSync(join(tmpdir(), 'phub-backup-consumer-'));
    try {
      const fixture = spawnSync(
        'python3',
        ['-I', '-S', '-B', 'scripts/test-timeweb-database-backup.py', fixtureMode, directory],
        { encoding: 'utf8', timeout: 20_000 },
      );
      expect(fixture.status, fixture.stderr).toBe(0);
      const { transaction } = parseStrictJson<{ transaction: string }>(fixture.stdout);
      const code = `
        import assert from 'node:assert/strict';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
        const original=fs.lstatSync;fs.lstatSync=p=>{const v=original(p);return Object.assign(Object.create(Object.getPrototypeOf(v)),v,{uid:0,gid:0,mode:(v.mode&~0o777)|(v.isDirectory()?0o700:0o600)});};syncBuiltinESMExports();
        const {criticalWebBackup,API8158_WEB_SCHEMA}=await import('./scripts/timeweb-critical-web.js');
        const directory=process.argv[1],path=directory+'/database-backup-receipt.json',capsule=directory+'/backup-operation.json';
        const bytes=fs.readFileSync(path),opBytes=fs.readFileSync(capsule),receipt=JSON.parse(bytes),backup=JSON.parse(opBytes),api=backup.expectedApi;
        const op={schema:API8158_WEB_SCHEMA,controllerSha:backup.controllerSha,candidateTree:backup.controllerTree,sourceCiRunId:backup.controllerSourceCiRunId};
        const proof=criticalWebBackup(directory,api,op);assert.equal(proof.path,path);assert.equal(proof.operationPath,capsule);
        for(const change of [{baselineReleaseId:'other'},{sourceLedgerSha256:'f'.repeat(64),restoredLedgerSha256:'f'.repeat(64)},{completedAt:new Date(Date.now()-3600001).toISOString()}]){fs.writeFileSync(path,JSON.stringify({...receipt,...change}));assert.throws(()=>criticalWebBackup(directory,api,op));}fs.writeFileSync(path,bytes);
        for(const change of [v=>v.profile='beta',v=>v.controllerSourceCiRunId='12',v=>v.controllerTree='e'.repeat(40),v=>v.toolCommit='e'.repeat(40),v=>v.expectedApi.id='e'.repeat(64),v=>v.expectedApi.startedAt='changed',v=>v.expectedLedgerSha256='e'.repeat(64)]){const bad=structuredClone(backup);change(bad);fs.writeFileSync(capsule,JSON.stringify(bad));assert.throws(()=>criticalWebBackup(directory,api,op));}fs.writeFileSync(capsule,opBytes);
        fs.renameSync(path,path+'.held');assert.throws(()=>criticalWebBackup(directory,api,op));fs.renameSync(path+'.held',path);
        fs.renameSync(capsule,capsule+'.held');assert.throws(()=>criticalWebBackup(directory,api,op));fs.renameSync(capsule+'.held',capsule);
        const moved=directory+'-copied';fs.mkdirSync(moved);fs.copyFileSync(path,moved+'/database-backup-receipt.json');fs.copyFileSync(directory+'/database.pgcustom',moved+'/database.pgcustom');fs.copyFileSync(capsule,moved+'/backup-operation.json');assert.throws(()=>criticalWebBackup(moved,api,op));
        assert.equal(criticalWebBackup(directory,api,op).operationSha256,proof.operationSha256);
      `;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, transaction], {
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  45_000,
);
