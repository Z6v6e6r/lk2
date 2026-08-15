import type { PoolClient } from 'pg';

interface VerifierPool {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

export async function withChatPushFoundationClients<TResult>(options: {
  readonly runtimePool: VerifierPool;
  readonly migratorPool: VerifierPool;
  readonly operation: (runtimeClient: PoolClient, migratorClient: PoolClient) => Promise<TResult>;
}): Promise<TResult> {
  let runtimeClient: PoolClient | undefined;
  let migratorClient: PoolClient | undefined;
  let operationResult: TResult | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    runtimeClient = await options.runtimePool.connect();
    migratorClient = await options.migratorPool.connect();
    operationResult = await options.operation(runtimeClient, migratorClient);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  for (const client of [runtimeClient, migratorClient]) {
    try {
      client?.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  const poolResults = await Promise.allSettled([
    options.runtimePool.end(),
    options.migratorPool.end(),
  ]);
  for (const result of poolResults) {
    if (result.status === 'rejected') cleanupErrors.push(result.reason);
  }
  if (operationFailed) throw operationError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'CHAT_PUSH_FOUNDATION_DATABASE_CLEANUP_FAILED');
  }
  return operationResult as TResult;
}
