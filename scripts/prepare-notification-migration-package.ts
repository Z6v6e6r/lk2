// Offline CLI: consumes a catalog-only diagnostic produced through an authorized read connection.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseStrictJson } from './strict-json.js';
import {
  prepareNotificationMigrationPackage,
  readNotificationMigrationCatalog,
} from './notification-migration-package.js';

if (process.argv.length !== 4 || process.argv[2] !== '--diagnostic') {
  throw new Error(
    'Usage: node --import tsx scripts/prepare-notification-migration-package.ts --diagnostic /absolute/diagnostic.json',
  );
}
const path = process.argv[3]!;
if (!path.startsWith('/')) throw new Error('ABSOLUTE_DIAGNOSTIC_PATH_REQUIRED');
const catalog = await readNotificationMigrationCatalog(resolve('packages/database/migrations'));
const report = prepareNotificationMigrationPackage(catalog, parseStrictJson(await readFile(path)));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.diagnosticChecksPassed) process.exitCode = 2;
