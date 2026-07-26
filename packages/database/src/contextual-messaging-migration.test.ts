import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('contextual messaging projection migration', () => {
  it('deduplicates tenant-scoped projector events under forced RLS', async () => {
    const sql = await readFile(
      resolve(
        process.cwd(),
        'packages/database/migrations/0044_contextual_messaging_projection.sql',
      ),
      'utf8',
    );

    expect(sql).toContain('primary key (tenant_id, projector, event_id)');
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('force row level security');
    expect(sql).toContain('context_projection_events_tenant_isolation');
    expect(sql).not.toMatch(/viva|external_id/i);
  });
});
