import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import { createCommunityMediaRepository } from './community-media-repository.js';

const connectionString = process.env.COMMUNITY_MEDIA_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describePostgres('community media real PostgreSQL issuance quotas', () => {
  const pool = new Pool({ connectionString, max: 12 });
  const repository = createCommunityMediaRepository(pool);
  const tenantId = randomUUID();
  const ownerUserId = randomUUID();
  const secondUserId = randomUUID();
  const pipelineSeedUserId = randomUUID();
  let sequence = 0;

  function command(actorUserId: string, communityId: string, label: string, byteSize = 1_024) {
    sequence += 1;
    const idempotencyKey = `media-${label}-${String(sequence).padStart(8, '0')}`;
    return {
      tenantId,
      actorUserId,
      communityId,
      idempotencyKey,
      requestHash: hash(idempotencyKey),
      correlationId: `postgres-${idempotencyKey}`,
      contentType: 'image/jpeg' as const,
      byteSize,
      sha256: hash(`payload-${idempotencyKey}`),
    };
  }

  async function createCommunity(): Promise<string> {
    const communityId = randomUUID();
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `insert into communities.communities (
           tenant_id, id, title, visibility, join_policy, status, created_by,
           publishing_preset
         ) values ($1, $2, $3, 'OPEN', 'INSTANT', 'ACTIVE', $4, 'OPEN_COMMUNITY')`,
        [tenantId, communityId, `Media quota ${communityId}`, ownerUserId],
      );
      await client.query(
        `insert into communities.memberships (
           tenant_id, community_id, user_id, role, status, joined_at
         ) values
           ($1, $2, $3, 'OWNER', 'ACTIVE', now()),
           ($1, $2, $4, 'MEMBER', 'ACTIVE', now())`,
        [tenantId, communityId, ownerUserId, secondUserId],
      );
    });
    return communityId;
  }

  async function seedUploading(
    communityId: string,
    actorUserId: string,
    count: number,
  ): Promise<void> {
    await withTenantTransaction(pool, tenantId, async (client) => {
      for (let index = 0; index < count; index += 1) {
        const mediaId = randomUUID();
        await client.query(
          `insert into community_content.media_assets (
             tenant_id, id, community_id, uploader_user_id, source_object_key,
             declared_content_type, declared_size_bytes, declared_sha256, upload_expires_at
           ) values ($1, $2, $3, $4, $5, 'image/jpeg', 1024, $6, now() + interval '15 minutes')`,
          [
            tenantId,
            mediaId,
            communityId,
            actorUserId,
            `community-media/quarantine/${tenantId}/${communityId}/${mediaId}/source`,
            hash(`seed-${mediaId}`),
          ],
        );
      }
    });
  }

  async function seedExpiredDailyBytes(communityId: string, actorUserId: string): Promise<void> {
    await withTenantTransaction(pool, tenantId, async (client) => {
      for (let index = 0; index < 10; index += 1) {
        const mediaId = randomUUID();
        await client.query(
          `insert into community_content.media_assets (
             tenant_id, id, community_id, uploader_user_id, state, source_object_key,
             declared_content_type, declared_size_bytes, declared_sha256,
             upload_expires_at, expired_at, created_at, updated_at
           ) values (
             $1, $2, $3, $4, 'EXPIRED', $5, 'image/jpeg', 15728640, $6,
             now() - interval '30 seconds', now(), now() - interval '1 minute', now()
           )`,
          [
            tenantId,
            mediaId,
            communityId,
            actorUserId,
            `community-media/quarantine/${tenantId}/${communityId}/${mediaId}/source`,
            hash(`expired-${mediaId}`),
          ],
        );
      }
    });
  }

  async function seedScanning(
    communityId: string,
    actorUserId: string,
    count: number,
  ): Promise<void> {
    await withTenantTransaction(pool, tenantId, async (client) => {
      for (let index = 0; index < count; index += 1) {
        const mediaId = randomUUID();
        const digest = hash(`scanning-${mediaId}`);
        await client.query(
          `insert into community_content.media_assets (
             tenant_id, id, community_id, uploader_user_id, state, source_object_key,
             source_object_version, source_etag, declared_content_type, declared_size_bytes,
             declared_sha256, source_content_type, source_size_bytes, source_sha256,
             upload_expires_at, finalized_at
           ) values (
             $1, $2, $3, $4, 'SCANNING', $5, $6, $7, 'image/jpeg', 1,
             $8, 'image/jpeg', 1, $8, now() + interval '15 minutes', now()
           )`,
          [
            tenantId,
            mediaId,
            communityId,
            actorUserId,
            `community-media/quarantine/${tenantId}/${communityId}/${mediaId}/source`,
            `version-${mediaId}`,
            `etag-${mediaId}`,
            digest,
          ],
        );
      }
    });
  }

  async function seedExpiredIssueCount(
    communityId: string,
    actorUserId: string,
    count: number,
  ): Promise<void> {
    await withTenantTransaction(pool, tenantId, async (client) => {
      for (let index = 0; index < count; index += 1) {
        const mediaId = randomUUID();
        await client.query(
          `insert into community_content.media_assets (
             tenant_id, id, community_id, uploader_user_id, state, source_object_key,
             declared_content_type, declared_size_bytes, declared_sha256,
             upload_expires_at, expired_at, created_at, updated_at
           ) values (
             $1, $2, $3, $4, 'EXPIRED', $5, 'image/jpeg', 1, $6,
             now() - interval '30 seconds', now(), now() - interval '1 minute', now()
           )`,
          [
            tenantId,
            mediaId,
            communityId,
            actorUserId,
            `community-media/quarantine/${tenantId}/${communityId}/${mediaId}/source`,
            hash(`expired-count-${mediaId}`),
          ],
        );
      }
    });
  }

  beforeAll(async () => {
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name)
       values ($1, $2, $3)`,
      [tenantId, `media-quota-${tenantId}`, 'Media quota integration'],
    );
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `insert into identity.users (tenant_id, id, status)
         values ($1, $2, 'ACTIVE'), ($1, $3, 'ACTIVE'), ($1, $4, 'ACTIVE')`,
        [tenantId, ownerUserId, secondUserId, pipelineSeedUserId],
      );
    });
  });

  afterAll(async () => pool.end());

  beforeEach(async () => {
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query('delete from community_content.media_gc_jobs where tenant_id = $1', [
        tenantId,
      ]);
      await client.query('delete from community_content.media_variants where tenant_id = $1', [
        tenantId,
      ]);
      await client.query('delete from community_content.media_commands where tenant_id = $1', [
        tenantId,
      ]);
      await client.query('delete from community_content.media_assets where tenant_id = $1', [
        tenantId,
      ]);
    });
  });

  it('admits exactly one of two concurrent commands at the actor outstanding boundary', async () => {
    const communityId = await createCommunity();
    await seedUploading(communityId, ownerUserId, 9);

    const results = await Promise.all([
      repository.issueUpload(command(ownerUserId, communityId, 'actor-race-a')),
      repository.issueUpload(command(ownerUserId, communityId, 'actor-race-b')),
    ]);
    expect(results.filter((result) => result.outcome === 'issued')).toHaveLength(1);
    expect(
      results.filter((result) => result.outcome === 'outstanding_upload_quota_exceeded'),
    ).toHaveLength(1);
  });

  it('serializes different actors at the tenant pipeline boundary', async () => {
    const communityId = await createCommunity();
    await seedUploading(communityId, pipelineSeedUserId, 99);

    const results = await Promise.all([
      repository.issueUpload(command(ownerUserId, communityId, 'tenant-race-owner')),
      repository.issueUpload(command(secondUserId, communityId, 'tenant-race-member')),
    ]);
    expect(results.filter((result) => result.outcome === 'issued')).toHaveLength(1);
    expect(
      results.filter((result) => result.outcome === 'scan_backlog_quota_exceeded'),
    ).toHaveLength(1);
  });

  it('prevents one actor from monopolizing the pipeline with tiny finalized uploads', async () => {
    const communityId = await createCommunity();
    await seedScanning(communityId, ownerUserId, 19);

    const results = await Promise.all([
      repository.issueUpload(command(ownerUserId, communityId, 'actor-pipeline-a', 1)),
      repository.issueUpload(command(ownerUserId, communityId, 'actor-pipeline-b', 1)),
    ]);
    expect(results.filter((result) => result.outcome === 'issued')).toHaveLength(1);
    expect(
      results.filter((result) => result.outcome === 'actor_pipeline_quota_exceeded'),
    ).toHaveLength(1);
  });

  it('replays a successful issue while quota is saturated without adding a row', async () => {
    const communityId = await createCommunity();
    const input = command(ownerUserId, communityId, 'replay');
    const original = await repository.issueUpload(input);
    expect(original).toMatchObject({ outcome: 'issued', replayed: false });
    await seedUploading(communityId, secondUserId, 99);

    await expect(repository.issueUpload(input)).resolves.toMatchObject({
      outcome: 'issued',
      replayed: true,
    });
    await withTenantTransaction(pool, tenantId, async (client) => {
      const rows = await client.query<{ count: string }>(
        `select count(*)::text as count
           from community_content.media_assets
          where tenant_id = $1 and community_id = $2`,
        [tenantId, communityId],
      );
      expect(rows.rows[0]?.count).toBe('100');
    });
  });

  it('does not replay an upload grant after the authoritative media row is purged', async () => {
    const communityId = await createCommunity();
    const input = command(ownerUserId, communityId, 'purged-replay');
    const original = await repository.issueUpload(input);
    expect(original).toMatchObject({ outcome: 'issued', replayed: false });
    if (!('intent' in original)) throw new Error('expected issued intent');
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `update community_content.media_assets
            set state = 'PURGED', purged_at = now(), updated_at = now()
          where tenant_id = $1 and id = $2`,
        [tenantId, original.intent.id],
      );
    });

    await expect(repository.issueUpload(input)).resolves.toEqual({ outcome: 'upload_expired' });
  });

  it('does not make exact source GC claimable before every issued PUT grant expires', async () => {
    const communityId = await createCommunity();
    const input = command(ownerUserId, communityId, 'source-gc-floor');
    const issued = await repository.issueUpload(input);
    expect(issued).toMatchObject({ outcome: 'issued' });
    if (!('intent' in issued)) throw new Error('expected issued intent');
    const finalized = await repository.finalizeUpload({
      tenantId,
      actorUserId: ownerUserId,
      communityId,
      mediaId: issued.intent.id,
      idempotencyKey: `${input.idempotencyKey}-finalize`,
      requestHash: hash(`${input.requestHash}-finalize`),
      correlationId: `${input.correlationId}-finalize`,
      expectedRevision: 1,
      observed: {
        byteSize: input.byteSize,
        contentType: input.contentType,
        etag: 'source-etag',
        versionId: 'source-version',
        checksumSha256: input.sha256,
      },
    });
    expect(finalized).toMatchObject({ outcome: 'finalized' });
    const [claim] = await repository.claimScans({
      tenantId,
      leaseOwner: 'quota-test-worker',
      leaseSeconds: 60,
      limit: 1,
    });
    if (!claim) throw new Error('expected scan claim');
    const variantSha = hash('source-gc-floor-variant');
    await expect(
      repository.completeScan({
        tenantId,
        mediaId: claim.mediaId,
        leaseOwner: 'quota-test-worker',
        computedSourceSha256: input.sha256,
        correlationId: `${input.correlationId}-scan`,
        variants: [
          {
            variant: 'FEED',
            objectKey: `community-media/ready/${tenantId}/${communityId}/${claim.mediaId}/feed/${variantSha}.webp`,
            objectVersion: 'ready-version',
            objectEtag: 'ready-etag',
            sha256: variantSha,
            byteSize: 1,
            width: 1,
            height: 1,
          },
        ],
      }),
    ).resolves.toBe('ready');

    await withTenantTransaction(pool, tenantId, async (client) => {
      const evidence = await client.query<{
        available_at: Date;
        upload_expires_at: Date;
      }>(
        `select job.available_at, media.upload_expires_at
           from community_content.media_gc_jobs job
           join community_content.media_assets media
             on media.tenant_id = job.tenant_id and media.id = job.media_id
          where job.tenant_id = $1 and job.media_id = $2 and job.object_kind = 'SOURCE'`,
        [tenantId, claim.mediaId],
      );
      expect(evidence.rows[0]?.available_at.getTime()).toBeGreaterThanOrEqual(
        evidence.rows[0]?.upload_expires_at.getTime() ?? Number.POSITIVE_INFINITY,
      );
    });
    await expect(
      repository.claimGc({
        tenantId,
        leaseOwner: 'quota-test-gc',
        leaseSeconds: 60,
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it('does not refund rolling declared bytes after upload intents expire', async () => {
    const communityId = await createCommunity();
    await seedExpiredDailyBytes(communityId, ownerUserId);

    await expect(
      repository.issueUpload(command(ownerUserId, communityId, 'daily-after-expiry', 1)),
    ).resolves.toMatchObject({
      outcome: 'daily_declared_bytes_quota_exceeded',
    });
  });

  it('does not refund rolling issue count after tiny upload intents expire', async () => {
    const communityId = await createCommunity();
    await seedExpiredIssueCount(communityId, ownerUserId, 100);

    await expect(
      repository.issueUpload(command(ownerUserId, communityId, 'daily-count-after-expiry', 1)),
    ).resolves.toMatchObject({
      outcome: 'daily_issue_count_quota_exceeded',
    });
  });
});
