import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStrictJson } from './strict-json.js';
import { describe, expect, it } from 'vitest';

describe('Timeweb backup/isolated restore preparation', () => {
  it('accepts an emitted Web-only receipt through the actual owning validator and rejects drift', () => {
    const directory = mkdtempSync(join(tmpdir(), 'phub-backup-consumer-'));
    try {
      const fixture = spawnSync(
        'python3',
        [
          '-I',
          '-S',
          '-B',
          'scripts/test-timeweb-database-backup.py',
          '--emit-consumer-fixture',
          directory,
        ],
        { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmpdir() } },
      );
      expect(fixture.status, fixture.stderr).toBe(0);
      const { transaction } = parseStrictJson<{ transaction: string }>(fixture.stdout);
      expect(transaction).toMatch(/[a-f0-9]{40}-38060874880-1-web$/u);
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
  });
  it('emits an API/Worker receipt accepted by both the current backup and packaged-ledger validators', () => {
    const directory = mkdtempSync(join(tmpdir(), 'phub-backup-consumer-'));
    try {
      const fixture = spawnSync(
        'python3',
        [
          '-I',
          '-S',
          '-B',
          'scripts/test-timeweb-database-backup.py',
          '--emit-api-worker-consumer-fixture',
          directory,
        ],
        { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmpdir() } },
      );
      expect(fixture.status, fixture.stderr).toBe(0);
      const { transaction } = parseStrictJson<{ transaction: string }>(fixture.stdout);
      expect(transaction).toMatch(
        /11954ffd6d7bf7bd9b198e7e68d2123011f091c1-38144582876-1-api-worker$/u,
      );
      const program = `
        import assert from 'node:assert/strict';
        import { createHash } from 'node:crypto';
        import fs from 'node:fs';
        import { readdirSync, readFileSync } from 'node:fs';
        import {syncBuiltinESMExports} from 'node:module';
        const original=fs.lstatSync;
        fs.lstatSync=(path)=>{const value=original(path);return Object.assign(Object.create(Object.getPrototypeOf(value)),value,{uid:0,gid:0,mode:(value.mode & ~0o777)|(value.isDirectory()?0o700:0o600)});};
        syncBuiltinESMExports();
        const {validateUpgradeBackup}=await import('./scripts/timeweb-api-web-upgrade.js');
        const {validateApiWorkerBackupLedger}=await import('./scripts/timeweb-api-worker-upgrade.js');
        const transaction=process.argv[1], candidate=process.argv[2], baseline=process.argv[3];
        const receiptPath=transaction+'/database-backup-receipt.json', bytes=fs.readFileSync(receiptPath), receipt=JSON.parse(bytes);
        const hash=(v)=>createHash('sha256').update(v).digest('hex');
        const packaged=readdirSync('packages/database/migrations').filter(v=>v.endsWith('.sql')).sort().map(filename=>({filename,checksum:hash(readFileSync('packages/database/migrations/'+filename))}));
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
        assert.equal(candidate,'11954ffd6d7bf7bd9b198e7e68d2123011f091c1-38144582876-1');
        console.log(JSON.stringify({status:'API_WORKER_CONSUMER_COMPATIBILITY_PASS',negativeCases:5}));
      `;
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          program,
          transaction,
          '11954ffd6d7bf7bd9b198e7e68d2123011f091c1-38144582876-1',
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
  });

  it('runs mock-only custody, isolation, recovery and receipt regression scenarios', () => {
    const result = spawnSync(
      'python3',
      ['-I', '-S', '-B', 'scripts/test-timeweb-database-backup.py'],
      { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, timeout: 30_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('OK');
  });
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
