import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('friend request migration', () => {
  it('creates a tenant-isolated pending aggregate with one pending request per direction', async () => {
    const sql = await readFile(
      resolve(process.cwd(), 'packages/database/migrations/0090_profile_friend_requests.sql'),
      'utf8',
    );

    expect(sql).toContain('create table profile.friend_requests');
    expect(sql).toContain('create table profile.friend_request_commands');
    expect(sql).toContain('create table profile.friend_request_responses');
    expect(sql).toContain("state in ('PENDING', 'ACCEPTED', 'DECLINED')");
    expect(sql).toContain('where state = ');
    expect(sql).toContain('force row level security');
    expect(sql).toContain("'profile_friend_requests', 'LOCAL_ONLY'");
    expect(sql).not.toMatch(/viva_id|external_id|subscription_id/i);
    // No friendship row exists before the target answers.
    expect(sql).not.toContain('insert into profile.friendships');
  });
});
