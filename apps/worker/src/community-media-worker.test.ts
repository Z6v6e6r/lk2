import { createHash } from 'node:crypto';

import type { CommunityMediaPersistenceRepository } from '@phub/database';
import type { Logger } from 'pino';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';

import {
  MockCommunityMediaMalwareScanner,
  type CommunityMediaWorkerObjectStore,
} from './community-media-processing.js';
import { runCommunityMediaCycle } from './community-media-worker.js';

const tenantId = '2a64dfc9-cc77-4215-a0f1-cec5192e3562';
const mediaId = '4aa6ff6b-2e86-48da-a80f-d3d8245551a7';

function repository(overrides: Partial<CommunityMediaPersistenceRepository> = {}) {
  return {
    expireDue: vi.fn().mockResolvedValue([]),
    scheduleExpiredSourceVersion: vi.fn().mockResolvedValue(true),
    confirmExpiredSourceAbsent: vi.fn().mockResolvedValue(true),
    claimScans: vi.fn().mockResolvedValue([]),
    completeScan: vi.fn().mockResolvedValue('ready'),
    rejectScan: vi.fn().mockResolvedValue('rejected'),
    releaseScan: vi.fn().mockResolvedValue(true),
    failScan: vi.fn().mockResolvedValue(true),
    claimGc: vi.fn().mockResolvedValue([]),
    completeGc: vi.fn().mockResolvedValue(true),
    failGc: vi.fn().mockResolvedValue(true),
    deadLetterGc: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as CommunityMediaPersistenceRepository;
}

function logger(): Logger {
  return { warn: vi.fn(), info: vi.fn() } as unknown as Logger;
}

describe('community media worker cycle', () => {
  it('processes exact source versions, deterministic variants, expiry discovery and GC', async () => {
    const source = await sharp({
      create: { width: 16, height: 12, channels: 3, background: '#cda566' },
    })
      .webp()
      .toBuffer();
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    const scheduleExpiredSourceVersion = vi.fn().mockResolvedValue(true);
    const completeScan = vi.fn().mockResolvedValue('ready');
    const repo = repository({
      expireDue: vi.fn().mockResolvedValue([{ mediaId, sourceObjectKey: 'quarantine/source' }]),
      claimScans: vi.fn().mockResolvedValue([
        {
          mediaId,
          communityId: '098486ab-5a42-43be-9188-6a43908af97c',
          sourceObjectKey: 'quarantine/source',
          sourceObjectVersion: 'source-v1',
          sourceEtag: 'source-etag',
          declaredContentType: 'image/webp',
          declaredByteSize: source.byteLength,
          declaredSha256: sourceSha256,
          scanAttempt: 1,
        },
      ]),
      claimGc: vi.fn().mockResolvedValue([
        {
          jobId: 'f4356605-2766-4e1d-9e98-e9ace44ed324',
          mediaId,
          objectKind: 'SOURCE',
          objectKey: 'quarantine/source',
          objectVersion: 'source-v1',
          attempt: 1,
        },
      ]),
      scheduleExpiredSourceVersion,
      completeScan,
    });
    const deleteExact = vi.fn().mockResolvedValue(undefined);
    const putReady = vi
      .fn()
      .mockImplementation(
        (variant: { readonly objectKey: string; readonly body: Buffer; readonly sha256: string }) =>
          Promise.resolve({
            objectKey: variant.objectKey,
            versionId: `${variant.objectKey}-v1`,
            etag: `${variant.objectKey}-etag`,
            sha256: variant.sha256,
            sizeBytes: variant.body.byteLength,
            width: 16,
            height: 12,
          }),
      );
    const store = {
      currentVersion: vi.fn().mockResolvedValue('late-source-v2'),
      getExact: vi.fn().mockResolvedValue({ body: source, contentType: 'image/webp' }),
      putReady,
      deleteExact,
    } as CommunityMediaWorkerObjectStore;

    await expect(
      runCommunityMediaCycle({
        repository: repo,
        store,
        scanner: new MockCommunityMediaMalwareScanner(),
        logger: logger(),
        tenantId,
        workerId: 'media-worker-1',
        batchSize: 10,
      }),
    ).resolves.toEqual({
      expired: 1,
      scanned: 1,
      rejected: 0,
      scanRetried: 0,
      scanFailed: 0,
      gcCompleted: 1,
      gcRetried: 0,
      gcDead: 0,
    });
    expect(scheduleExpiredSourceVersion).toHaveBeenCalledWith({
      tenantId,
      mediaId,
      objectVersion: 'late-source-v2',
    });
    expect(completeScan).toHaveBeenCalledWith(
      expect.objectContaining({
        computedSourceSha256: sourceSha256,
      }),
    );
    expect(JSON.stringify(completeScan.mock.calls)).toContain('"variant":"THUMBNAIL"');
    expect(JSON.stringify(completeScan.mock.calls)).toContain('"variant":"FEED"');
    const variantKeys = putReady.mock.calls.map(
      ([value]) => (value as { readonly objectKey: string }).objectKey,
    );
    expect(variantKeys).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          new RegExp(
            `^community-media/ready/${tenantId}/098486ab-5a42-43be-9188-6a43908af97c/${mediaId}/thumbnail/[0-9a-f]{64}\\.webp$`,
          ),
        ),
        expect.stringMatching(
          new RegExp(
            `^community-media/ready/${tenantId}/098486ab-5a42-43be-9188-6a43908af97c/${mediaId}/feed/[0-9a-f]{64}\\.webp$`,
          ),
        ),
      ]),
    );
    expect(deleteExact).toHaveBeenCalledWith({
      objectKey: 'quarantine/source',
      versionId: 'source-v1',
    });
  });

  it('rejects a permanently invalid image instead of retrying forever', async () => {
    const source = Buffer.from('not-an-image');
    const rejectScan = vi.fn().mockResolvedValue('rejected');
    const releaseScan = vi.fn().mockResolvedValue(true);
    const repo = repository({
      claimScans: vi.fn().mockResolvedValue([
        {
          mediaId,
          communityId: '098486ab-5a42-43be-9188-6a43908af97c',
          sourceObjectKey: 'quarantine/source',
          sourceObjectVersion: 'source-v1',
          sourceEtag: 'source-etag',
          declaredContentType: 'image/webp',
          declaredByteSize: source.byteLength,
          declaredSha256: createHash('sha256').update(source).digest('hex'),
          scanAttempt: 1,
        },
      ]),
      rejectScan,
      releaseScan,
    });
    const store = {
      currentVersion: vi.fn(),
      getExact: vi.fn().mockResolvedValue({ body: source, contentType: 'image/webp' }),
      putReady: vi.fn(),
      deleteExact: vi.fn(),
    } as CommunityMediaWorkerObjectStore;

    const result = await runCommunityMediaCycle({
      repository: repo,
      store,
      scanner: new MockCommunityMediaMalwareScanner(),
      logger: logger(),
      tenantId,
      workerId: 'media-worker-1',
      batchSize: 10,
    });

    expect(result.rejected).toBe(1);
    expect(rejectScan).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId, rejectionCode: 'IMAGE_INVALID' }),
    );
    expect(releaseScan).not.toHaveBeenCalled();
  });

  it('discovers absent expired sources, skips known versions and defers storage failures', async () => {
    const confirmExpiredSourceAbsent = vi.fn().mockResolvedValue(true);
    const log = logger();
    const repo = repository({
      expireDue: vi.fn().mockResolvedValue([
        { mediaId: 'known-version', sourceObjectKey: 'known', sourceObjectVersion: 'v1' },
        { mediaId: 'absent-version', sourceObjectKey: 'absent' },
        { mediaId: 'failed-discovery', sourceObjectKey: 'failed' },
      ]),
      confirmExpiredSourceAbsent,
    });
    const currentVersion = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('storage unavailable'));
    const result = await runCommunityMediaCycle({
      repository: repo,
      store: {
        currentVersion,
        getExact: vi.fn(),
        putReady: vi.fn(),
        deleteExact: vi.fn(),
      },
      scanner: new MockCommunityMediaMalwareScanner(),
      logger: log,
      tenantId,
      workerId: 'media-worker-1',
      batchSize: 10,
    });

    expect(result.expired).toBe(3);
    expect(currentVersion).toHaveBeenCalledTimes(2);
    expect(confirmExpiredSourceAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId: 'absent-version' }),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId: 'failed-discovery' }),
      'community media expired-source discovery deferred',
    );
  });

  it('maps permanent source failures to rejection and transient failures to bounded retry', async () => {
    const source = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#123456' },
    })
      .webp()
      .toBuffer();
    const validSha = createHash('sha256').update(source).digest('hex');
    const claims = [
      {
        mediaId: '00000000-0000-4000-8000-000000000001',
        sourceObjectKey: 'wrong-size',
        sourceObjectVersion: 'v1',
        sourceEtag: 'etag-1',
        declaredContentType: 'image/webp',
        declaredByteSize: source.byteLength + 1,
        declaredSha256: validSha,
        scanAttempt: 1,
      },
      {
        mediaId: '00000000-0000-4000-8000-000000000002',
        sourceObjectKey: 'wrong-checksum',
        sourceObjectVersion: 'v1',
        sourceEtag: 'etag-2',
        declaredContentType: 'image/webp',
        declaredByteSize: source.byteLength,
        declaredSha256: '0'.repeat(64),
        scanAttempt: 2,
      },
      {
        mediaId: '00000000-0000-4000-8000-000000000003',
        sourceObjectKey: 'lowercase-transient',
        sourceObjectVersion: 'v1',
        sourceEtag: 'etag-3',
        declaredContentType: 'image/webp',
        declaredByteSize: source.byteLength,
        declaredSha256: validSha,
        scanAttempt: 3,
      },
      {
        mediaId: '00000000-0000-4000-8000-000000000004',
        sourceObjectKey: 'coded-transient',
        sourceObjectVersion: 'v1',
        sourceEtag: 'etag-4',
        declaredContentType: 'image/webp',
        declaredByteSize: source.byteLength,
        declaredSha256: validSha,
        scanAttempt: 4,
      },
    ];
    const rejectScan = vi
      .fn()
      .mockResolvedValueOnce('already_rejected')
      .mockResolvedValueOnce('lease_lost');
    const releaseScan = vi.fn().mockResolvedValue(true);
    const repo = repository({
      claimScans: vi.fn().mockResolvedValue(claims),
      rejectScan,
      releaseScan,
    });
    const getExact = vi.fn(({ objectKey }: { readonly objectKey: string }) => {
      if (objectKey === 'lowercase-transient')
        return Promise.reject(new Error('storage unavailable'));
      if (objectKey === 'coded-transient') {
        return Promise.reject(new Error('COMMUNITY_MEDIA_SCAN_UNAVAILABLE'));
      }
      return Promise.resolve({ body: source, contentType: 'image/webp' });
    });
    const result = await runCommunityMediaCycle({
      repository: repo,
      store: { currentVersion: vi.fn(), getExact, putReady: vi.fn(), deleteExact: vi.fn() },
      scanner: new MockCommunityMediaMalwareScanner(),
      logger: logger(),
      tenantId,
      workerId: 'media-worker-1',
      batchSize: 10,
    });

    expect(result).toMatchObject({ rejected: 1, scanRetried: 2 });
    expect(rejectScan).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ rejectionCode: 'CONTENT_TYPE_MISMATCH' }),
    );
    expect(rejectScan).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ rejectionCode: 'SOURCE_CHECKSUM_MISMATCH' }),
    );
    expect(releaseScan).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ errorCode: 'COMMUNITY_MEDIA_TRANSIENT_FAILURE' }),
    );
    expect(releaseScan).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ errorCode: 'COMMUNITY_MEDIA_SCAN_UNAVAILABLE' }),
    );
    for (const [call] of releaseScan.mock.calls) {
      const release = call as unknown as { readonly retryAt: string };
      expect(Date.parse(release.retryAt)).toBeGreaterThan(Date.now());
    }
  });

  it('counts already-ready scans and distinguishes completed GC from retryable failures', async () => {
    const source = await sharp({
      create: { width: 6, height: 4, channels: 3, background: '#abcdef' },
    })
      .webp()
      .toBuffer();
    const sourceSha256 = createHash('sha256').update(source).digest('hex');
    const failGc = vi.fn().mockResolvedValue(true);
    const repo = repository({
      claimScans: vi.fn().mockResolvedValue([
        {
          mediaId,
          sourceObjectKey: 'source',
          sourceObjectVersion: 'v1',
          sourceEtag: 'etag',
          declaredContentType: 'image/webp',
          declaredByteSize: source.byteLength,
          declaredSha256: sourceSha256,
          scanAttempt: 1,
        },
      ]),
      completeScan: vi.fn().mockResolvedValue('already_ready'),
      claimGc: vi.fn().mockResolvedValue([
        { jobId: 'gc-not-completed', objectKey: 'ready', objectVersion: 'v1', attempt: 1 },
        { jobId: 'gc-coded-failure', objectKey: 'coded-failure', objectVersion: 'v2', attempt: 2 },
        {
          jobId: 'gc-unknown-failure',
          objectKey: 'unknown-failure',
          objectVersion: 'v3',
          attempt: 3,
        },
      ]),
      completeGc: vi.fn().mockResolvedValue(false),
      failGc,
    });
    const putReady = vi.fn(
      ({ objectKey, body, sha256 }: { objectKey: string; body: Buffer; sha256: string }) =>
        Promise.resolve({
          objectKey,
          versionId: 'ready-v1',
          etag: 'ready-etag',
          sha256,
          sizeBytes: body.byteLength,
          width: 6,
          height: 4,
        }),
    );
    const deleteExact = vi.fn(({ objectKey }: { objectKey: string }) => {
      if (objectKey === 'coded-failure')
        return Promise.reject(new Error('COMMUNITY_MEDIA_DELETE_FAILED'));
      if (objectKey === 'unknown-failure') return Promise.reject(new Error('network reset'));
      return Promise.resolve();
    });
    const result = await runCommunityMediaCycle({
      repository: repo,
      store: {
        currentVersion: vi.fn(),
        getExact: vi.fn().mockResolvedValue({ body: source, contentType: 'image/webp' }),
        putReady,
        deleteExact,
      },
      scanner: new MockCommunityMediaMalwareScanner(),
      logger: logger(),
      tenantId,
      workerId: 'media-worker-1',
      batchSize: 10,
    });

    expect(result).toMatchObject({ scanned: 1, gcCompleted: 0, gcRetried: 2 });
    expect(failGc).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ errorCode: 'COMMUNITY_MEDIA_DELETE_FAILED' }),
    );
    expect(failGc).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ errorCode: 'COMMUNITY_MEDIA_TRANSIENT_FAILURE' }),
    );
  });

  it('terminalizes scan and GC work after the configured bounded attempt count', async () => {
    const failScan = vi.fn().mockResolvedValue(true);
    const deadLetterGc = vi.fn().mockResolvedValue(true);
    const releaseScan = vi.fn().mockResolvedValue(true);
    const failGc = vi.fn().mockResolvedValue(true);
    const repo = repository({
      claimScans: vi.fn().mockResolvedValue([
        {
          mediaId,
          communityId: '098486ab-5a42-43be-9188-6a43908af97c',
          sourceObjectKey: 'source',
          sourceObjectVersion: 'v1',
          sourceEtag: 'etag',
          declaredContentType: 'image/webp',
          declaredByteSize: 1,
          declaredSha256: 'a'.repeat(64),
          scanAttempt: 3,
        },
      ]),
      claimGc: vi.fn().mockResolvedValue([
        {
          jobId: '00000000-0000-4000-8000-000000000099',
          objectKey: 'source',
          objectVersion: 'v1',
          attempt: 3,
        },
      ]),
      failScan,
      deadLetterGc,
      releaseScan,
      failGc,
    });
    const store = {
      currentVersion: vi.fn(),
      getExact: vi.fn().mockRejectedValue(new Error('COMMUNITY_MEDIA_SCAN_UNAVAILABLE')),
      putReady: vi.fn(),
      deleteExact: vi.fn().mockRejectedValue(new Error('COMMUNITY_MEDIA_DELETE_FAILED')),
    } as CommunityMediaWorkerObjectStore;

    const result = await runCommunityMediaCycle({
      repository: repo,
      store,
      scanner: new MockCommunityMediaMalwareScanner(),
      logger: logger(),
      tenantId,
      workerId: 'media-worker-1',
      batchSize: 10,
      scanMaxAttempts: 3,
      gcMaxAttempts: 3,
    });

    expect(result).toMatchObject({ scanFailed: 1, gcDead: 1, scanRetried: 0, gcRetried: 0 });
    expect(failScan).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'COMMUNITY_MEDIA_SCAN_UNAVAILABLE' }),
    );
    expect(deadLetterGc).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'COMMUNITY_MEDIA_DELETE_FAILED' }),
    );
    expect(releaseScan).not.toHaveBeenCalled();
    expect(failGc).not.toHaveBeenCalled();
  });
});
