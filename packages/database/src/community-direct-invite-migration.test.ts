import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('community direct invite migration', () => {
  it('adds reusable hash-only tenant-isolated invites and replay-safe commands', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0064_community_direct_invites.sql'),
      'utf8',
    );

    expect(sql).toContain('create table if not exists communities.direct_invites');
    expect(sql).toContain("token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$')");
    expect(sql).toContain('token_key_id text not null');
    expect(sql).toContain('unique (tenant_id, token_hash)');
    expect(sql).toContain("state in ('ACTIVE', 'REVOKED', 'EXPIRED')");
    expect(sql).toContain('community_direct_invites_due_expiry_idx');
    expect(sql).not.toContain('use_count');
    expect(sql).not.toMatch(/max_uses|max-use/i);
    expect(sql).not.toMatch(/(^|\W)token\s+(text|bytea)/i);
    expect(sql).not.toMatch(/token_(ciphertext|encrypted)|encrypted_token/i);
    expect(sql).toContain('create table if not exists communities.direct_invite_commands');
    expect(sql).toContain("command_type in ('ISSUE', 'REDEEM', 'REVOKE')");
    expect(sql).toContain('request_hash text not null');
    expect(sql).toContain('result_payload jsonb not null');
    expect(sql).toContain('force row level security');
    expect(sql).not.toMatch(/drop\s+(table|column)|truncate/i);
  });
});
