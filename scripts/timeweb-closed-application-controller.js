// Explicit manual entry. Every path, kind and effect is owned by the closed runtime binding.
import { pathToFileURL } from 'node:url';
import {
  runClosedApplicationMigration,
  runManualClosedApplicationPrefetch,
} from './timeweb-closed-application-runtime.js';
import { CLOSED_APPLICATION_STAGE } from './timeweb-closed-application-profile.js';

export async function runClosedApplicationController(args) {
  if (args.length !== 3) throw Error('CLOSED_APPLICATION_ENTRY');
  const [mode, kind, path] = args;
  if (!Object.hasOwn(CLOSED_APPLICATION_STAGE, kind)) throw Error('CLOSED_APPLICATION_ENTRY');
  if (['deploy', 'reconcile'].includes(mode))
    return runClosedApplicationMigration(mode, kind, path);
  const prefetch = {
    prefetch: 'pull',
    'reconcile-prefetch': 'reconcile',
    'attest-prefetch': 'attest',
  };
  if (!Object.hasOwn(prefetch, mode)) throw Error('CLOSED_APPLICATION_ENTRY');
  return runManualClosedApplicationPrefetch(prefetch[mode], kind, path);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(
      JSON.stringify(await runClosedApplicationController(process.argv.slice(2))) + '\n',
    );
  } catch (error) {
    // No subprocess output, environment, SQL, provider response or raw request is disclosed.
    const code = /^(?:CLOSED_APPLICATION_|API_WORKER_MIGRATION_)[A-Z0-9_]+$/.test(
      error?.message ?? '',
    )
      ? error.message
      : 'CLOSED_APPLICATION_UNEXPECTED_FAILURE';
    process.stdout.write(JSON.stringify({ status: 'STOP', code, replayAllowed: false }) + '\n');
    process.exitCode = 1;
  }
}
