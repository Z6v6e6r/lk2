import { resolveCommunitiesStagedRehearsalRequest } from '@phub/database';

import { runMigrationProcess } from './migration-runner.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');

const request = resolveCommunitiesStagedRehearsalRequest({
  ...(process.env.COMMUNITIES_STAGED_REHEARSAL_CONFIRMATION
    ? { confirmation: process.env.COMMUNITIES_STAGED_REHEARSAL_CONFIRMATION }
    : {}),
  ...(process.env.COMMUNITIES_STAGED_REHEARSAL_PHASE
    ? { phase: process.env.COMMUNITIES_STAGED_REHEARSAL_PHASE }
    : {}),
  ...(process.env.PHUB_RESTORE_DATABASE
    ? { restoreDatabase: process.env.PHUB_RESTORE_DATABASE }
    : {}),
  connectionString,
});
if (!request) throw new Error('COMMUNITIES_STAGED_REHEARSAL_CONFIRMATION_REQUIRED');

await runMigrationProcess({ mode: 'communities_staged_rehearsal', request });
