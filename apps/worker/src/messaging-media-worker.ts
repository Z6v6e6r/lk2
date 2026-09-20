import { randomUUID } from 'node:crypto';

import type { MessagingMediaRepository } from '@phub/database';
import { messagingMediaObjectKey } from '@phub/database';
import type { Logger } from 'pino';

import {
  ClamAvCommunityMediaMalwareScanner,
  MockCommunityMediaMalwareScanner,
  type CommunityMediaMalwareScanner,
} from './community-media-processing.js';
import {
  inspectMessagingMediaSource,
  isPermanentMessagingMediaSourceFailure,
  type MessagingMediaWorkerObjectStore,
} from './messaging-media-processing.js';

const SCAN_LEASE_SECONDS = 300;
const GC_LEASE_SECONDS = 300;
const DEFAULT_SCAN_MAX_ATTEMPTS = 8;
const DEFAULT_GC_MAX_ATTEMPTS = 8;
const UNKNOWN_FAILURE_CODE = 'MESSAGING_MEDIA_TRANSIENT_FAILURE';

export interface MessagingMediaScanOutcome {
  readonly outcome: 'clean' | 'infected';
  readonly signature?: string;
}

/** The scanner contract chat media needs, so a fake or the reused ClamAV client both fit. */
export interface MessagingMediaMalwareScanner {
  checkReady?(): Promise<void>;
  scan(body: Buffer): Promise<MessagingMediaScanOutcome>;
}

/**
 * Reuses the community media ClamAV client verbatim and only translates its error codes. Chat media
 * stays a separate pipeline with its own stable codes, so a failure here never reads as a community
 * media failure in logs or metrics.
 */
export class MessagingMediaCommunityScannerAdapter implements MessagingMediaMalwareScanner {
  public constructor(private readonly scanner: CommunityMediaMalwareScanner) {}

  public checkReady(): Promise<void> {
    return this.scanner.checkReady?.() ?? Promise.resolve();
  }

  public async scan(body: Buffer): Promise<MessagingMediaScanOutcome> {
    try {
      const result = await this.scanner.scan(body);
      return result.outcome === 'infected'
        ? { outcome: 'infected', signature: result.signature }
        : { outcome: 'clean' };
    } catch (error) {
      const mapped = mapScanErrorCode(error);
      // Keep the original scanner error attached so an operator can see why the code was rewritten.
      if (error instanceof Error && mapped === error.message) throw error;
      throw new Error(mapped, { cause: error });
    }
  }
}

export function createMessagingMediaScanner(input: {
  readonly scanMode: 'mock' | 'clamav';
  readonly clamavHost?: string;
  readonly clamavPort: number;
  readonly clamavTimeoutMs: number;
}): MessagingMediaMalwareScanner {
  if (input.scanMode === 'clamav') {
    return new MessagingMediaCommunityScannerAdapter(
      new ClamAvCommunityMediaMalwareScanner({
        host: input.clamavHost as string,
        port: input.clamavPort,
        timeoutMs: input.clamavTimeoutMs,
      }),
    );
  }
  return new MessagingMediaCommunityScannerAdapter(new MockCommunityMediaMalwareScanner());
}

function errorCodeName(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.message)) {
    return error.message.slice(0, 64);
  }
  return UNKNOWN_FAILURE_CODE;
}

function mapScanErrorCode(error: unknown): string {
  const raw = errorCodeName(error);
  if (raw === UNKNOWN_FAILURE_CODE) return raw;
  return raw.startsWith('COMMUNITY_MEDIA_')
    ? `MESSAGING_MEDIA_${raw.slice('COMMUNITY_MEDIA_'.length)}`
    : raw;
}

/**
 * The stable rejection code stored on the asset. It is deliberately coarser than the internal
 * failure code: a reader only has to distinguish what, if anything, the uploader can fix.
 */
function sourceRejectionCode(error: unknown): string {
  const raw = errorCodeName(error);
  if (raw === 'MESSAGING_MEDIA_SOURCE_CHECKSUM_MISMATCH') return 'SOURCE_CHECKSUM_MISMATCH';
  if (raw === 'MESSAGING_MEDIA_CONTENT_TYPE_MISMATCH') return 'CONTENT_TYPE_MISMATCH';
  if (raw === 'MESSAGING_MEDIA_SOURCE_SIZE_MISMATCH') return 'SOURCE_SIZE_MISMATCH';
  if (raw === 'MESSAGING_MEDIA_SOURCE_BODY_MISSING') return 'SOURCE_SIZE_MISMATCH';
  if (raw === 'MESSAGING_MEDIA_SOURCE_TOO_LARGE') return 'SOURCE_TOO_LARGE';
  return 'SOURCE_INVALID';
}

function isMissingObjectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'NoSuchVersion' || error.name === 'NoSuchKey') return true;
  if (!('$metadata' in error)) return false;
  const metadata = (error as { readonly $metadata?: { readonly httpStatusCode?: number } })
    .$metadata;
  return metadata?.httpStatusCode === 404;
}

function retryAt(attempt: number): Date {
  const delayMs = Math.min(300_000, 2_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 7));
  return new Date(Date.now() + delayMs);
}

export interface MessagingMediaCycleResult {
  readonly expired: number;
  readonly scanned: number;
  readonly rejected: number;
  readonly scanRetried: number;
  readonly scanFailed: number;
  readonly gcCompleted: number;
  readonly gcRetried: number;
  readonly gcDead: number;
}

export async function runMessagingMediaCycle(input: {
  readonly repository: MessagingMediaRepository;
  readonly store: MessagingMediaWorkerObjectStore;
  readonly scanner: MessagingMediaMalwareScanner;
  readonly logger: Logger;
  readonly tenantId: string;
  readonly workerId: string;
  readonly batchSize: number;
  readonly scanMaxAttempts?: number;
  readonly gcMaxAttempts?: number;
}): Promise<MessagingMediaCycleResult> {
  const correlationId = randomUUID();
  const scanMaxAttempts = input.scanMaxAttempts ?? DEFAULT_SCAN_MAX_ATTEMPTS;
  const gcMaxAttempts = input.gcMaxAttempts ?? DEFAULT_GC_MAX_ATTEMPTS;
  const logWarning = (error: unknown, message: string, mediaId?: string): void => {
    input.logger.warn(
      { error, tenantId: input.tenantId, ...(mediaId ? { mediaId } : {}) },
      message,
    );
  };

  // Expiry scheduled the exact SOURCE and READY versions for every asset whose version was already
  // known. An abandoned upload never reached finalize, so its version is discovered here by key and
  // recorded for exact deletion; otherwise the quarantine object would outlive the asset forever.
  let expiredMediaIds: readonly string[] = [];
  let expired = 0;
  try {
    const due = await input.repository.expireDue({
      tenantId: input.tenantId,
      limit: input.batchSize,
      correlationId,
    });
    expiredMediaIds = due.map((media) => media.mediaId);
    expired = due.length;
    for (const media of due) {
      if (media.objectVersion !== null) continue;
      try {
        const version = await input.store.currentVersion(media.objectKey);
        if (!version) continue;
        await input.repository.scheduleExpiredSourceVersion({
          tenantId: input.tenantId,
          mediaId: media.mediaId,
          objectVersion: version,
        });
      } catch (error) {
        // The object stays scheduled for the next cycle; the asset is not confirmed PURGED while a
        // deletion is still outstanding.
        logWarning(error, 'messaging media expired source discovery deferred', media.mediaId);
      }
    }
  } catch (error) {
    logWarning(error, 'messaging media expiry deferred');
  }

  let scanned = 0;
  let rejected = 0;
  let scanRetried = 0;
  let scanFailed = 0;

  const rejectPermanently = async (mediaId: string, rejectionCode: string): Promise<void> => {
    try {
      const outcome = await input.repository.rejectScan({
        tenantId: input.tenantId,
        leaseOwner: input.workerId,
        mediaId,
        rejectionCode,
        correlationId,
      });
      if (outcome === 'rejected') rejected += 1;
    } catch (error) {
      logWarning(error, 'messaging media rejection deferred', mediaId);
    }
  };

  const retryOrTerminateScan = async (
    mediaId: string,
    attempt: number,
    failureCode: string,
  ): Promise<void> => {
    try {
      if (attempt < scanMaxAttempts) {
        await input.repository.releaseScan({
          tenantId: input.tenantId,
          leaseOwner: input.workerId,
          mediaId,
          failureCode,
          availableAt: retryAt(attempt),
        });
        scanRetried += 1;
        return;
      }
      const outcome = await input.repository.failScan({
        tenantId: input.tenantId,
        leaseOwner: input.workerId,
        mediaId,
        failureCode,
        correlationId,
      });
      if (outcome === 'rejected') {
        scanFailed += 1;
        rejected += 1;
      }
    } catch (error) {
      logWarning(error, 'messaging media scan retry deferred', mediaId);
    }
  };

  let scans: Awaited<ReturnType<MessagingMediaRepository['claimScans']>> = [];
  try {
    scans = await input.repository.claimScans({
      tenantId: input.tenantId,
      leaseOwner: input.workerId,
      leaseSeconds: SCAN_LEASE_SECONDS,
      limit: input.batchSize,
    });
  } catch (error) {
    logWarning(error, 'messaging media scan claim deferred');
  }

  for (const claim of scans) {
    try {
      const source = await input.store.getExact({
        objectKey: claim.objectKey,
        versionId: claim.objectVersion,
        etag: claim.etag,
      });
      const sha256 = inspectMessagingMediaSource({
        body: source.body,
        declaredContentType: claim.declaredContentType,
        declaredByteSize: claim.declaredByteSize,
        expectedSha256: claim.declaredSha256,
      });
      const scan = await input.scanner.scan(source.body);
      if (scan.outcome === 'infected') {
        await rejectPermanently(claim.mediaId, 'MALWARE_DETECTED');
        continue;
      }
      const readyObjectKey = `${
        messagingMediaObjectKey({
          tenantId: input.tenantId,
          conversationId: claim.conversationId,
          mediaId: claim.mediaId,
        }).readyPrefix
      }/content`;
      const stored = await input.store.putReady({
        objectKey: readyObjectKey,
        body: source.body,
        contentType: claim.declaredContentType,
        sha256,
      });
      const outcome = await input.repository.completeScan({
        tenantId: input.tenantId,
        leaseOwner: input.workerId,
        mediaId: claim.mediaId,
        readyObjectKey: stored.objectKey,
        readyObjectVersion: stored.versionId,
        correlationId,
      });
      if (outcome === 'ready') scanned += 1;
    } catch (error) {
      if (isPermanentMessagingMediaSourceFailure(error)) {
        await rejectPermanently(claim.mediaId, sourceRejectionCode(error));
        continue;
      }
      await retryOrTerminateScan(claim.mediaId, claim.attempt, mapScanErrorCode(error));
    }
  }

  let gcCompleted = 0;
  let gcRetried = 0;
  let gcDead = 0;

  const gcFailed = async (jobId: string, attempt: number, failureCode: string): Promise<void> => {
    try {
      if (attempt < gcMaxAttempts) {
        await input.repository.failGc({
          tenantId: input.tenantId,
          leaseOwner: input.workerId,
          jobId,
          failureCode,
          availableAt: retryAt(attempt),
        });
        gcRetried += 1;
        return;
      }
      await input.repository.deadLetterGc({
        tenantId: input.tenantId,
        leaseOwner: input.workerId,
        jobId,
        failureCode,
      });
      gcDead += 1;
    } catch (error) {
      logWarning(error, 'messaging media GC retry deferred');
    }
  };

  let gcClaims: Awaited<ReturnType<MessagingMediaRepository['claimGc']>> = [];
  try {
    gcClaims = await input.repository.claimGc({
      tenantId: input.tenantId,
      leaseOwner: input.workerId,
      leaseSeconds: GC_LEASE_SECONDS,
      limit: input.batchSize,
    });
  } catch (error) {
    logWarning(error, 'messaging media GC claim deferred');
  }

  for (const claim of gcClaims) {
    try {
      await deleteExactOrIgnoreAbsent(input.store, claim);
      const outcome = await input.repository.completeGc({
        tenantId: input.tenantId,
        leaseOwner: input.workerId,
        jobId: claim.jobId,
      });
      if (outcome === 'deleted') gcCompleted += 1;
    } catch (error) {
      await gcFailed(claim.jobId, claim.attempt, mapScanErrorCode(error));
    }
  }

  for (const mediaId of expiredMediaIds) {
    try {
      await input.repository.confirmExpiredObjectsAbsent({
        tenantId: input.tenantId,
        mediaId,
      });
    } catch (error) {
      logWarning(error, 'messaging media purge confirmation deferred', mediaId);
    }
  }

  return {
    expired,
    scanned,
    rejected,
    scanRetried,
    scanFailed,
    gcCompleted,
    gcRetried,
    gcDead,
  };
}

/**
 * `deleteExact` is the only store call whose absence is not an error: a version that is already gone
 * is the desired end state, so it must still complete the GC job.
 */
async function deleteExactOrIgnoreAbsent(
  store: MessagingMediaWorkerObjectStore,
  claim: { readonly objectKey: string; readonly objectVersion: string },
): Promise<void> {
  try {
    await store.deleteExact({ objectKey: claim.objectKey, versionId: claim.objectVersion });
  } catch (error) {
    if (!isMissingObjectError(error)) throw error;
  }
}
