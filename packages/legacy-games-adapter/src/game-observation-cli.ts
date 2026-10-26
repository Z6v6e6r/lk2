import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { LegacyGamesMongoAdapter } from './index.js';

interface ObservationSelector {
  readonly gameId: string;
  readonly tenantKey: string | null;
  readonly operationId?: string;
}

interface CliIO {
  readonly readUri: () => string | undefined;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

// Fixed internal command, not an authorization check or a general Mongo query runner.
function parseSelector(args: readonly string[]): ObservationSelector {
  const values = new Map<string, string>();
  let nullTenant = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--tenant-null') {
      if (nullTenant) throw new Error('invalid selector');
      nullTenant = true;
      continue;
    }
    if (!['--game-id', '--tenant-key', '--operation-id'].includes(flag) || values.has(flag)) {
      throw new Error('invalid selector');
    }
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error('invalid selector');
    values.set(flag, value);
  }
  const gameId = values.get('--game-id');
  const tenantKey = values.get('--tenant-key');
  const operationId = values.get('--operation-id');
  if (
    !gameId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(gameId) ||
    (nullTenant
      ? tenantKey !== undefined
      : !tenantKey || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(tenantKey)) ||
    (operationId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        operationId,
      ))
  ) {
    throw new Error('invalid selector');
  }
  return {
    gameId,
    tenantKey: nullTenant ? null : tenantKey!,
    ...(operationId === undefined ? {} : { operationId }),
  };
}

/** stdout is private observer evidence; stderr contains only constant error codes. */
export async function runGameObservationCli(
  args: readonly string[],
  io: CliIO = {
    readUri: () => process.env.LEGACY_GAMES_MONGODB_URI,
    stdout: (line) => {
      process.stdout.write(line);
    },
    stderr: (line) => {
      process.stderr.write(line);
    },
  },
): Promise<number> {
  let selector: ObservationSelector;
  try {
    selector = parseSelector(args);
  } catch {
    io.stderr('LEGACY_GAME_OBSERVATION_CLI_SELECTOR_INVALID\n');
    return 2;
  }
  try {
    const uri = io.readUri();
    if (!uri?.trim() || !/^mongodb(?:\+srv)?:\/\//.test(uri)) {
      io.stderr('LEGACY_GAME_OBSERVATION_CLI_CONFIG_UNAVAILABLE\n');
      return 2;
    }
    // readGameObservation owns fixed collections/projection/limits/deadlines and close in finally.
    // No URI/role/source overrides, retry, mapping lookup, credential load or provider call here.
    const observation = await new LegacyGamesMongoAdapter({ uri }).readGameObservation(selector);
    io.stdout(`${JSON.stringify(observation)}\n`);
    return observation.status === 'UNAVAILABLE' || observation.status === 'AMBIGUOUS' ? 1 : 0;
  } catch {
    io.stderr('LEGACY_GAME_OBSERVATION_CLI_UNAVAILABLE\n');
    return 1;
  }
}

// Importing this module for LOCAL tests never runs the command or reads process.env.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runGameObservationCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
