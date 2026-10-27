import { execFileSync } from 'node:child_process';

// Explicit local test opt-in plus the exact Docker task/scope/port binding.
// A normal DATABASE_URL, including a shared environment, is never a test target.
export function ownedClosedSchemaLocalFixtureUrl(
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (environment.CLOSED_SINGLE_MIGRATION_PG_TESTS !== '1') return undefined;
  const raw = environment.CLOSED_SINGLE_MIGRATION_DATABASE_URL;
  if (!raw) throw new Error('CLOSED_SINGLE_TEST_DATABASE_REQUIRED');
  const url = new URL(raw);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.username !== 'phub' ||
    url.pathname !== '/phub' ||
    url.search ||
    url.hash ||
    !/^[1-9][0-9]{3,4}$/.test(url.port) ||
    Number(url.port) > 65535
  )
    throw new Error('CLOSED_SINGLE_TEST_TARGET');
  const id = environment.CLOSED_SINGLE_LOCAL_CONTAINER_ID;
  const task = environment.CLOSED_SINGLE_LOCAL_TASK_ID;
  if (!id || !/^[a-f0-9]{64}$/.test(id) || !task || !/^[a-f0-9-]{36}$/.test(task))
    throw new Error('CLOSED_SINGLE_LOCAL_OWNER');
  const labels = JSON.parse(
    execFileSync('docker', ['inspect', '--format', '{{json .Config.Labels}}', id], {
      encoding: 'utf8',
      timeout: 10000,
    }),
  ) as Record<string, string>;
  if (
    labels['codex.task'] !== task ||
    labels['codex.scope'] !== 'synthetic-migrations-0103-0104' ||
    execFileSync('docker', ['port', id, '5432/tcp'], {
      encoding: 'utf8',
      timeout: 10000,
    }).trim() !== `127.0.0.1:${url.port}`
  )
    throw new Error('CLOSED_SINGLE_LOCAL_BINDING');
  return url.toString();
}
