import {
  ChatPushFoundationContourError,
  verifyChatPushFoundationContour,
} from './chat-push-foundation-contour.js';

const runtimeConnectionString = process.env.RUNTIME_DATABASE_URL;
const realtimeConnectionString = process.env.REALTIME_DATABASE_URL;
const migratorConnectionString = process.env.MIGRATOR_DATABASE_URL;
const expectedDatabaseName = process.env.CHAT_PUSH_FOUNDATION_EXPECTED_DATABASE_NAME;
const expectedSystemIdentifier = process.env.CHAT_PUSH_FOUNDATION_EXPECTED_SYSTEM_IDENTIFIER;

if (
  !runtimeConnectionString ||
  !realtimeConnectionString ||
  !migratorConnectionString ||
  !expectedDatabaseName ||
  !expectedSystemIdentifier
) {
  process.stderr.write('CHAT_PUSH_FOUNDATION_CONTOUR_ENV_REQUIRED\n');
  process.exitCode = 64;
} else {
  try {
    await verifyChatPushFoundationContour({
      runtimeConnectionString,
      realtimeConnectionString,
      migratorConnectionString,
      expectedDatabaseName,
      expectedSystemIdentifier,
    });
    process.stdout.write(
      `${JSON.stringify({
        result: 'PASS',
        databaseTargetIdentical: true,
        runtimeRealtimeRoleIdentical: true,
        writablePrimary: true,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${
        error instanceof ChatPushFoundationContourError
          ? error.code
          : 'CHAT_PUSH_FOUNDATION_CONTOUR_CHECK_FAILED'
      }\n`,
    );
    process.exitCode = 1;
  }
}
