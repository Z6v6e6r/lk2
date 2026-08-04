import { GetBucketVersioningCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getSignedUrl = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl }));

import { S3CommunityMediaObjectStore } from './community-media-object-store.js';

async function endpointOf(client: S3Client) {
  const endpoint = client.config.endpoint;
  if (!endpoint) throw new Error('S3 client endpoint is not configured');
  return endpoint();
}

describe('S3CommunityMediaObjectStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    getSignedUrl.mockReset();
  });

  it('checks storage internally but signs browser uploads against the public endpoint', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation((command) => {
      if (command instanceof HeadBucketCommand) return Promise.resolve({}) as never;
      if (command instanceof GetBucketVersioningCommand) {
        return Promise.resolve({ Status: 'Enabled' }) as never;
      }
      throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
    });
    getSignedUrl.mockImplementation(async (client: S3Client, command: { input: unknown }) => {
      const endpoint = await endpointOf(client);
      const input = command.input as { readonly Bucket: string; readonly Key: string };
      return `${endpoint.protocol}//${endpoint.hostname}/${input.Bucket}/${input.Key}?X-Amz-Credential=test-access-key`;
    });
    const store = new S3CommunityMediaObjectStore({
      endpoint: 'http://minio:9000',
      publicEndpoint: 'https://media.staging.example',
      region: 'us-east-1',
      bucket: 'phub-media',
      accessKey: 'test-access-key',
      secretKey: 'test-secret-key',
      forcePathStyle: true,
      autoCreateBucket: false,
    });

    const grant = await store.createUploadGrant({
      objectKey: 'community-media/quarantine/tenant/community/media/source',
      mediaId: '5dcdd751-e38e-4c35-99cc-48e394438c46',
      contentType: 'image/webp',
      byteSize: 128,
      sha256: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    });

    const signingClient = getSignedUrl.mock.calls[0]?.[0] as S3Client;
    const signingEndpoint = await endpointOf(signingClient);
    expect(signingEndpoint.hostname).toBe('media.staging.example');
    expect(signingEndpoint.protocol).toBe('https:');
    expect(grant.url).toBe(
      'https://media.staging.example/phub-media/community-media/quarantine/tenant/community/media/source?X-Amz-Credential=test-access-key',
    );
    expect(grant.url).not.toContain('minio:9000');
    expect(grant.requiredHeaders).toEqual({
      'Content-Type': 'image/webp',
      'Cache-Control': 'private, no-store',
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
