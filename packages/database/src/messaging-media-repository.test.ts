import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  MESSAGING_MEDIA_MAX_ATTACHMENTS_PER_MESSAGE,
  attachReadyMediaToMessageWithClient,
  listAttachmentsForMessagesWithClient,
  messagingMediaObjectKey,
} from './messaging-media-repository.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const conversationId = '22222222-2222-4222-8222-222222222222';
const messageId = '33333333-3333-4333-8333-333333333333';
const senderUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const sha256 = 'a'.repeat(64);

function mediaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    conversation_id: conversationId,
    uploader_user_id: senderUserId,
    media_type: 'IMAGE',
    state: 'READY',
    file_name: 'photo.png',
    declared_content_type: 'image/png',
    declared_size_bytes: '1024',
    declared_sha256: sha256,
    source_object_key: `chat-media/quarantine/${tenantId}/${conversationId}/m/source`,
    source_object_version: 'quarantine-version-1',
    source_etag: '"etag-1"',
    source_content_type: 'image/png',
    source_size_bytes: '1024',
    source_sha256: sha256,
    ready_object_key: `chat-media/ready/${tenantId}/${conversationId}/m/content`,
    ready_object_version: 'ready-version-1',
    bound_message_id: null,
    revision: '2',
    rejection_code: null,
    ready_at: '2026-09-20 10:00:00+00',
    finalized_at: '2026-09-20 10:00:00+00',
    upload_expires_at: '2026-09-20 10:15:00+00',
    unattached_expires_at: '2026-09-21 10:00:00+00',
    expired_at: null,
    purged_at: null,
    created_at: '2026-09-20 09:59:00+00',
    updated_at: '2026-09-20 10:00:00+00',
    ...overrides,
  };
}

function clientWith(handler: (text: string, values?: readonly unknown[]) => unknown): {
  client: PoolClient;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn((text: string, values?: readonly unknown[]) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return Promise.resolve(handler(text, values));
  });
  return { client: { query } as unknown as PoolClient, query };
}

describe('chat media object keys', () => {
  it('keeps quarantine and ready objects in separate, tenant-scoped prefixes', () => {
    const keys = messagingMediaObjectKey({
      tenantId,
      conversationId,
      mediaId: '77777777-7777-4777-8777-777777777777',
    });

    expect(keys.source).toBe(
      `chat-media/quarantine/${tenantId}/${conversationId}/77777777-7777-4777-8777-777777777777/source`,
    );
    expect(keys.readyPrefix).toBe(
      `chat-media/ready/${tenantId}/${conversationId}/77777777-7777-4777-8777-777777777777`,
    );
    expect(keys.source.startsWith('chat-media/')).toBe(true);
  });
});

describe('chat media attachment binding', () => {
  it('refuses more than the four attachments a message may carry', async () => {
    const { client, query } = clientWith(() => ({ rows: [], rowCount: 0 }));

    await expect(
      attachReadyMediaToMessageWithClient(client, {
        tenantId,
        conversationId,
        messageId,
        senderUserId,
        mediaIds: Array.from(
          { length: MESSAGING_MEDIA_MAX_ATTACHMENTS_PER_MESSAGE + 1 },
          (_value, index) => `0000000${index}-0000-4000-8000-000000000000`,
        ),
      }),
    ).rejects.toThrow('MESSAGING_ATTACHMENT_LIMIT_EXCEEDED');
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses the same file twice before touching the database', async () => {
    const { client, query } = clientWith(() => ({ rows: [], rowCount: 0 }));

    await expect(
      attachReadyMediaToMessageWithClient(client, {
        tenantId,
        conversationId,
        messageId,
        senderUserId,
        mediaIds: ['77777777-7777-4777-8777-777777777777', '77777777-7777-4777-8777-777777777777'],
      }),
    ).rejects.toThrow('MESSAGING_ATTACHMENT_DUPLICATE');
    expect(query).not.toHaveBeenCalled();
  });

  it('fails closed when the asset is not READY yet', async () => {
    const { client } = clientWith(() => ({
      rows: [mediaRow({ state: 'SCANNING', ready_object_key: null, ready_object_version: null })],
      rowCount: 1,
    }));

    await expect(
      attachReadyMediaToMessageWithClient(client, {
        tenantId,
        conversationId,
        messageId,
        senderUserId,
        mediaIds: ['77777777-7777-4777-8777-777777777777'],
      }),
    ).rejects.toThrow('MESSAGING_ATTACHMENT_NOT_READY');
  });

  it('refuses an asset uploaded by another user and one bound to another message', async () => {
    const foreign = clientWith(() => ({
      rows: [mediaRow({ uploader_user_id: '99999999-9999-4999-8999-999999999999' })],
      rowCount: 1,
    }));
    await expect(
      attachReadyMediaToMessageWithClient(foreign.client, {
        tenantId,
        conversationId,
        messageId,
        senderUserId,
        mediaIds: ['77777777-7777-4777-8777-777777777777'],
      }),
    ).rejects.toThrow('MESSAGING_ATTACHMENT_FORBIDDEN');

    const bound = clientWith(() => ({
      rows: [mediaRow({ bound_message_id: '55555555-5555-4555-8555-555555555555' })],
      rowCount: 1,
    }));
    await expect(
      attachReadyMediaToMessageWithClient(bound.client, {
        tenantId,
        conversationId,
        messageId,
        senderUserId,
        mediaIds: ['77777777-7777-4777-8777-777777777777'],
      }),
    ).rejects.toThrow('MESSAGING_ATTACHMENT_ALREADY_BOUND');
  });

  it('binds READY assets in the requested order and snapshots the ready object', async () => {
    const rows = [
      mediaRow({
        id: '11111111-1111-4111-8111-111111111111',
        media_type: 'FILE',
        file_name: 'doc.pdf',
        source_content_type: 'application/pdf',
      }),
      mediaRow({ id: '22222222-2222-4222-8222-222222222222' }),
    ];
    const { client, query } = clientWith((text) => {
      if (text.includes('select id, conversation_id')) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 1 };
    });

    const snapshots = await attachReadyMediaToMessageWithClient(client, {
      tenantId,
      conversationId,
      messageId,
      senderUserId,
      mediaIds: ['22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111'],
    });

    expect(snapshots.map((snapshot) => [snapshot.mediaId, snapshot.position])).toEqual([
      ['22222222-2222-4222-8222-222222222222', 1],
      ['11111111-1111-4111-8111-111111111111', 2],
    ]);
    expect(snapshots.map((snapshot) => snapshot.mediaType)).toEqual(['IMAGE', 'FILE']);

    const attachmentInserts = query.mock.calls.filter(([text]) =>
      String(text).includes('insert into messaging.message_attachments'),
    );
    expect(attachmentInserts).toHaveLength(2);
    // The attachment row is a frozen READY snapshot of the object a reader will be granted.
    expect(attachmentInserts[0]?.[1]).toContain(
      `chat-media/ready/${tenantId}/${conversationId}/m/content`,
    );
    const unbindUpdates = query.mock.calls.filter(([text]) =>
      String(text).includes('unattached_expires_at = null'),
    );
    expect(unbindUpdates).toHaveLength(2);
  });
});

describe('chat media attachment reads', () => {
  it('returns ordered snapshots for a whole message page in a single query', async () => {
    const { client, query } = clientWith(() => ({
      rows: [
        {
          message_id: messageId,
          media_id: '11111111-1111-4111-8111-111111111111',
          position: 1,
          file_name: 'photo.png',
          content_type: 'image/png',
          size_bytes: '2048',
          media_type: 'IMAGE',
        },
        {
          message_id: messageId,
          media_id: '22222222-2222-4222-8222-222222222222',
          position: 2,
          file_name: 'notes.pdf',
          content_type: 'application/pdf',
          size_bytes: '4096',
          media_type: 'FILE',
        },
      ],
      rowCount: 2,
    }));

    const snapshots = await listAttachmentsForMessagesWithClient(client, {
      tenantId,
      conversationId,
      messageIds: [messageId],
    });

    expect(snapshots).toEqual([
      {
        messageId,
        mediaId: '11111111-1111-4111-8111-111111111111',
        position: 1,
        fileName: 'photo.png',
        contentType: 'image/png',
        byteSize: 2048,
        mediaType: 'IMAGE',
      },
      {
        messageId,
        mediaId: '22222222-2222-4222-8222-222222222222',
        position: 2,
        fileName: 'notes.pdf',
        contentType: 'application/pdf',
        byteSize: 4096,
        mediaType: 'FILE',
      },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain(
      'order by attachment.message_id, attachment.position',
    );
  });

  it('does not query at all when the page has no messages', async () => {
    const { client, query } = clientWith(() => ({ rows: [], rowCount: 0 }));

    await expect(
      listAttachmentsForMessagesWithClient(client, {
        tenantId,
        conversationId,
        messageIds: [],
      }),
    ).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('chat media repository wiring', () => {
  it('is constructible from a pool without touching it', async () => {
    const { createMessagingMediaRepository } = await import('./messaging-media-repository.js');
    const query = vi.fn();
    const repository = createMessagingMediaRepository({ query } as unknown as Pool);

    expect(typeof repository.issueUpload).toBe('function');
    expect(typeof repository.expireDue).toBe('function');
    expect(typeof repository.claimGc).toBe('function');
    expect(query).not.toHaveBeenCalled();
  });
});
