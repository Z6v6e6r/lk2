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
