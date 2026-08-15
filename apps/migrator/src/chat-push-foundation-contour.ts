import { Client } from 'pg';

interface TargetSnapshot {
  readonly databaseName: string;
  readonly systemIdentifier: string;
  readonly roleName: string;
}

export class ChatPushFoundationContourError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ChatPushFoundationContourError';
  }
}

function fail(code: string): never {
  throw new ChatPushFoundationContourError(code);
}

async function inspectTarget(connectionString: string): Promise<TargetSnapshot> {
  const client = new Client({
    connectionString,
    application_name: 'phub-chat-push-foundation-contour',
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });
  await client.connect();
  try {
    await client.query(`select pg_catalog.set_config('search_path', 'pg_catalog', false)`);
    const row = (
      await client.query<{
        current_role: string;
        session_role: string;
        database_name: string;
        system_identifier: string;
        role_override_active: boolean;
        in_recovery: boolean;
      }>(
        `select current_user as current_role,
                session_user as session_role,
                pg_catalog.current_database() as database_name,
                (
                  select system_identifier::text
                    from pg_catalog.pg_control_system()
                ) as system_identifier,
                pg_catalog.current_setting('role') <> 'none' as role_override_active,
                pg_catalog.pg_is_in_recovery() as in_recovery`,
      )
    ).rows[0];
    if (
      !row ||
      !client.user ||
      client.user !== row.session_role ||
      row.session_role !== row.current_role ||
      row.role_override_active ||
      row.in_recovery
    ) {
      fail('CHAT_PUSH_FOUNDATION_DATABASE_IDENTITY_INVALID');
    }
    return {
      databaseName: row.database_name,
      systemIdentifier: row.system_identifier,
      roleName: row.current_role,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function verifyChatPushFoundationContour(options: {
  readonly runtimeConnectionString: string;
  readonly realtimeConnectionString: string;
  readonly migratorConnectionString: string;
  readonly expectedDatabaseName: string;
  readonly expectedSystemIdentifier: string;
}): Promise<void> {
  const [runtime, realtime, migrator] = await Promise.all([
    inspectTarget(options.runtimeConnectionString),
    inspectTarget(options.realtimeConnectionString),
    inspectTarget(options.migratorConnectionString),
  ]);
  for (const target of [runtime, realtime, migrator]) {
    if (
      target.databaseName !== options.expectedDatabaseName ||
      target.systemIdentifier !== options.expectedSystemIdentifier
    ) {
      fail('CHAT_PUSH_FOUNDATION_DATABASE_TARGET_MISMATCH');
    }
  }
  if (runtime.roleName !== realtime.roleName) {
    fail('CHAT_PUSH_FOUNDATION_REALTIME_ROLE_MISMATCH');
  }
  if (runtime.roleName === migrator.roleName) {
    fail('CHAT_PUSH_FOUNDATION_DATABASE_ROLES_NOT_SPLIT');
  }
}
