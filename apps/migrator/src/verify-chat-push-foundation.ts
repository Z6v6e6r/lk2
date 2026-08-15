import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Pool } from 'pg';

import { withChatPushFoundationClients } from './chat-push-foundation-clients.js';
import {
  ChatPushFoundationVerificationError,
  type ChatPushFoundationPhase,
  verifyChatPushFoundation,
} from './chat-push-foundation-verifier.js';

const runtimeConnectionString = process.env.RUNTIME_DATABASE_URL;
const migratorConnectionString = process.env.MIGRATOR_DATABASE_URL;
const phase = process.env.CHAT_PUSH_FOUNDATION_PHASE as ChatPushFoundationPhase | undefined;
const approvedTenantKeys = process.env.CHAT_PUSH_FOUNDATION_TENANT_KEYS;
const expectedCatalogDigest = process.env.CHAT_PUSH_FOUNDATION_EXPECTED_CATALOG_DIGEST;
const captureCatalogBaseline = process.env.CHAT_PUSH_FOUNDATION_CAPTURE_CATALOG_BASELINE === 'true';

function createVerifierPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    application_name: 'phub-chat-push-foundation-verifier',
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
  });
}

if (!runtimeConnectionString || !migratorConnectionString || !approvedTenantKeys) {
  process.stderr.write('CHAT_PUSH_FOUNDATION_ENV_REQUIRED\n');
  process.exitCode = 64;
} else if (phase !== 'pre' && phase !== 'drained' && phase !== 'post' && phase !== 'live') {
  process.stderr.write('CHAT_PUSH_FOUNDATION_PHASE_REQUIRED\n');
  process.exitCode = 64;
} else {
  const migrationsDirectory = resolve(process.cwd(), 'migrations');
  const filenames = (await readdir(migrationsDirectory))
    .filter((filename) => filename.endsWith('.sql'))
    .sort();
  const packaged = await Promise.all(
    filenames.map(async (filename) => {
      const sql = await readFile(resolve(migrationsDirectory, filename), 'utf8');
      return {
        filename,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
  const runtimePool = createVerifierPool(runtimeConnectionString);
  const migratorPool = createVerifierPool(migratorConnectionString);
  try {
    const result = await withChatPushFoundationClients({
      runtimePool,
      migratorPool,
      operation: (runtimeClient, migratorClient) =>
        verifyChatPushFoundation({
          runtimeClient,
          migratorClient,
          packaged,
          phase,
          approvedTenantKeys,
          ...(expectedCatalogDigest ? { expectedCatalogDigest } : {}),
          captureCatalogBaseline,
        }),
    });
    process.stdout.write(
      `${JSON.stringify({ result: 'PASS', phase, ...result, semanticRows: 0, endpointRows: 0 })}\n`,
    );
  } catch (error) {
    const code =
      error instanceof ChatPushFoundationVerificationError
        ? error.code
        : error instanceof Error && /^[A-Z0-9_]+(?::[0-9A-Za-z._,-]+)?$/.test(error.message)
          ? error.message
          : 'CHAT_PUSH_FOUNDATION_VERIFICATION_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
