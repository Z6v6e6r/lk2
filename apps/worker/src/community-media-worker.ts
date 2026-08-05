import { randomUUID } from 'node:crypto';

import type { CommunityMediaPersistenceRepository } from '@phub/database';
import type { Logger } from 'pino';

import {
  prepareCommunityMedia,
  type CommunityMediaMalwareScanner,
  type CommunityMediaWorkerObjectStore,
} from './community-media-processing.js';

const SCAN_LEASE_SECONDS = 120;
const GC_LEASE_SECONDS = 120;
const DEFAULT_MAX_ATTEMPTS = 8;

const permanentRejections = new Map<string, string>([
  ['COMMUNITY_MEDIA_MALWARE_DETECTED', 'MALWARE_DETECTED'],
  ['COMMUNITY_MEDIA_CONTENT_TYPE_MISMATCH', 'CONTENT_TYPE_MISMATCH'],
  ['COMMUNITY_MEDIA_SOURCE_TOO_LARGE', 'SOURCE_TOO_LARGE'],
  ['COMMUNITY_MEDIA_IMAGE_INVALID', 'IMAGE_INVALID'],
]);

function errorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.message)) {
    return error.message.slice(0, 64);
  }
  return 'COMMUNITY_MEDIA_TRANSIENT_FAILURE';
}

function retryAt(attempt: number): string {
  const delayMs = Math.min(300_000, 2_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 7));
  return new Date(Date.now() + delayMs).toISOString();
}

export function communityMediaVariantObjectKey(input: {
  readonly tenantId: string;
  readonly communityId: string;
  readonly mediaId: string;
  readonly variant: 'thumbnail' | 'feed';
  readonly sha256: string;
}): string {
  if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
    throw new Error('COMMUNITY_MEDIA_VARIANT_SHA256_INVALID');
  }
  return `community-media/ready/${input.tenantId}/${input.communityId}/${input.mediaId}/${input.variant}/${input.sha256}.webp`;
}

export interface CommunityMediaCycleResult {
  readonly expired: number;
  readonly scanned: number;
  readonly rejected: number;
  readonly scanRetried: number;
  readonly scanFailed: number;
  readonly gcCompleted: number;
  readonly gcRetried: number;
  readonly gcDead: number;
}

export async function runCommunityMediaCycle(input: {
  readonly repository: CommunityMediaPersistenceRepository;
  readonly store: CommunityMediaWorkerObjectStore;
  readonly scanner: CommunityMediaMalwareScanner;
  readonly logger: Logger;
  readonly tenantId: string;
  readonly workerId: string;
  readonly batchSize: number;
  readonly scanMaxAttempts?: number;
  readonly gcMaxAttempts?: number;
}): Promise<CommunityMediaCycleResult> {
  const correlationId = randomUUID();
  const expired = await input.repository.expireDue({
    tenantId: input.tenantId,
    limit: input.batchSize,
    correlationId,
  });
  for (const media of expired) {
    if (media.sourceObjectVersion) continue;
    try {
      const currentVersion = await input.store.currentVersion(media.sourceObjectKey);
      if (currentVersion) {
        await input.repository.scheduleExpiredSourceVersion({
          tenantId: input.tenantId,
          mediaId: media.mediaId,
          objectVersion: currentVersion,
        });
      } else {
        await input.repository.confirmExpiredSourceAbsent({
          tenantId: input.tenantId,
          mediaId: media.mediaId,
          correlationId,
        });
      }
    } catch (error) {
      input.logger.warn(
        { error, tenantId: input.tenantId, mediaId: media.mediaId },
        'community media expired-source discovery deferred',
      );
    }
  }

  let scanned = 0;
  let rejected = 0;
  let scanRetried = 0;
  let scanFailed = 0;
  const scans = await input.repository.claimScans({
    tenantId: input.tenantId,
    leaseOwner: input.workerId,
    leaseSeconds: SCAN_LEASE_SECONDS,
    limit: input.batchSize,
  });
  for (const claim of scans) {
    try {
      const source = await input.store.getExact({
        objectKey: claim.sourceObjectKey,
        versionId: claim.sourceObjectVersion,
        etag: claim.sourceEtag,
      });
      if (
        source.body.byteLength !== claim.declaredByteSize ||
        source.contentType !== claim.declaredContentType
      ) {
        throw new Error('COMMUNITY_MEDIA_CONTENT_TYPE_MISMATCH');
      }
      const prepared = await prepareCommunityMedia({
        body: source.body,
        declaredContentType: claim.declaredContentType,
        scanner: input.scanner,
      });
      if (prepared.sourceSha256 !== claim.declaredSha256) {
        throw new Error('COMMUNITY_MEDIA_SOURCE_CHECKSUM_MISMATCH');
      }
      const [thumbnail, feed] = await Promise.all([
        input.store.putReady({
          objectKey: communityMediaVariantObjectKey({
            tenantId: input.tenantId,
            communityId: claim.communityId,
            mediaId: claim.mediaId,
            variant: 'thumbnail',
            sha256: prepared.thumbnail.sha256,
          }),
          body: prepared.thumbnail.body,
          sha256: prepared.thumbnail.sha256,
        }),
        input.store.putReady({
          objectKey: communityMediaVariantObjectKey({
            tenantId: input.tenantId,
            communityId: claim.communityId,
            mediaId: claim.mediaId,
            variant: 'feed',
            sha256: prepared.feed.sha256,
          }),
          body: prepared.feed.body,
          sha256: prepared.feed.sha256,
        }),
      ]);
      const outcome = await input.repository.completeScan({
        tenantId: input.tenantId,
        mediaId: claim.mediaId,
        leaseOwner: input.workerId,
        computedSourceSha256: prepared.sourceSha256,
        variants: [
          {
            variant: 'THUMBNAIL',
            objectKey: thumbnail.objectKey,
            objectVersion: thumbnail.versionId,
            objectEtag: thumbnail.etag,
            sha256: thumbnail.sha256,
            byteSize: thumbnail.sizeBytes,
            width: thumbnail.width,
            height: thumbnail.height,
          },
          {
            variant: 'FEED',
            objectKey: feed.objectKey,
            objectVersion: feed.versionId,
            objectEtag: feed.etag,
            sha256: feed.sha256,
            byteSize: feed.sizeBytes,
            width: feed.width,
            height: feed.height,
          },
        ],
        correlationId,
      });
      if (outcome === 'ready' || outcome === 'already_ready') scanned += 1;
    } catch (error) {
      const code = errorCode(error);
      const rejectionCode =
        code === 'COMMUNITY_MEDIA_SOURCE_CHECKSUM_MISMATCH'
          ? 'SOURCE_CHECKSUM_MISMATCH'
          : permanentRejections.get(code);
      if (rejectionCode) {
        const outcome = await input.repository.rejectScan({
          tenantId: input.tenantId,
          mediaId: claim.mediaId,
          leaseOwner: input.workerId,
          rejectionCode,
          correlationId,
        });
        if (outcome === 'rejected' || outcome === 'already_rejected') rejected += 1;
      } else {
        if (claim.scanAttempt >= (input.scanMaxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
          if (
            await input.repository.failScan({
              tenantId: input.tenantId,
              mediaId: claim.mediaId,
              leaseOwner: input.workerId,
              errorCode: code,
            })
          ) {
            scanFailed += 1;
          }
        } else {
          if (
            await input.repository.releaseScan({
              tenantId: input.tenantId,
              mediaId: claim.mediaId,
              leaseOwner: input.workerId,
              retryAt: retryAt(claim.scanAttempt),
              errorCode: code,
            })
          ) {
            scanRetried += 1;
          }
        }
      }
    }
  }

  let gcCompleted = 0;
  let gcRetried = 0;
  let gcDead = 0;
  const gcClaims = await input.repository.claimGc({
    tenantId: input.tenantId,
    leaseOwner: input.workerId,
    leaseSeconds: GC_LEASE_SECONDS,
    limit: input.batchSize,
  });
  for (const claim of gcClaims) {
    try {
      await input.store.deleteExact({
        objectKey: claim.objectKey,
        versionId: claim.objectVersion,
      });
      if (
        await input.repository.completeGc({
          tenantId: input.tenantId,
          jobId: claim.jobId,
          leaseOwner: input.workerId,
          correlationId,
        })
      ) {
        gcCompleted += 1;
      }
    } catch (error) {
      const code = errorCode(error);
      if (claim.attempt >= (input.gcMaxAttempts ?? DEFAULT_MAX_ATTEMPTS)) {
        if (
          await input.repository.deadLetterGc({
            tenantId: input.tenantId,
            jobId: claim.jobId,
            leaseOwner: input.workerId,
            errorCode: code,
          })
        ) {
          gcDead += 1;
        }
      } else if (
        await input.repository.failGc({
          tenantId: input.tenantId,
          jobId: claim.jobId,
          leaseOwner: input.workerId,
          retryAt: retryAt(claim.attempt),
          errorCode: code,
        })
      ) {
        gcRetried += 1;
      }
    }
  }

  return {
    expired: expired.length,
    scanned,
    rejected,
    scanRetried,
    scanFailed,
    gcCompleted,
    gcRetried,
    gcDead,
  };
}
