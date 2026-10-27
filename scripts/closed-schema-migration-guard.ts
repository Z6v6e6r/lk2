// Populated databases require the separately admitted single-step controllers.
// Empty catalog initialization is still checked by the database foundation gate.
const closedApplicationMigrations = new Set([
  '0103_game_start_notification_scenarios.sql',
  '0104_identity_external_subject_link_commands.sql',
]);

export function assertClosedApplicationMigrationsNotPending(input: {
  applied: readonly { filename: string }[];
  packaged: readonly { filename: string }[];
}): void {
  if (input.applied.length === 0) return;
  const applied = new Set(input.applied.map((row) => row.filename));
  if (
    input.packaged.some(
      (row) => closedApplicationMigrations.has(row.filename) && !applied.has(row.filename),
    )
  )
    throw new Error('CLOSED_APPLICATION_MIGRATION_CONTROLLER_REQUIRED');
}
