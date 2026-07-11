import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';

export function createDatabasePool(connectionString: string): Pool {
  const config: PoolConfig = {
    connectionString,
    application_name: 'phub-platform',
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 3_000,
  };
  return new Pool(config);
}

export async function checkDatabaseReady(pool: Pool): Promise<boolean> {
  try {
    const result = await pool.query<{ ready: number }>('select 1 as ready');
    return result.rows[0]?.ready === 1;
  } catch {
    return false;
  }
}

export async function withTenantTransaction<TResult>(
  pool: Pool,
  tenantId: string,
  operation: (client: PoolClient) => Promise<TResult>,
): Promise<TResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function queryOne<TRow extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<TRow | undefined> {
  const result = await client.query<TRow>(text, [...values]);
  return result.rows[0];
}
