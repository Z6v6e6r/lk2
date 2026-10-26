#!/usr/bin/env node
// Thin entrypoint only. All custody, exclusion locks, capsules and effects stay in the enrolled
// API/Worker migration and prefetch controllers; this file does not implement another runner.
import {
  runManualLocationPhotoMigration,
  runManualLocationPhotoMigratorPrefetch,
} from './timeweb-api-worker-migration.js';

const ROOT = '/opt/phub/timeweb-beta/operator';
const modes = new Map([
  [
    '--critical-location-photo-migrator-prefetch',
    () =>
      runManualLocationPhotoMigratorPrefetch(
        'pull',
        `${ROOT}/location-photo-migrator-prefetch.json`,
      ),
  ],
  [
    '--critical-location-photo-migrator-prefetch-reconcile',
    () =>
      runManualLocationPhotoMigratorPrefetch(
        'reconcile',
        `${ROOT}/location-photo-migrator-prefetch.json`,
      ),
  ],
  [
    '--critical-location-photo-migrate',
    () => runManualLocationPhotoMigration('deploy', `${ROOT}/api-worker-migration.json`),
  ],
  [
    '--critical-location-photo-migrate-reconcile',
    () => runManualLocationPhotoMigration('reconcile', `${ROOT}/api-worker-migration.json`),
  ],
]);

async function main() {
  if (process.argv.length !== 3 || !modes.has(process.argv[2]))
    throw new Error('LOCATION_PHOTO_CONTROLLER_ENTRY');
  const result = await modes.get(process.argv[2])();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'LOCATION_PHOTO_CONTROLLER_ERROR'}\n`,
  );
  process.exitCode = 1;
});
