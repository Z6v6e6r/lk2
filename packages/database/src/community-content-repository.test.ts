import { describe, expect, it, vi } from 'vitest';

import { createCommunityContentRepository } from './community-content-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const actorUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const communityId = '11111111-1111-4111-8111-111111111111';
const postId = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-08-04T10:00:00.000Z');

const command = {
  tenantId,
  actorUserId,
  communityId,
  idempotencyKey: 'community-content-repository-0001',
  requestHash: 'a'.repeat(64),
  correlationId: 'community-content-correlation',
} as const;

function postRow(overrides: Record<string, unknown> = {}) {
  return {
    id: postId,
    community_id: communityId,
    author_user_id: actorUserId,
    status: 'PUBLISHED',
    body: 'Первый пост',
    revision: 1,
    created_at: now,
    published_at: now,
    updated_at: now,
    archived_at: null,
    restore_until: null,
    retention_until: null,
    ...overrides,
  };
}

function poolWithQuery(handler: (text: string, values: readonly unknown[]) => readonly unknown[]) {
  const query = vi.fn((text: string, values: readonly unknown[] = []) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve({ rows: [] });
    }
    if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
    if (text.includes('with allocated_event_sequence as')) {
      return Promise.resolve({
        rows: [{ sequence: 1, command_count: 1, audit_count: 1, outbox_count: 1 }],
      });
    }
    return Promise.resolve({ rows: handler(text, values) });
  });
  return {
    pool: { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as never,
    query,
  };
}

describe('community content repository', () => {
  it('creates a post, revision, replay result, audit and identifier-only outbox atomically', async () => {
    const { pool, query } = poolWithQuery((text, values) => {
      if (text.includes('from community_content.commands')) return [];
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('from communities.communities c')) {
        return [
          {
            publishing_preset: 'OPEN_COMMUNITY',
            visibility: 'PUBLIC',
            membership_status: 'ACTIVE',
            membership_role: 'MEMBER',
          },
        ];
      }
      if (text.includes('insert into community_content.posts')) {
        expect(values[3]).toBe('PUBLISHED');
        return [postRow()];
      }
      return [];
    });

    await expect(
      createCommunityContentRepository(pool).createPost({ ...command, body: 'Первый пост' }),
    ).resolves.toMatchObject({ outcome: 'created', post: { id: postId }, replayed: false });
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into community_content.post_revisions'),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) =>
        String(text).includes('insert into community_content.commands'),
      ),
    ).toBe(true);
    expect(
      query.mock.calls.some(([text]) => String(text).includes('insert into audit.audit_log')),
    ).toBe(true);
    const applied = query.mock.calls.find(([text]) =>
      String(text).includes('with allocated_event_sequence as'),
    );
    const appliedSql = String(applied?.[0]);
    const outboxSql = appliedSql.slice(appliedSql.indexOf('outbox_record as'));
    expect(appliedSql).toContain('insert into community_content.events');
    expect(appliedSql).toContain('insert into community_content.commands');
    expect(appliedSql).toContain('insert into audit.audit_log');
    expect(outboxSql).toContain('insert into audit.outbox_events');
    expect(outboxSql).toContain("'sequence', inserted_event.sequence");
    expect(outboxSql).not.toContain('$8::jsonb');
    expect(appliedSql).toContain('retention_due_at');
    expect(
      query.mock.calls.filter(([text]) =>
        String(text).includes('with allocated_event_sequence as'),
      ),
    ).toHaveLength(1);
    expect(query).toHaveBeenCalledWith('commit');
  });

  it('routes member posts to moderation and rejects member publication in STAFF_FEED', async () => {
    const moderated = poolWithQuery((text, values) => {
      if (text.includes('from community_content.commands')) return [];
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('from communities.communities c')) {
        return [
          {
            publishing_preset: 'MODERATED_FEED',
            visibility: 'PUBLIC',
            membership_status: 'ACTIVE',
            membership_role: 'MEMBER',
          },
        ];
      }
      if (text.includes('insert into community_content.posts')) {
        expect(values[3]).toBe('PENDING_MODERATION');
        return [postRow({ status: 'PENDING_MODERATION', published_at: null })];
      }
      return [];
    });
    await expect(
      createCommunityContentRepository(moderated.pool).createPost({
        ...command,
        body: 'На проверку',
      }),
    ).resolves.toMatchObject({ outcome: 'created', post: { status: 'PENDING_MODERATION' } });

    const staffOnly = poolWithQuery((text) => {
      if (text.includes('from community_content.commands')) return [];
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('from communities.communities c')) {
        return [
          {
            publishing_preset: 'STAFF_FEED',
            visibility: 'PUBLIC',
            membership_status: 'ACTIVE',
            membership_role: 'MEMBER',
          },
        ];
      }
      return [];
    });
    await expect(
      createCommunityContentRepository(staffOnly.pool).createPost({
        ...command,
        body: 'Нельзя публиковать',
      }),
    ).resolves.toEqual({ outcome: 'publishing_forbidden' });
  });

  it('lets the author edit HIDDEN content only by resubmitting it to moderation', async () => {
    const { pool, query } = poolWithQuery((text, values) => {
      if (text.includes('from community_content.commands')) return [];
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('from communities.communities c')) {
        return [
          {
            publishing_preset: 'OPEN_COMMUNITY',
            visibility: 'PUBLIC',
            membership_status: 'ACTIVE',
            membership_role: 'MEMBER',
          },
        ];
      }
      if (text.includes('from community_content.posts') && text.includes('for update')) {
        return [postRow({ status: 'HIDDEN' })];
      }
      if (text.includes('update community_content.posts')) {
        expect(values[4]).toBe('PENDING_MODERATION');
        return [
          postRow({
            status: 'PENDING_MODERATION',
            body: 'Исправленный пост',
            revision: 2,
            published_at: null,
          }),
        ];
      }
      return [];
    });
    await expect(
      createCommunityContentRepository(pool).editPost({
        ...command,
        postId,
        body: 'Исправленный пост',
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({
      outcome: 'edited',
      post: { status: 'PENDING_MODERATION', body: 'Исправленный пост', revision: 2 },
    });
    const update = query.mock.calls.find(([text]) =>
      String(text).includes('update community_content.posts'),
    );
    expect(update?.[0]).toContain("when status = 'HIDDEN' then null");
    expect(update?.[0]).toContain('hidden_at = null');
  });

  it('archives instead of deleting and writes the accepted restore/retention clocks', async () => {
    const archivedAt = new Date('2026-08-04T11:00:00.000Z');
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('from community_content.commands')) return [];
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('from communities.communities c')) {
        return [
          {
            publishing_preset: 'OPEN_COMMUNITY',
            visibility: 'PUBLIC',
            membership_status: 'ACTIVE',
            membership_role: 'MEMBER',
          },
        ];
      }
      if (text.includes('select id, community_id') && text.includes('for update'))
        return [postRow()];
      if (text.includes('update community_content.posts')) {
        return [
          postRow({
            status: 'ARCHIVED',
            revision: 2,
            updated_at: archivedAt,
            archived_at: archivedAt,
            restore_until: new Date('2026-09-03T11:00:00.000Z'),
            retention_until: new Date('2031-08-04T11:00:00.000Z'),
          }),
        ];
      }
      return [];
    });
    await expect(
      createCommunityContentRepository(pool).archivePost({
        ...command,
        postId,
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({
      outcome: 'archived',
      post: {
        status: 'ARCHIVED',
        restoreUntil: '2026-09-03T11:00:00.000Z',
        retentionUntil: '2031-08-04T11:00:00.000Z',
      },
    });
    const update = query.mock.calls.find(([text]) =>
      String(text).includes("set status = 'ARCHIVED'"),
    );
    expect(update?.[0]).toContain("interval '30 days'");
    expect(update?.[0]).toContain("interval '5 years'");
    expect(update?.[0]).not.toMatch(/delete\s+from/i);
  });

  it('uses one upserted reaction row per user and does not put text in the event', async () => {
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('from community_content.commands')) return [];
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('from communities.communities c')) {
        return [
          {
            publishing_preset: 'OPEN_COMMUNITY',
            visibility: 'PUBLIC',
            membership_status: 'ACTIVE',
            membership_role: 'MEMBER',
          },
        ];
      }
      if (text.includes('from community_content.posts')) return [postRow()];
      if (text.includes('insert into community_content.post_reactions')) {
        return [{ reaction_type: 'LIKE', status: 'ACTIVE', revision: 2, updated_at: now }];
      }
      return [];
    });
    await expect(
      createCommunityContentRepository(pool).setReaction({
        ...command,
        targetType: 'POST',
        targetId: postId,
        reaction: 'LIKE',
      }),
    ).resolves.toMatchObject({
      outcome: 'changed',
      reaction: { targetId: postId, reaction: 'LIKE', revision: 2 },
    });
    const upsert = query.mock.calls.find(([text]) =>
      String(text).includes('insert into community_content.post_reactions'),
    );
    expect(upsert?.[0]).toContain('on conflict (tenant_id, post_id, user_id) do update');
  });

  it('reads a bounded reverse-chronological snapshot using keyset and watermark', async () => {
    const watermark = new Date('2026-08-04T12:00:00.000Z');
    const { pool, query } = poolWithQuery((text) => {
      if (text.includes('from identity.users')) return [{ status: 'ACTIVE' }];
      if (text.includes('from communities.communities c')) {
        return [
          {
            publishing_preset: 'OPEN_COMMUNITY',
            visibility: 'PUBLIC',
            membership_status: null,
            membership_role: null,
          },
        ];
      }
      if (text.includes('transaction_timestamp()')) return [{ watermark }];
      if (text.includes('from community_content.posts')) return [postRow()];
      return [];
    });
    await expect(
      createCommunityContentRepository(pool).listFeed({
        tenantId,
        viewerUserId: actorUserId,
        communityId,
        limit: 20,
        correlationId: command.correlationId,
      }),
    ).resolves.toMatchObject({
      outcome: 'found',
      watermark: '2026-08-04T12:00:00.000Z',
      hasMore: false,
    });
    const feed = query.mock.calls.find(([text]) =>
      String(text).includes('order by published_at desc, id desc'),
    );
    expect(feed?.[0]).toContain("status = 'PUBLISHED'");
    expect(feed?.[0]).toContain('published_at <= $3::timestamptz');
    expect(feed?.[1]?.at(-1)).toBe(21);
  });
});
