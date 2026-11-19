// Populated databases require the separately admitted single-step controllers.
// Empty catalog initialization is still checked by the database foundation gate.
const closedApplicationMigrations = new Set([
  '0103_game_start_notification_scenarios.sql',
  '0104_identity_external_subject_link_commands.sql',
]);

const cupLevelProjection0119 = '0119_cup_calculated_player_levels.sql';

type MigrationInventory = {
  applied: readonly { filename: string }[];
  packaged: readonly { filename: string }[];
};

// The retired beta lane names the database that now holds production data.
export function assertCupLevelProjection0119NotPending(
  input: MigrationInventory & { emptyDatabaseCatalogVerified?: boolean },
): void {
  if (
    input.packaged.some((row) => row.filename === cupLevelProjection0119) &&
    !input.applied.some((row) => row.filename === cupLevelProjection0119) &&
    !(input.applied.length === 0 && input.emptyDatabaseCatalogVerified === true)
  ) {
    throw new Error('CUP_LEVEL_PROJECTION_0119_ADMISSION_REQUIRED');
  }
}

export function assertClosedApplicationMigrationsNotPending(input: MigrationInventory): void {
  if (input.applied.length === 0) return;
  const applied = new Set(input.applied.map((row) => row.filename));
  if (
    input.packaged.some(
      (row) => closedApplicationMigrations.has(row.filename) && !applied.has(row.filename),
    )
  )
    throw new Error('CLOSED_APPLICATION_MIGRATION_CONTROLLER_REQUIRED');
}
