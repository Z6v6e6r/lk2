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
    claimGc: vi.fn().mockResolvedValue([]),
    completeGc: vi.fn().mockResolvedValue(true),
    failGc: vi.fn().mockResolvedValue(true),
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
    const store = {
      currentVersion: vi.fn().mockResolvedValue('late-source-v2'),
      getExact: vi.fn().mockResolvedValue({ body: source, contentType: 'image/webp' }),
      putReady: vi
        .fn()
        .mockImplementation(
          (variant: {
            readonly objectKey: string;
            readonly body: Buffer;
            readonly sha256: string;
          }) =>
            Promise.resolve({
              objectKey: variant.objectKey,
              versionId: `${variant.objectKey}-v1`,
              etag: `${variant.objectKey}-etag`,
              sha256: variant.sha256,
              sizeBytes: variant.body.byteLength,
              width: 16,
              height: 12,
            }),
        ),
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
      gcCompleted: 1,
      gcRetried: 0,
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
});
