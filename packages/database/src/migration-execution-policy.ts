export const CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES = [
  '0069_booking_notification_projection_fence.sql',
  '0070_web_push_endpoint_hardening.sql',
  '0071_messaging_user_blocks.sql',
  '0072_web_push_endpoint_status_validation.sql',
  '0073_booking_reminder_scheduler.sql',
] as const;

export const CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK = 'CHAT_PUSH_FOUNDATION_MAINTENANCE_V1';
export const CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_ACK = 'CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_V1';
export const CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_CATALOG_SQL = `
  select
    not exists (
      select 1
        from pg_catalog.pg_namespace namespace
       where namespace.nspname <> 'public'
         and namespace.nspname <> 'information_schema'
         and namespace.nspname not like 'pg\\_%' escape '\\'
    )
    and not exists (
      select 1
        from pg_catalog.pg_class relation
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
       where namespace.nspname = 'public'
         and relation.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    ) as empty_database_catalog
`;

export function assertMigrationExecutionAllowed(input: {
  readonly appliedFilenames: ReadonlySet<string>;
  readonly packagedFilenames: readonly string[];
  readonly emptyDatabaseCatalogVerified?: boolean;
  readonly maintenanceAcknowledgement?: string;
}): void {
  const pendingFoundation = CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES.filter(
    (filename) => !input.appliedFilenames.has(filename),
  );
  if (pendingFoundation.length === 0) return;
  if (
    input.appliedFilenames.size === 0 &&
    input.emptyDatabaseCatalogVerified === true &&
    input.maintenanceAcknowledgement === CHAT_PUSH_FOUNDATION_EMPTY_DATABASE_ACK
  ) {
    return;
  }
  if (input.maintenanceAcknowledgement === CHAT_PUSH_FOUNDATION_MAINTENANCE_ACK) {
    // The acknowledgement authorizes the gated files inside a maintenance window regardless of how
    // far behind the database is: a contour that skipped several releases has more than the five
    // gated migrations pending, and refusing the whole batch would leave it permanently unable to
    // migrate. The window still applies every pending migration in package order, and the caller
    // reports the full pending set.
    return;
  }
  throw new Error(`CHAT_PUSH_FOUNDATION_MAINTENANCE_REQUIRED:${pendingFoundation.join(',')}`);
}
