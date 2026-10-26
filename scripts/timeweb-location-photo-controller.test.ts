import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runLocationPhotoManualEntryAdapter } from './timeweb-api-worker-migration.js';

const source = readFileSync('scripts/timeweb-location-photo-controller.js', 'utf8');

describe('location-photo critical entrypoint', () => {
  it('delegates to the existing prefetch and migration controllers only', () => {
    expect(source).toContain('runManualLocationPhotoMigratorPrefetch');
    expect(source).toContain('runManualLocationPhotoMigration');
    expect(source).not.toContain('runManualApiWorkerMigration');
    expect(source).toContain("'reconcile'");
    expect(source).not.toContain('docker');
    expect(source).not.toContain('psql');
    expect(source).not.toContain('child_process');
  });

  it.each([
    'PHUB_TIMEWEB_NOTIFICATION_MIGRATION_OPERATION_V1',
    'PHUB_TIMEWEB_API_WORKER_MIGRATION_OPERATION_V1',
  ])('rejects the wrong %s request before executor acquisition or live effects', async (schema) => {
    const calls: string[] = [];
    await expect(
      runLocationPhotoManualEntryAdapter(
        'deploy',
        '/opt/phub/timeweb-beta/operator/api-worker-migration.json',
        {
          uid: () => 0,
          time: () => Date.now(),
          assertAmbient: () => calls.push('ambient'),
          secureStandard: () => calls.push('secure'),
          readRequest: () => Buffer.from(`${JSON.stringify({ schema })}\n`),
          acquire: () => {
            calls.push('acquire');
            return { close: () => calls.push('close') };
          },
          run: () => {
            calls.push('claim');
            calls.push('bootstrap');
            calls.push('create');
            calls.push('start');
            return Promise.resolve({ status: 'INVALID', receipt: 'INVALID' });
          },
        },
      ),
    ).rejects.toThrow('LOCATION_PHOTO_PROFILE_');
    expect(calls).toEqual(['ambient', 'secure']);
  });
});
