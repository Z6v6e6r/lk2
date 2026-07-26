import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('messaging runtime migration', () => {
  it('keeps all tenant gates off and enforces tenant isolation', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0043_messaging_runtime.sql'),
      'utf8',
    );

    expect(sql).toContain('http_enabled boolean not null default false');
    expect(sql).toContain('direct_enabled boolean not null default false');
    expect(sql).toContain('realtime_enabled boolean not null default false');
    expect(sql).toContain('contextual_enabled boolean not null default false');
    expect(sql.match(/enable row level security/g)).toHaveLength(3);
    expect(sql.match(/force row level security/g)).toHaveLength(3);
    expect(sql).not.toMatch(/viva|external_id/i);
  });
});
