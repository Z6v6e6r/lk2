import { runR1TailMigration } from './r1-tail-migration.js';
import { R1_TAIL_ARGUMENT } from '../../../scripts/r1-tail-migration-profile.js';
import { runMigrationProcess } from './migration-runner.js';
import { lk2BetaLaneArgument, lk2BetaLaneMode, lk2BetaLanePlanArgument } from './lk2-beta-lane.js';
import {
  notificationMode,
  notificationModeArgument,
  parseNotificationTarget,
} from './notification-migration.js';
import { parseStrictJson } from '../../../scripts/strict-json.js';
import {
  closedSingleMode,
  closedProfileArgument,
  r1ClosedProfileArgument,
  parseClosedSingleTarget,
} from './closed-single-migration.js';

const args = process.argv.slice(2);
if (args.length === 0) await runMigrationProcess({ mode: 'ordinary' });
else if (
  args.length === 1 &&
  (args[0] === lk2BetaLaneArgument || args[0] === lk2BetaLanePlanArgument)
)
  await runMigrationProcess({ mode: lk2BetaLaneMode, dryRun: args[0] === lk2BetaLanePlanArgument });
else if (args.length === 2 && args[0] === R1_TAIL_ARGUMENT) {
  const bytes = Buffer.from(args[1]!, 'base64');
  if (bytes.toString('base64') !== args[1]) throw new Error('R1_TAIL_TARGET_ENCODING');
  try {
    await runR1TailMigration(parseStrictJson(bytes));
  } catch (error) {
    // PostgreSQL constraint details can contain live row identifiers. Emit a closed code only.
    const message = error instanceof Error ? error.message : '';
    process.stderr.write(
      (/^R1_TAIL_[A-Z0-9_]+$/.test(message) ? message : 'R1_TAIL_MIGRATION_FAILED') + '\n',
    );
    process.exitCode = 1;
  }
} else if (args.length === 2 && args[0] === notificationModeArgument) {
  const bytes = Buffer.from(args[1]!, 'base64');
  if (bytes.toString('base64') !== args[1]) throw new Error('MIGRATOR_TARGET_ENCODING');
  await runMigrationProcess({
    mode: notificationMode,
    target: parseNotificationTarget(parseStrictJson(bytes)),
  });
} else if (args.length === 2 && r1ClosedProfileArgument(args[0]!)) {
  const bytes = Buffer.from(args[1]!, 'base64');
  if (bytes.toString('base64') !== args[1]) throw Error('MIGRATOR_TARGET_ENCODING');
  try {
    await runMigrationProcess({
      mode: closedSingleMode,
      profile: r1ClosedProfileArgument(args[0]!)!,
      packageFamily: 'R1_PACKAGE119',
      target: parseClosedSingleTarget(parseStrictJson(bytes)),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    process.stderr.write(
      (/^CLOSED_APPLICATION_[A-Z0-9_]+$/.test(message)
        ? message
        : 'CLOSED_APPLICATION_MIGRATION_FAILED') + '\n',
    );
    process.exitCode = 1;
  }
} else if (args.length === 2 && closedProfileArgument(args[0]!)) {
  const bytes = Buffer.from(args[1]!, 'base64');
  if (bytes.toString('base64') !== args[1]) throw new Error('MIGRATOR_TARGET_ENCODING');
  await runMigrationProcess({
    mode: closedSingleMode,
    profile: closedProfileArgument(args[0]!)!,
    target: parseClosedSingleTarget(parseStrictJson(bytes)),
  });
} else throw new Error('MIGRATOR_ARGUMENTS');
