import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const migrationPath = fileURLToPath(
  new URL('../migrations/0041_game_result_submission_metadata_projection.sql', import.meta.url),
);

describe('game result submission metadata projection migration', () => {
  it('backfills the submitter and submission time into existing card snapshots', async () => {
    const sql = await readFile(migrationPath, 'utf8');

    expect(sql).toContain('submitted_by_user_id');
    expect(sql).toContain('submitted_at');
    expect(sql).toContain("'{result,submittedByUserId}'");
    expect(sql).toContain("'{result,submittedAt}'");
  });
});
