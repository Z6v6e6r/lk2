import { runMigrationProcess } from './migration-runner.js';
import {
  notificationMode,
  notificationModeArgument,
  parseNotificationTarget,
} from './notification-migration.js';
import { parseStrictJson } from '../../../scripts/strict-json.js';

const args = process.argv.slice(2);
if (args.length === 0) await runMigrationProcess({ mode: 'ordinary' });
else if (args.length === 2 && args[0] === notificationModeArgument) {
  const bytes = Buffer.from(args[1]!, 'base64');
  if (bytes.toString('base64') !== args[1]) throw new Error('MIGRATOR_TARGET_ENCODING');
  await runMigrationProcess({
    mode: notificationMode,
    target: parseNotificationTarget(parseStrictJson(bytes)),
  });
} else throw new Error('MIGRATOR_ARGUMENTS');
