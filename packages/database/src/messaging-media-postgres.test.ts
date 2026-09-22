import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MESSAGING_MEDIA_MAX_ATTACHMENTS_PER_MESSAGE,
  createMessagingMediaRepository,
  messagingMediaObjectKey,
  type MessagingMediaRepository,
} from './messaging-media-repository.js';
import { createMessagingRepository, type MessagingRepository } from './messaging-repository.js';
import { withTenantTransaction } from './connection.js';

/**
 * Real PostgreSQL evidence for the chat media pipeline: the quarantine-to-READY lifecycle, the
 * deferred attachment guard and the hidden-message readers. Object storage is not involved — the
 * finalize step receives exactly the facts the API would have measured with a HEAD request.
 */
const suppliedConnectionString = process.env.MESSAGING_MEDIA_TEST_DATABASE_URL;
const ciConnectionString = process.env.APP_ENV === 'ci' ? process.env.DATABASE_URL : undefined;
const describePostgres = suppliedConnectionString || ciConnectionString ? describe : describe.skip;

const sha256 = (character: string): string => character.repeat(64);

describePostgres('chat media PostgreSQL pipeline', () => {
  let pool: Pool;
  let media: MessagingMediaRepository;
  let messaging: MessagingRepository;
  const tenantId = randomUUID();
  const senderUserId = randomUUID();
  const peerUserId = randomUUID();
  const conversationId = randomUUID();
  const senderMemberId = randomUUID();

  async function issue(fileName: string, contentType: string, byteSize: number) {
    return media.issueUpload({
      tenantId,
      actorUserId: senderUserId,
      conversationId,
      fileName,
      contentType,
      byteSize,
      sha256: sha256('a'),
      idempotencyKey: `media-issue-${randomUUID()}`,
      requestHash: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      correlationId: `media-correlation-${randomUUID()}`,
    });
  }

  async function ready(fileName = 'photo.png', contentType = 'image/png') {
    const issued = await issue(fileName, contentType, 1_024);
    if (issued.outcome !== 'issued') throw new Error(`ISSUE_FAILED:${issued.outcome}`);
    const observed = {
      objectKey: issued.intent.objectKey,
      objectVersion: 'source-version-1',
      etag: '"source-etag-1"',
      byteSize: 1_024,
      contentType,
      checksumSha256: sha256('a'),
    };
    const finalized = await media.finalizeUpload({
      tenantId,
      actorUserId: senderUserId,
      mediaId: issued.intent.id,
      idempotencyKey: `media-finalize-${randomUUID()}`,
      requestHash: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      correlationId: `media-correlation-${randomUUID()}`,
      observed,
    });
    if (finalized.outcome !== 'finalized') throw new Error(`FINALIZE_FAILED:${finalized.outcome}`);
    const claims = await media.claimScans({
      tenantId,
      limit: 10,
      leaseOwner: 'media-pg-test',
      leaseSeconds: 30,
    });
    const claim = claims.find((candidate) => candidate.mediaId === issued.intent.id);
    if (!claim) throw new Error('SCAN_CLAIM_MISSING');
    const keys = messagingMediaObjectKey({ tenantId, conversationId, mediaId: claim.mediaId });
    const scanned = await media.completeScan({
      tenantId,
      leaseOwner: 'media-pg-test',
      mediaId: claim.mediaId,
      readyObjectKey: `${keys.readyPrefix}/content`,
      readyObjectVersion: 'ready-version-1',
      correlationId: `media-correlation-${randomUUID()}`,
    });
    if (scanned !== 'ready') throw new Error(`COMPLETE_SCAN_FAILED:${scanned}`);
    return issued.intent.id;
  }

  beforeAll(async () => {
    pool = new Pool({
      connectionString: suppliedConnectionString ?? ciConnectionString,
      max: 4,
      application_name: 'phub-messaging-media-pg-test',
    });
    media = createMessagingMediaRepository(pool);
    messaging = createMessagingRepository(pool);
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name) values ($1, $2, $3)`,
      [tenantId, `media-pg-${tenantId}`, 'Chat media PostgreSQL'],
    );
    await withTenantTransaction(pool, tenantId, async (client) => {
      for (const [index, [id, permission]] of (
        [
          [senderUserId, 'chat.direct.create'],
          [peerUserId, 'chat.direct.create'],
        ] as const
      ).entries()) {
        await client.query(
          `insert into identity.users (tenant_id, id, status) values ($1, $2, 'ACTIVE')`,
          [tenantId, id],
        );
        await client.query(
          `insert into identity.user_access_profiles (tenant_id, user_id, roles, permissions)
           values ($1, $2, array['client']::text[], array[$3]::text[])`,
          [tenantId, id, permission],
        );
        // Direct chat only reaches a peer that PadlHub can actually deliver to.
        await client.query(
          `insert into profile.user_summaries (tenant_id, user_id, display_name, phone_e164)
           values ($1, $2, $3, $4)`,
          [tenantId, id, `Media peer ${index + 1}`, `+7900000${index + 1}`],
        );
      }
      await client.query(
        `insert into messaging.tenant_runtime_settings (tenant_id, http_enabled, direct_enabled)
         values ($1, true, true)`,
        [tenantId],
      );
      const [leftUserId, rightUserId] = [senderUserId, peerUserId].sort();
      await client.query(
        `insert into messaging.conversations (tenant_id, id, kind, state, next_sequence)
         values ($1, $2, 'DIRECT', 'OPEN', 1)`,
        [tenantId, conversationId],
      );
      await client.query(
        `insert into messaging.direct_conversations (tenant_id, conversation_id, left_user_id, right_user_id)
         values ($1, $2, $3, $4)`,
        [tenantId, conversationId, leftUserId, rightUserId],
      );
      await client.query(
        `insert into messaging.conversation_members (tenant_id, id, conversation_id, user_id, member_type, state)
         values ($1, $2, $3, $4, 'USER', 'ACTIVE')`,
        [tenantId, senderMemberId, conversationId, senderUserId],
      );
      await client.query(
        `insert into messaging.conversation_members (tenant_id, conversation_id, user_id, member_type, state)
         values ($1, $2, $3, 'USER', 'ACTIVE')`,
        [tenantId, conversationId, peerUserId],
      );
    });
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('walks one uploaded image from UPLOADING to READY and attaches it to a message', async () => {
    const mediaId = await ready();

    const asset = await media.getMedia({ tenantId, actorUserId: senderUserId, mediaId });
    expect(asset).toMatchObject({
      outcome: 'ok',
      media: { state: 'READY', mediaType: 'IMAGE', readyObjectVersion: 'ready-version-1' },
    });

    const sent = await messaging.sendMessage({
      tenantId,
      userId: senderUserId,
      conversationId,
      clientMessageId: `client-media-${randomUUID()}`,
      idempotencyKey: `command-media-${randomUUID()}`,
      body: '',
      attachmentMediaIds: [mediaId],
      correlationId: `correlation-media-${randomUUID()}`,
    });

    expect(sent.outcome).toBe('ok');
    if (sent.outcome !== 'ok') return;
    expect(sent.message.messageType).toBe('IMAGE');
    expect(sent.message.body).toBe('');
    expect(sent.message.attachments).toEqual([
      {
        mediaId,
        position: 1,
        fileName: 'photo.png',
        contentType: 'image/png',
        byteSize: 1_024,
        mediaType: 'IMAGE',
      },
    ]);

    const history = await messaging.listMessages({
      tenantId,
      userId: peerUserId,
      conversationId,
      afterSequence: 0,
      limit: 50,
    });
    expect(history.outcome).toBe('ok');
    if (history.outcome !== 'ok') return;
    expect(history.page.messages.at(-1)?.attachments).toHaveLength(1);

    const served = await messaging.getMessageMediaForViewer({
      tenantId,
      userId: peerUserId,
      mediaId,
    });
    expect(served).toMatchObject({
      outcome: 'ok',
      media: { mediaId, objectVersion: 'ready-version-1', mediaType: 'IMAGE' },
    });
  });

  it('refuses an attachment that is still uploading without writing a message', async () => {
    const issued = await issue('draft.pdf', 'application/pdf', 2_048);
    if (issued.outcome !== 'issued') throw new Error('ISSUE_FAILED');
    const clientMessageId = `client-media-${randomUUID()}`;

    const refused = await messaging.sendMessage({
      tenantId,
      userId: senderUserId,
      conversationId,
      clientMessageId,
      idempotencyKey: `command-media-${randomUUID()}`,
      body: 'файл',
      attachmentMediaIds: [issued.intent.id],
      correlationId: `correlation-media-${randomUUID()}`,
    });

    expect(refused).toMatchObject({ outcome: 'attachment_invalid', reason: 'NOT_READY' });
    const rows = await withTenantTransaction(pool, tenantId, (client) =>
      client.query(
        `select 1 from messaging.messages where tenant_id = $1 and client_message_id = $2`,
        [tenantId, clientMessageId],
      ),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('refuses a fifth attachment and a reused attachment', async () => {
    const ids: string[] = [];
    for (let index = 0; index < MESSAGING_MEDIA_MAX_ATTACHMENTS_PER_MESSAGE; index += 1) {
      ids.push(await ready(`photo-${index}.png`));
    }

    const overflow = await messaging.sendMessage({
      tenantId,
      userId: senderUserId,
      conversationId,
      clientMessageId: `client-media-${randomUUID()}`,
      idempotencyKey: `command-media-${randomUUID()}`,
      body: 'слишком много',
      attachmentMediaIds: [...ids, await ready('photo-extra.png')],
      correlationId: `correlation-media-${randomUUID()}`,
    });
    expect(overflow).toMatchObject({ outcome: 'attachment_invalid', reason: 'LIMIT' });

    const accepted = await messaging.sendMessage({
      tenantId,
      userId: senderUserId,
      conversationId,
      clientMessageId: `client-media-${randomUUID()}`,
      idempotencyKey: `command-media-${randomUUID()}`,
      body: 'четыре файла',
      attachmentMediaIds: ids,
      correlationId: `correlation-media-${randomUUID()}`,
    });
    expect(accepted.outcome).toBe('ok');
    if (accepted.outcome !== 'ok') return;
    expect(accepted.message.messageType).toBe('IMAGE');
    expect(accepted.message.attachments.map((attachment) => attachment.position)).toEqual([
      1, 2, 3, 4,
    ]);

    const reused = await messaging.sendMessage({
      tenantId,
      userId: senderUserId,
      conversationId,
      clientMessageId: `client-media-${randomUUID()}`,
      idempotencyKey: `command-media-${randomUUID()}`,
      body: 'повтор',
      attachmentMediaIds: [ids[0] as string],
      correlationId: `correlation-media-${randomUUID()}`,
    });
    expect(reused).toMatchObject({ outcome: 'attachment_invalid', reason: 'ALREADY_BOUND' });
  });

  it('hides a moderated message and its attachment from every reader', async () => {
    const mediaId = await ready('hidden.png');
    const sent = await messaging.sendMessage({
      tenantId,
      userId: senderUserId,
      conversationId,
      clientMessageId: `client-media-${randomUUID()}`,
      idempotencyKey: `command-media-${randomUUID()}`,
      body: 'скрытое',
      attachmentMediaIds: [mediaId],
      correlationId: `correlation-media-${randomUUID()}`,
    });
    expect(sent.outcome).toBe('ok');
    if (sent.outcome !== 'ok') return;
    const messageId = sent.message.id;

    const actionId = randomUUID();
    await withTenantTransaction(pool, tenantId, async (client) => {
      const caseRow = await client.query<{ id: string }>(
        `insert into moderation.cases (
           tenant_id, conversation_id, message_id, source, dedupe_key, severity, reason_code, state
         ) values ($1, $2, $3, 'USER_REPORT', $4, 'MEDIUM', 'ABUSE', 'OPEN')
         returning id`,
        [tenantId, conversationId, messageId, `chat-message:${messageId}`],
      );
      const caseId = caseRow.rows[0]?.id as string;
      await client.query(
        `insert into moderation.actions (
           tenant_id, id, case_id, action_type, actor_type, actor_user_id, reason_code,
           idempotency_key, correlation_id
         ) values ($1, $2, $3, 'REDACT_MESSAGE', 'STAFF', $4, 'ABUSE', $5, $6)`,
        [
          tenantId,
          actionId,
          caseId,
          senderUserId,
          `moderation-${randomUUID()}`,
          `moderation-correlation-${randomUUID()}`,
        ],
      );
      await client.query(
        `update messaging.messages set hidden_at = now(), hidden_by_action_id = $3
          where tenant_id = $1 and id = $2`,
        [tenantId, messageId, actionId],
      );
    });

    const history = await messaging.listMessages({
      tenantId,
      userId: peerUserId,
      conversationId,
      afterSequence: 0,
      limit: 50,
    });
    expect(history.outcome).toBe('ok');
    if (history.outcome !== 'ok') return;
    expect(history.page.messages.some((message) => message.id === messageId)).toBe(false);

    const conversations = await messaging.listConversations({
      tenantId,
      userId: peerUserId,
      limit: 10,
    });
    const lastBodies = conversations.map((conversation) => conversation.lastMessage?.body ?? '');
    expect(lastBodies).not.toContain('скрытое');

    await expect(
      messaging.getMessageMediaForViewer({ tenantId, userId: peerUserId, mediaId }),
    ).resolves.toEqual({ outcome: 'not_found' });

    // Restoring the message through the paired columns brings it back.
    await withTenantTransaction(pool, tenantId, (client) =>
      client.query(
        `update messaging.messages set hidden_at = null, hidden_by_action_id = null
          where tenant_id = $1 and id = $2`,
        [tenantId, messageId],
      ),
    );
    const restored = await messaging.listMessages({
      tenantId,
      userId: peerUserId,
      conversationId,
      afterSequence: 0,
      limit: 50,
    });
    expect(restored.outcome).toBe('ok');
    if (restored.outcome !== 'ok') return;
    expect(restored.page.messages.some((message) => message.id === messageId)).toBe(true);
  });

  it('deletes the quarantine object of an abandoned upload discovered by key', async () => {
    const issued = await issue('abandoned.png', 'image/png', 3_072);
    if (issued.outcome !== 'issued') throw new Error('ISSUE_FAILED');
    await withTenantTransaction(pool, tenantId, (client) =>
      client.query(
        `update messaging.media_assets set upload_expires_at = now() - interval '1 minute'
          where tenant_id = $1 and id = $2`,
        [tenantId, issued.intent.id],
      ),
    );

    const expired = await media.expireDue({
      tenantId,
      limit: 10,
      correlationId: `media-correlation-${randomUUID()}`,
    });
    const abandoned = expired.find((row) => row.mediaId === issued.intent.id);
    expect(abandoned).toMatchObject({ objectVersion: null });

    // The worker discovers the version of the never-finalized object and records it for deletion.
    await media.scheduleExpiredSourceVersion({
      tenantId,
      mediaId: issued.intent.id,
      objectVersion: 'abandoned-version-1',
    });
    const claims = await media.claimGc({
      tenantId,
      limit: 10,
      leaseOwner: 'media-pg-test',
      leaseSeconds: 30,
    });
    for (const claim of claims.filter((candidate) => candidate.mediaId === issued.intent.id)) {
      expect(
        await media.completeGc({
          tenantId,
          leaseOwner: 'media-pg-test',
          jobId: claim.jobId,
        }),
      ).toBe('deleted');
    }
    await expect(
      media.confirmExpiredObjectsAbsent({ tenantId, mediaId: issued.intent.id }),
    ).resolves.toBe(true);
  });

  it('expires an unattached READY asset and schedules both exact object versions for deletion', async () => {
    const mediaId = await ready('expiring.png');
    await withTenantTransaction(pool, tenantId, (client) =>
      client.query(
        // A 24-hour-old unattached asset: both its quarantine TTL and its unattached TTL elapsed,
        // so the already scheduled quarantine deletion is claimable and expiry adds the ready one.
        `update messaging.media_assets
            set unattached_expires_at = now() - interval '1 minute',
                upload_expires_at = now() - interval '1 minute'
          where tenant_id = $1 and id = $2`,
        [tenantId, mediaId],
      ),
    );

    const expired = await media.expireDue({
      tenantId,
      limit: 10,
      correlationId: `media-correlation-${randomUUID()}`,
    });
    expect(expired.some((row) => row.mediaId === mediaId)).toBe(true);

    const jobs = await withTenantTransaction(pool, tenantId, (client) =>
      client.query<{ object_kind: string; object_version: string }>(
        `select object_kind, object_version from messaging.media_gc_jobs
          where tenant_id = $1 and media_id = $2 order by object_kind`,
        [tenantId, mediaId],
      ),
    );
    expect(jobs.rows.map((row) => [row.object_kind, row.object_version])).toEqual([
      ['READY', 'ready-version-1'],
      ['SOURCE', 'source-version-1'],
    ]);

    const claims = await media.claimGc({
      tenantId,
      limit: 10,
      leaseOwner: 'media-pg-test',
      leaseSeconds: 30,
    });
    for (const claim of claims.filter((candidate) => candidate.mediaId === mediaId)) {
      expect(
        await media.completeGc({ tenantId, leaseOwner: 'media-pg-test', jobId: claim.jobId }),
      ).toBe('deleted');
    }
    await expect(media.confirmExpiredObjectsAbsent({ tenantId, mediaId })).resolves.toBe(true);
  });

  it('re-offers an expired asset whose source version was never discovered', async () => {
    const issued = await issue('undiscovered.png', 'image/png', 2_048);
    if (issued.outcome !== 'issued') throw new Error('ISSUE_FAILED');
    await withTenantTransaction(pool, tenantId, (client) =>
      client.query(
        `update messaging.media_assets set upload_expires_at = now() - interval '1 minute'
          where tenant_id = $1 and id = $2`,
        [tenantId, issued.intent.id],
      ),
    );

    const first = await media.expireDue({
      tenantId,
      limit: 10,
      correlationId: `media-correlation-${randomUUID()}`,
    });
    expect(first.find((row) => row.mediaId === issued.intent.id)).toMatchObject({
      objectVersion: null,
    });

    // Discovery of the never-finalized object failed in that cycle, so the asset must be offered
    // again instead of becoming permanently invisible with its quarantine object left behind.
    const second = await media.expireDue({
      tenantId,
      limit: 10,
      correlationId: `media-correlation-${randomUUID()}`,
    });
    expect(second.some((row) => row.mediaId === issued.intent.id)).toBe(true);
  });

  it('never confirms an expired asset absent while a dead-lettered deletion holds bytes', async () => {
    const mediaId = await ready('dead-letter.png');
    await withTenantTransaction(pool, tenantId, (client) =>
      client.query(
        `update messaging.media_assets
            set unattached_expires_at = now() - interval '1 minute',
                upload_expires_at = now() - interval '1 minute'
          where tenant_id = $1 and id = $2`,
        [tenantId, mediaId],
      ),
    );
    await media.expireDue({
      tenantId,
      limit: 10,
      correlationId: `media-correlation-${randomUUID()}`,
    });

    const claims = await media.claimGc({
      tenantId,
      limit: 10,
      leaseOwner: 'media-pg-test',
      leaseSeconds: 30,
    });
    const mine = claims.filter((claim) => claim.mediaId === mediaId);
    expect(mine.length).toBeGreaterThan(0);
    for (const claim of mine) {
      await media.deadLetterGc({
        tenantId,
        leaseOwner: 'media-pg-test',
        jobId: claim.jobId,
        failureCode: 'MESSAGING_MEDIA_GC_TEST_DOWN',
      });
    }

    // PURGED would claim the bytes are gone while the dead-lettered job still holds them.
    await expect(media.confirmExpiredObjectsAbsent({ tenantId, mediaId })).resolves.toBe(false);
  });
});
