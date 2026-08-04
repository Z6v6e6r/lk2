import { describe, expect, it, vi } from 'vitest';

import { createCommunityContentModerationRepository } from './community-content-moderation-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const communityId = '11111111-1111-4111-8111-111111111111';
const postId = '22222222-2222-4222-8222-222222222222';
const authorUserId = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-08-04T13:00:00.000Z');

const base = {
  tenantId,
  actorUserId,
  communityId,
  postId,
  expectedRevision: 1,
  idempotencyKey: 'moderation-command-0001',
  requestHash: 'a'.repeat(64),
  correlationId: 'moderation-command-correlation',
} as const;

function postRow(overrides: Record<string, unknown> = {}) {
  return {
    id: postId,
    community_id: communityId,
    author_user_id: authorUserId,
    status: 'PENDING_MODERATION',
    body: 'Пост на проверку',
    revision: 1,
    created_at: now,
    published_at: null,
    updated_at: now,
    archived_at: null,
    restore_until: null,
    retention_until: null,
    ...overrides,
  };
}

function withQueries(handler: (text: string, values: readonly unknown[]) => readonly unknown[]) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (
      text === 'begin' ||
      text === 'commit' ||
      text === 'rollback' ||
      text.includes("set_config('app.tenant_id'")
    ) {
      return Promise.resolve({ rows: [] });
    }
    if (text.includes('insert into community_content.event_heads')) {
      return Promise.resolve({ rows: [{ last_sequence: 9 }] });
    }
    return Promise.resolve({ rows: handler(text, values) });
  });
  return {
    repository: createCommunityContentModerationRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as never),
    query,
  };
}

describe('community content moderation repository', () => {
  it('approves pending content with revision, evidence, durable sequence and outbox atomically', async () => {
    const { repository, query } = withQueries((text) => {
      if (text.includes("current_user.status = 'ACTIVE'"))
        return [{ active: true, authorized: true }];
      if (text.includes('select id from communities.communities')) return [{ id: communityId }];
      if (text.includes('from community_content.moderation_commands')) return [];
      if (text.includes('from community_content.posts') && text.includes('for update'))
        return [postRow()];
      if (text.includes('update community_content.posts')) {
        return [postRow({ status: 'PUBLISHED', revision: 2, published_at: now })];
      }
      return [];
    });
    await expect(repository.approvePost(base)).resolves.toMatchObject({
      outcome: 'approved',
      post: { status: 'PUBLISHED', revision: 2 },
      replayed: false,
    });
    for (const fragment of [
      'insert into community_content.post_revisions',
      'insert into community_content.events',
      'insert into community_content.moderation_commands',
      'insert into community_content.moderation_actions',
      'insert into audit.audit_log',
      'insert into audit.outbox_events',
    ]) {
      expect(query.mock.calls.some(([text]) => String(text).includes(fragment))).toBe(true);
    }
    const outbox = query.mock.calls.find(([text]) =>
      String(text).includes('insert into audit.outbox_events'),
    );
    expect(String(outbox?.[1]?.[4])).toContain('"sequence":9');
    expect(String(outbox?.[1]?.[4])).not.toContain('Пост на проверку');
    expect(query).toHaveBeenCalledWith('commit');
  });

  it('rejects pending content into HIDDEN while retaining body and structured evidence', async () => {
    const { repository, query } = withQueries((text) => {
      if (text.includes("current_user.status = 'ACTIVE'"))
        return [{ active: true, authorized: true }];
      if (text.includes('select id from communities.communities')) return [{ id: communityId }];
      if (text.includes('from community_content.moderation_commands')) return [];
      if (text.includes('from community_content.posts') && text.includes('for update'))
        return [postRow()];
      if (text.includes('update community_content.posts')) {
        return [postRow({ status: 'HIDDEN', revision: 2 })];
      }
      return [];
    });
    await expect(
      repository.rejectPost({ ...base, reasonCode: 'CONTENT_POLICY_VIOLATION' }),
    ).resolves.toMatchObject({
      outcome: 'rejected',
      post: { status: 'HIDDEN', body: 'Пост на проверку', revision: 2 },
      replayed: false,
    });
    const evidence = query.mock.calls.find(([text]) =>
      String(text).includes('insert into community_content.moderation_actions'),
    );
    expect(evidence?.[1]).toEqual(
      expect.arrayContaining([
        'REJECT',
        'PENDING_MODERATION',
        'HIDDEN',
        'CONTENT_POLICY_VIOLATION',
      ]),
    );
    const outbox = query.mock.calls.find(([text]) =>
      String(text).includes('insert into audit.outbox_events'),
    );
    expect(String(outbox?.[1]?.[1])).toBe('community.post.moderation_rejected.v1');
    expect(String(outbox?.[1]?.[4])).not.toContain('Пост на проверку');
  });

  it('requires the dedicated decide permission before reading replay state', async () => {
    const { repository, query } = withQueries((text) => {
      if (text.includes("current_user.status = 'ACTIVE'"))
        return [{ active: true, authorized: false }];
      return [];
    });
    await expect(repository.approvePost(base)).resolves.toEqual({ outcome: 'permission_denied' });
    expect(query.mock.calls.some(([text]) => String(text).includes('moderation_commands'))).toBe(
      false,
    );
  });

  it('lists only pending posts through an oldest-first keyset queue', async () => {
    const { repository, query } = withQueries((text) => {
      if (text.includes("current_user.status = 'ACTIVE'"))
        return [{ active: true, authorized: true }];
      if (
        text.includes('from community_content.posts') &&
        text.includes("status = 'PENDING_MODERATION'")
      )
        return [postRow()];
      return [];
    });
    await expect(
      repository.listPending({
        tenantId,
        actorUserId,
        limit: 20,
        correlationId: 'moderation-list-correlation',
      }),
    ).resolves.toMatchObject({ outcome: 'found', items: [{ post: { id: postId } }] });
    const list = query.mock.calls.find(([text]) =>
      String(text).includes("status = 'PENDING_MODERATION'"),
    );
    expect(list?.[0]).toContain('order by updated_at, id');
    expect(list?.[1]?.[4]).toBe(21);
  });
});
