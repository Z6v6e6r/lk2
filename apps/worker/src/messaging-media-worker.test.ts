import { createHash } from 'node:crypto';

import type { MessagingMediaRepository, MessagingMediaScanClaim } from '@phub/database';
import type { Logger } from 'pino';
import { describe, expect, it, vi, type Mock } from 'vitest';

const instruments = vi.hoisted(() => ({
  add: vi.fn<(name: string, value: number) => void>(),
  record: vi.fn<(name: string, value: number) => void>(),
}));

vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: () => ({
      createGauge: (): { record: () => void } => ({ record: () => undefined }),
      createCounter: (name: string): { add: (value: number) => void } => ({
        add: (value: number): void => instruments.add(name, value),
      }),
      createHistogram: (name: string): { record: (value: number) => void } => ({
        record: (value: number): void => instruments.record(name, value),
      }),
    }),
  },
}));

import {
  inspectMessagingMediaSource,
  type MessagingMediaWorkerObjectStore,
} from './messaging-media-processing.js';
import {
  runMessagingMediaCycle,
  type MessagingMediaMalwareScanner,
} from './messaging-media-worker.js';
import { createWorkerMetricRecorder, WORKER_METRIC_INSTRUMENTS } from './operational-metrics.js';

const tenantId = '2a64dfc9-cc77-4215-a0f1-cec5192e3562';
const mediaId = '4aa6ff6b-2e86-48da-a80f-d3d8245551a7';
const conversationId = '098486ab-5a42-43be-9188-6a43908af97c';
const readyPrefix = `chat-media/ready/${tenantId}/${conversationId}/${mediaId}`;

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/** A structurally valid PNG header followed by arbitrary payload bytes. */
function pngBody(payload = 'payload'): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(payload, 'ascii'),
  ]);
}

function jpegBody(payload = 'payload'): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(payload, 'ascii')]);
}

function webpBody(payload = 'payload'): Buffer {
  const chunk = Buffer.from(payload, 'ascii');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(4 + chunk.byteLength, 0);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), size, Buffer.from('WEBP', 'ascii'), chunk]);
}

function claim(overrides: Partial<MessagingMediaScanClaim> = {}): MessagingMediaScanClaim {
  const body = pngBody();
  return {
    mediaId,
    conversationId,
    uploaderUserId: 'f0f0f0f0-0000-4000-8000-000000000001',
    objectKey: `chat-media/quarantine/${tenantId}/${conversationId}/${mediaId}/source`,
    objectVersion: 'source-v1',
    etag: 'source-etag',
    declaredContentType: 'image/png',
    declaredByteSize: body.byteLength,
    declaredSha256: sha256(body),
    attempt: 1,
    leaseOwner: 'messaging-media-1',
    ...overrides,
  };
}

function repository(overrides: Partial<MessagingMediaRepository> = {}): MessagingMediaRepository {
  return {
    expireDue: vi.fn().mockResolvedValue([]),
    confirmExpiredObjectsAbsent: vi.fn().mockResolvedValue(true),
    claimScans: vi.fn().mockResolvedValue([]),
    completeScan: vi.fn().mockResolvedValue('ready'),
    rejectScan: vi.fn().mockResolvedValue('rejected'),
    releaseScan: vi.fn().mockResolvedValue(undefined),
    failScan: vi.fn().mockResolvedValue('rejected'),
    claimGc: vi.fn().mockResolvedValue([]),
    completeGc: vi.fn().mockResolvedValue('deleted'),
    failGc: vi.fn().mockResolvedValue(undefined),
    deadLetterGc: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as MessagingMediaRepository;
}

function store(overrides: Partial<MessagingMediaWorkerObjectStore> = {}): {
  readonly store: MessagingMediaWorkerObjectStore;
  readonly putReady: Mock<MessagingMediaWorkerObjectStore['putReady']>;
  readonly deleteExact: Mock<MessagingMediaWorkerObjectStore['deleteExact']>;
} {
  const putReady = vi.fn<MessagingMediaWorkerObjectStore['putReady']>();
  putReady.mockImplementation((input) =>
    Promise.resolve({
      objectKey: input.objectKey,
      versionId: 'ready-v1',
      etag: 'ready-etag',
    }),
  );
  const deleteExact = vi.fn<MessagingMediaWorkerObjectStore['deleteExact']>();
  deleteExact.mockResolvedValue(undefined);
  return {
    putReady,
    deleteExact,
    store: {
      checkReady: vi.fn().mockResolvedValue(undefined),
      getExact: vi.fn().mockResolvedValue({ body: pngBody(), contentType: 'image/png' }),
      putReady,
      deleteExact,
      currentVersion: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
  };
}

function cleanScanner(): MessagingMediaMalwareScanner {
  return { scan: vi.fn().mockResolvedValue({ outcome: 'clean' }) };
}

function logger(): Logger {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function run(input: {
  readonly repository: MessagingMediaRepository;
  readonly store: MessagingMediaWorkerObjectStore;
  readonly scanner?: MessagingMediaMalwareScanner;
  readonly logger?: Logger;
  readonly scanMaxAttempts?: number;
  readonly gcMaxAttempts?: number;
}) {
  return runMessagingMediaCycle({
    repository: input.repository,
    store: input.store,
    scanner: input.scanner ?? cleanScanner(),
    logger: input.logger ?? logger(),
    tenantId,
    workerId: 'messaging-media-1',
    batchSize: 10,
    ...(input.scanMaxAttempts === undefined ? {} : { scanMaxAttempts: input.scanMaxAttempts }),
    ...(input.gcMaxAttempts === undefined ? {} : { gcMaxAttempts: input.gcMaxAttempts }),
  });
}

describe('inspectMessagingMediaSource', () => {
  it('returns the lowercase sha256 for a structurally valid image', () => {
    const body = pngBody();
    expect(
      inspectMessagingMediaSource({
        body,
        declaredContentType: 'image/png',
        declaredByteSize: body.byteLength,
        expectedSha256: sha256(body).toUpperCase(),
      }),
    ).toBe(sha256(body));
  });

  it('accepts the JPEG and WebP magic byte sequences', () => {
    for (const [contentType, body] of [
      ['image/jpeg', jpegBody()],
      ['image/webp', webpBody()],
    ] as const) {
      expect(
        inspectMessagingMediaSource({
          body,
          declaredContentType: contentType,
          declaredByteSize: body.byteLength,
          expectedSha256: sha256(body),
        }),
      ).toBe(sha256(body));
    }
  });

  it('does not sniff a non-image content type', () => {
    const body = Buffer.from('%PDF-1.7 not really an image', 'ascii');
    expect(
      inspectMessagingMediaSource({
        body,
        declaredContentType: 'application/pdf',
        declaredByteSize: body.byteLength,
        expectedSha256: sha256(body),
      }),
    ).toBe(sha256(body));
  });

  it('rejects an empty body, an oversized body and a checksum mismatch', () => {
    const body = pngBody();
    expect(() =>
      inspectMessagingMediaSource({
        body: Buffer.alloc(0),
        declaredContentType: 'image/png',
        declaredByteSize: 0,
        expectedSha256: sha256(Buffer.alloc(0)),
      }),
    ).toThrow('MESSAGING_MEDIA_SOURCE_SIZE_MISMATCH');
    expect(() =>
      inspectMessagingMediaSource({
        body: Buffer.concat([pngBody(), Buffer.alloc(15 * 1024 * 1024)]),
        declaredContentType: 'image/png',
        declaredByteSize: 15 * 1024 * 1024 + pngBody().byteLength,
        expectedSha256: sha256(body),
      }),
    ).toThrow('MESSAGING_MEDIA_SOURCE_SIZE_MISMATCH');
    expect(() =>
      inspectMessagingMediaSource({
        body,
        declaredContentType: 'image/png',
        declaredByteSize: body.byteLength,
        expectedSha256: '0'.repeat(64),
      }),
    ).toThrow('MESSAGING_MEDIA_SOURCE_CHECKSUM_MISMATCH');
  });

  it('rejects a declared byte size that disagrees with the body', () => {
    const body = pngBody();
    expect(() =>
      inspectMessagingMediaSource({
        body,
        declaredContentType: 'image/png',
        declaredByteSize: body.byteLength + 1,
        expectedSha256: sha256(body),
      }),
    ).toThrow('MESSAGING_MEDIA_SOURCE_SIZE_MISMATCH');
  });

  it('rejects image magic bytes that contradict the declared image content type', () => {
    const body = jpegBody();
    expect(() =>
      inspectMessagingMediaSource({
        body,
        declaredContentType: 'image/png',
        declaredByteSize: body.byteLength,
        expectedSha256: sha256(body),
      }),
    ).toThrow('MESSAGING_MEDIA_CONTENT_TYPE_MISMATCH');
    const notAnImage = Buffer.from('not an image at all', 'ascii');
    expect(() =>
      inspectMessagingMediaSource({
        body: notAnImage,
        declaredContentType: 'image/webp',
        declaredByteSize: notAnImage.byteLength,
        expectedSha256: sha256(notAnImage),
      }),
    ).toThrow('MESSAGING_MEDIA_CONTENT_TYPE_MISMATCH');
  });
});

describe('messaging media worker cycle', () => {
  it('promotes a clean image to the deterministic ready key', async () => {
    const body = pngBody();
    const completeScan = vi.fn().mockResolvedValue('ready');
    const repo = repository({
      claimScans: vi.fn().mockResolvedValue([claim({ declaredSha256: sha256(body) })]),
      completeScan,
    });
    const { store: objectStore, putReady } = store({
      getExact: vi.fn().mockResolvedValue({ body, contentType: 'image/png' }),
    });

    const result = await run({ repository: repo, store: objectStore });

    expect(result).toEqual({
      expired: 0,
      scanned: 1,
      rejected: 0,
      scanRetried: 0,
      scanFailed: 0,
      gcCompleted: 0,
      gcRetried: 0,
      gcDead: 0,
    });
    expect(putReady).toHaveBeenCalledWith({
      objectKey: `${readyPrefix}/content`,
      body,
      contentType: 'image/png',
      sha256: sha256(body),
    });
    expect(completeScan).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaId,
        readyObjectKey: `${readyPrefix}/content`,
        readyObjectVersion: 'ready-v1',
        leaseOwner: 'messaging-media-1',
      }),
    );
  });

  it('rejects a declared sha256 mismatch without completing the scan', async () => {
    const body = pngBody();
    const rejectScan = vi.fn().mockResolvedValue('rejected');
    const completeScan = vi.fn().mockResolvedValue('ready');
    const { store: objectStore, putReady } = store({
      getExact: vi.fn().mockResolvedValue({ body, contentType: 'image/png' }),
    });

    const result = await run({
      repository: repository({
        claimScans: vi
          .fn()
          .mockResolvedValue([claim({ declaredSha256: 'a'.repeat(64), attempt: 1 })]),
        rejectScan,
        completeScan,
      }),
      store: objectStore,
    });

    expect(result).toMatchObject({ rejected: 1, scanned: 0, scanRetried: 0, scanFailed: 0 });
    expect(rejectScan).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId, rejectionCode: 'SOURCE_CHECKSUM_MISMATCH' }),
    );
    expect(completeScan).not.toHaveBeenCalled();
    expect(putReady).not.toHaveBeenCalled();
  });

  it('rejects a PNG declared as image/png that carries JPEG magic bytes', async () => {
    const body = jpegBody();
    const rejectScan = vi.fn().mockResolvedValue('rejected');
    const completeScan = vi.fn().mockResolvedValue('ready');
    const { store: objectStore } = store({
      getExact: vi.fn().mockResolvedValue({ body, contentType: 'image/png' }),
    });

    const result = await run({
      repository: repository({
        claimScans: vi.fn().mockResolvedValue([claim({ declaredSha256: sha256(body) })]),
        rejectScan,
        completeScan,
      }),
      store: objectStore,
    });

    expect(result).toMatchObject({ rejected: 1, scanned: 0 });
    expect(rejectScan).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId, rejectionCode: 'CONTENT_TYPE_MISMATCH' }),
    );
    expect(completeScan).not.toHaveBeenCalled();
  });

  it('rejects an infected body with the malware code and never stores it', async () => {
    const body = pngBody();
    const rejectScan = vi.fn().mockResolvedValue('rejected');
    const completeScan = vi.fn().mockResolvedValue('ready');
    const { store: objectStore, putReady } = store({
      getExact: vi.fn().mockResolvedValue({ body, contentType: 'image/png' }),
    });
    const scanner: MessagingMediaMalwareScanner = {
      scan: vi.fn().mockResolvedValue({ outcome: 'infected', signature: 'Eicar-Test-Signature' }),
    };

    const result = await run({
      repository: repository({
        claimScans: vi.fn().mockResolvedValue([claim({ declaredSha256: sha256(body) })]),
        rejectScan,
        completeScan,
      }),
      store: objectStore,
      scanner,
    });

    expect(result).toMatchObject({ rejected: 1, scanned: 0 });
    expect(rejectScan).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId, rejectionCode: 'MALWARE_DETECTED' }),
    );
    expect(completeScan).not.toHaveBeenCalled();
    expect(putReady).not.toHaveBeenCalled();
  });

  it('retries a transient source read and never terminalizes it at the attempt budget', async () => {
    const releaseScan = vi.fn().mockResolvedValue(undefined);
    const failScan = vi.fn().mockResolvedValue('rejected');
    const transient = () => Promise.reject(new Error('socket hang up'));

    const retried = await run({
      repository: repository({
        claimScans: vi.fn().mockResolvedValue([claim({ attempt: 2 })]),
        releaseScan,
        failScan,
      }),
      store: store({ getExact: vi.fn(transient) }).store,
      scanMaxAttempts: 3,
    });

    expect(retried).toMatchObject({ scanRetried: 1, scanFailed: 0, rejected: 0, scanned: 0 });
    const release = releaseScan.mock.calls[0]?.[0] as {
      readonly failureCode: string;
      readonly availableAt: Date;
    };
    expect(release.failureCode).toBe('MESSAGING_MEDIA_TRANSIENT_FAILURE');
    expect(release.availableAt).toBeInstanceOf(Date);
    expect(release.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(failScan).not.toHaveBeenCalled();

    // Past the budget the asset stays SCANNING: the retry slows down to the maximum backoff and
    // the file is never labelled as rejected, because a scanner outage is not a property of it.
    const releaseScanAtLimit = vi.fn().mockResolvedValue(undefined);
    const exhausted = await run({
      repository: repository({
        claimScans: vi.fn().mockResolvedValue([claim({ attempt: 3 })]),
        releaseScan: releaseScanAtLimit,
        failScan,
      }),
      store: store({ getExact: vi.fn(transient) }).store,
      scanMaxAttempts: 3,
    });

    expect(exhausted).toMatchObject({ scanRetried: 1, scanFailed: 1, rejected: 0, scanned: 0 });
    expect(failScan).not.toHaveBeenCalled();
    const slowRelease = releaseScanAtLimit.mock.calls[0]?.[0] as { readonly availableAt: Date };
    expect(slowRelease.availableAt.getTime()).toBeGreaterThan(Date.now() + 200_000);
  });

  it('maps a reused ClamAV unavailability code onto the chat namespace without rejecting', async () => {
    const body = pngBody();
    const failScan = vi.fn().mockResolvedValue('rejected');
    const releaseScan = vi.fn().mockResolvedValue(undefined);
    const scanner: MessagingMediaMalwareScanner = {
      scan: vi.fn().mockRejectedValue(new Error('COMMUNITY_MEDIA_SCAN_UNAVAILABLE')),
    };

    await run({
      repository: repository({
        claimScans: vi.fn().mockResolvedValue([claim({ declaredSha256: sha256(body) })]),
        releaseScan,
        failScan,
      }),
      store: store({ getExact: vi.fn().mockResolvedValue({ body, contentType: 'image/png' }) })
        .store,
      scanner,
      scanMaxAttempts: 1,
    });

    expect(releaseScan).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: 'MESSAGING_MEDIA_SCAN_UNAVAILABLE' }),
    );
    expect(failScan).not.toHaveBeenCalled();
  });

  it('deletes a GC claim and completes it, treating an absent version as deleted', async () => {
    const completeGc = vi.fn().mockResolvedValue('deleted');
    const missing = Object.assign(new Error('The specified version does not exist.'), {
      name: 'NoSuchVersion',
    });
    const gcClaims = [
      {
        jobId: '00000000-0000-4000-8000-000000000001',
        mediaId,
        objectKind: 'SOURCE' as const,
        objectKey: 'chat-media/quarantine/source',
        objectVersion: 'source-v1',
        attempt: 1,
        leaseOwner: 'messaging-media-1',
      },
      {
        jobId: '00000000-0000-4000-8000-000000000002',
        mediaId,
        objectKind: 'READY' as const,
        objectKey: `${readyPrefix}/content`,
        objectVersion: 'ready-v1',
        attempt: 1,
        leaseOwner: 'messaging-media-1',
      },
    ];
    const deleteExact = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(missing);

    const result = await run({
      repository: repository({ claimGc: vi.fn().mockResolvedValue(gcClaims), completeGc }),
      store: store({ deleteExact }).store,
    });

    expect(result).toMatchObject({ gcCompleted: 2, gcRetried: 0, gcDead: 0 });
    expect(deleteExact).toHaveBeenNthCalledWith(1, {
      objectKey: 'chat-media/quarantine/source',
      versionId: 'source-v1',
    });
    expect(completeGc).toHaveBeenCalledTimes(2);
    expect(completeGc).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ jobId: '00000000-0000-4000-8000-000000000002' }),
    );
  });

  it('retries a failing GC below the attempt limit and dead-letters it at the limit', async () => {
    const failure = new Error('MESSAGING_MEDIA_DELETE_FAILED');
    const failGc = vi.fn().mockResolvedValue(undefined);
    const deadLetterGc = vi.fn().mockResolvedValue(undefined);
    const completeGc = vi.fn().mockResolvedValue('deleted');
    const gcClaim = (jobId: string, attempt: number) => ({
      jobId,
      mediaId,
      objectKind: 'SOURCE' as const,
      objectKey: 'chat-media/quarantine/source',
      objectVersion: 'source-v1',
      attempt,
      leaseOwner: 'messaging-media-1',
    });

    const retried = await run({
      repository: repository({
        claimGc: vi.fn().mockResolvedValue([gcClaim('00000000-0000-4000-8000-000000000011', 2)]),
        completeGc,
        failGc,
        deadLetterGc,
      }),
      store: store({ deleteExact: vi.fn().mockRejectedValue(failure) }).store,
      gcMaxAttempts: 3,
    });

    expect(retried).toMatchObject({ gcRetried: 1, gcDead: 0, gcCompleted: 0 });
    const retry = failGc.mock.calls[0]?.[0] as {
      readonly failureCode: string;
      readonly availableAt: Date;
    };
    expect(retry.failureCode).toBe('MESSAGING_MEDIA_DELETE_FAILED');
    expect(retry.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(deadLetterGc).not.toHaveBeenCalled();

    const dead = await run({
      repository: repository({
        claimGc: vi.fn().mockResolvedValue([gcClaim('00000000-0000-4000-8000-000000000012', 3)]),
        completeGc,
        failGc,
        deadLetterGc,
      }),
      store: store({ deleteExact: vi.fn().mockRejectedValue(failure) }).store,
      gcMaxAttempts: 3,
    });

    expect(dead).toMatchObject({ gcRetried: 0, gcDead: 1 });
    expect(deadLetterGc).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: '00000000-0000-4000-8000-000000000012',
        failureCode: 'MESSAGING_MEDIA_DELETE_FAILED',
      }),
    );
    expect(failGc).toHaveBeenCalledTimes(1);
  });

  it('keeps a single failing item from aborting the cycle', async () => {
    const body = pngBody();
    const completeScan = vi
      .fn()
      .mockRejectedValueOnce(new Error('MESSAGING_MEDIA_SCAN_PERSIST_FAILED'))
      .mockResolvedValueOnce('ready');
    // Deferring the first item fails as well; the cycle must still process the second one.
    const releaseScan = vi.fn().mockRejectedValue(new Error('MESSAGING_MEDIA_LEASE_STORE_DOWN'));
    const log = logger();
    const claims = [
      claim({ mediaId: '00000000-0000-4000-8000-000000000021' }),
      claim({ mediaId: '00000000-0000-4000-8000-000000000022' }),
    ];
    const result = await run({
      repository: repository({
        claimScans: vi.fn().mockResolvedValue(claims),
        completeScan,
        releaseScan,
      }),
      store: store({ getExact: vi.fn().mockResolvedValue({ body, contentType: 'image/png' }) })
        .store,
      logger: log,
      scanMaxAttempts: 2,
    });

    expect(result).toMatchObject({ scanned: 1, scanFailed: 0, rejected: 0 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId: '00000000-0000-4000-8000-000000000021' }),
      'messaging media scan retry deferred',
    );
    expect(completeScan).toHaveBeenCalledTimes(2);
  });

  it('confirms every expired media row once the GC phase finished', async () => {
    const order: string[] = [];
    const confirm = vi.fn().mockImplementation(() => {
      order.push('confirm');
      return Promise.resolve(true);
    });

    const result = await run({
      repository: repository({
        expireDue: vi.fn().mockResolvedValue([
          { mediaId: '00000000-0000-4000-8000-000000000031', objectKey: 'a', objectVersion: 'v1' },
          { mediaId: '00000000-0000-4000-8000-000000000032', objectKey: 'b', objectVersion: null },
        ]),
        confirmExpiredObjectsAbsent: confirm,
        claimGc: vi.fn().mockResolvedValue([
          {
            jobId: '00000000-0000-4000-8000-000000000033',
            mediaId: '00000000-0000-4000-8000-000000000031',
            objectKind: 'SOURCE' as const,
            objectKey: 'a',
            objectVersion: 'v1',
            attempt: 1,
            leaseOwner: 'messaging-media-1',
          },
        ]),
      }),
      store: store({
        deleteExact: vi.fn().mockImplementation(() => {
          order.push('deleteExact');
          return Promise.resolve();
        }),
      }).store,
    });

    expect(result).toMatchObject({ expired: 2, gcCompleted: 1 });
    expect(confirm).toHaveBeenNthCalledWith(1, {
      tenantId,
      mediaId: '00000000-0000-4000-8000-000000000031',
    });
    expect(confirm).toHaveBeenNthCalledWith(2, {
      tenantId,
      mediaId: '00000000-0000-4000-8000-000000000032',
    });
    // Deletion is attempted before expiry is confirmed to be gone.
    expect(order).toEqual(['deleteExact', 'confirm', 'confirm']);
  });

  it('discovers the object version of an abandoned upload before confirming absence', async () => {
    const schedule = vi.fn().mockResolvedValue(undefined);
    const currentVersion = vi.fn().mockResolvedValue('abandoned-version-1');
    const confirm = vi.fn().mockResolvedValue(false);

    const result = await run({
      repository: repository({
        expireDue: vi.fn().mockResolvedValue([
          {
            mediaId: '00000000-0000-4000-8000-000000000041',
            objectKey: 'chat-media/quarantine/t/c/m/source',
            objectVersion: null,
          },
        ]),
        scheduleExpiredSourceVersion: schedule,
        confirmExpiredObjectsAbsent: confirm,
      }),
      store: store({ currentVersion }).store,
    });

    expect(currentVersion).toHaveBeenCalledWith('chat-media/quarantine/t/c/m/source');
    expect(schedule).toHaveBeenCalledWith({
      tenantId,
      mediaId: '00000000-0000-4000-8000-000000000041',
      objectVersion: 'abandoned-version-1',
    });
    expect(result.expired).toBe(1);
  });

  it('never confirms an expired asset whose source discovery failed', async () => {
    const log = logger();
    const confirm = vi.fn().mockResolvedValue(true);

    const result = await run({
      repository: repository({
        expireDue: vi.fn().mockResolvedValue([
          {
            mediaId: '00000000-0000-4000-8000-000000000042',
            objectKey: 'chat-media/quarantine/t/c/m/source',
            objectVersion: null,
          },
        ]),
        confirmExpiredObjectsAbsent: confirm,
      }),
      store: store({
        currentVersion: vi.fn().mockRejectedValue(new Error('storage unavailable')),
      }).store,
      logger: log,
    });

    // The bytes are still in the bucket, so the asset must stay EXPIRED for a later cycle instead
    // of being marked PURGED, and the failure is visible in the cycle log.
    expect(confirm).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId: '00000000-0000-4000-8000-000000000042' }),
      'messaging media expired source discovery deferred',
    );
    expect(result.expired).toBe(1);
  });

  it('defers expiry and claim failures with a warning instead of throwing', async () => {
    const log = logger();
    const result = await run({
      repository: repository({
        expireDue: vi.fn().mockRejectedValue(new Error('database unavailable')),
        claimScans: vi.fn().mockRejectedValue(new Error('database unavailable')),
        claimGc: vi.fn().mockRejectedValue(new Error('database unavailable')),
      }),
      store: store().store,
      logger: log,
    });

    expect(result).toEqual({
      expired: 0,
      scanned: 0,
      rejected: 0,
      scanRetried: 0,
      scanFailed: 0,
      gcCompleted: 0,
      gcRetried: 0,
      gcDead: 0,
    });
    expect(log.warn).toHaveBeenCalledTimes(3);
  });
});

describe('messaging media cycle metrics', () => {
  it('records every chat media instrument and stays silent on an idle cycle', () => {
    const recorder = createWorkerMetricRecorder({ instanceId: 'worker-1' });
    recorder.recordMessagingMediaCycle(
      {
        expired: 1,
        scanned: 2,
        rejected: 3,
        scanRetried: 4,
        scanFailed: 5,
        gcCompleted: 6,
        gcRetried: 7,
        gcDead: 8,
      },
      9,
      10,
    );
    recorder.recordMessagingMediaCycle(
      {
        expired: 0,
        scanned: 0,
        rejected: 0,
        scanRetried: 0,
        scanFailed: 0,
        gcCompleted: 0,
        gcRetried: 0,
        gcDead: 0,
      },
      0,
      11,
    );

    expect(instruments.add).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.messagingMediaScanned,
      2,
    );
    expect(instruments.add).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.messagingMediaRejected,
      3,
    );
    expect(instruments.add).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.messagingMediaScanRetried,
      4,
    );
    expect(instruments.add).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.messagingMediaScanFailed,
      5,
    );
    expect(instruments.add).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.messagingMediaGcCompleted,
      6,
    );
    expect(instruments.add).toHaveBeenCalledWith(WORKER_METRIC_INSTRUMENTS.messagingMediaGcDead, 8);
    expect(instruments.add).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.messagingMediaFailures,
      9,
    );
    expect(instruments.record).toHaveBeenCalledWith(
      WORKER_METRIC_INSTRUMENTS.messagingMediaCycleDurationMilliseconds,
      10,
    );
    // The idle cycle adds nothing and only records its duration.
    expect(instruments.add).toHaveBeenCalledTimes(9);
    expect(instruments.record).toHaveBeenCalledTimes(2);
  });
});
