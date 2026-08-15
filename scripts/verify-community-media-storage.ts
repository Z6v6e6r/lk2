import { createHash, randomUUID } from 'node:crypto';

import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { loadConfig } from '@phub/config';
import sharp from 'sharp';

import { S3CommunityMediaObjectStore } from '../apps/api/src/communities/community-media-object-store.js';
import { S3CommunityMediaWorkerObjectStore } from '../apps/worker/src/community-media-processing.js';

const config = loadConfig();
const endpoint = config.S3_ENDPOINT;
const accessKey = config.S3_ACCESS_KEY;
const secretKey = config.S3_SECRET_KEY;
if (!endpoint || !accessKey || !secretKey) {
  throw new Error('Community media storage verification requires S3 endpoint and credentials');
}

const bucket = `phub-community-media-${Date.now()}-verify`;
if (!bucket.endsWith('-verify')) throw new Error('Refusing to use a non-verify bucket');
const client = new S3Client({
  endpoint,
  region: config.S3_REGION,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
  maxAttempts: 2,
});

async function emptyAndDeleteVerifyBucket(): Promise<void> {
  if (!bucket.endsWith('-verify')) throw new Error('Refusing to delete a non-verify bucket');
  const versions = await client.send(new ListObjectVersionsCommand({ Bucket: bucket }));
  const objects = [
    ...(versions.Versions ?? []).map((item) => ({ Key: item.Key, VersionId: item.VersionId })),
    ...(versions.DeleteMarkers ?? []).map((item) => ({
      Key: item.Key,
      VersionId: item.VersionId,
    })),
  ].filter((item): item is { readonly Key: string; readonly VersionId: string } =>
    Boolean(item.Key && item.VersionId),
  );
  if (objects.length > 0) {
    await client.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
    );
  }
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}

const tenantId = randomUUID();
const communityId = randomUUID();
const mediaId = randomUUID();
const body = await sharp({
  create: { width: 16, height: 8, channels: 3, background: '#00a0c6' },
})
  .webp()
  .toBuffer();
const sha256 = createHash('sha256').update(body).digest('hex');
const objectKey = `community-media/quarantine/${tenantId}/${communityId}/${mediaId}/source`;
const store = new S3CommunityMediaObjectStore({
  endpoint,
  publicEndpoint: endpoint,
  region: config.S3_REGION,
  bucket,
  accessKey,
  secretKey,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
  autoCreateBucket: true,
});
const workerStore = new S3CommunityMediaWorkerObjectStore({
  endpoint,
  region: config.S3_REGION,
  bucket,
  accessKey,
  secretKey,
  forcePathStyle: config.S3_FORCE_PATH_STYLE,
});

try {
  const expiresAt = new Date(Date.now() + 15 * 60 * 1_000).toISOString();
  const grant = await store.createUploadGrant({
    objectKey,
    mediaId,
    contentType: 'image/webp',
    byteSize: body.byteLength,
    sha256,
    expiresAt,
  });
  const upload = await fetch(grant.url, {
    method: 'PUT',
    headers: grant.requiredHeaders,
    body,
  });
  if (!upload.ok) {
    const diagnostic = (await upload.text()).replace(/<RequestId>.*?<\/RequestId>/s, '');
    throw new Error(`Verify upload failed with HTTP ${upload.status}: ${diagnostic.slice(0, 500)}`);
  }
  const replayedUpload = await fetch(grant.url, {
    method: 'PUT',
    headers: grant.requiredHeaders,
    body,
  });
  if (replayedUpload.status !== 412) {
    throw new Error(`Verify upload replay expected HTTP 412, received ${replayedUpload.status}`);
  }
  const observed = await store.statUploadedObject(objectKey);
  if (
    observed.byteSize !== body.byteLength ||
    observed.contentType !== 'image/webp' ||
    observed.checksumSha256 !== sha256 ||
    !observed.etag ||
    !observed.versionId
  ) {
    throw new Error('Verify upload metadata mismatch');
  }
  const exactSource = await workerStore.getExact({
    objectKey,
    versionId: observed.versionId,
    etag: observed.etag,
  });
  if (exactSource.contentType !== 'image/webp' || !exactSource.body.equals(body)) {
    throw new Error('Worker exact-version source read mismatch');
  }
  const readyKey = `community-media/ready/${tenantId}/${communityId}/${mediaId}/feed/${sha256}.webp`;
  const firstReady = await workerStore.putReady({ objectKey: readyKey, body, sha256 });
  const replayedReady = await workerStore.putReady({ objectKey: readyKey, body, sha256 });
  if (replayedReady.versionId !== firstReady.versionId) {
    throw new Error('Idempotent variant put created a second object version');
  }
  const readUrl = await store.createReadUrl({
    objectKey,
    versionId: observed.versionId,
    expiresInSeconds: 60,
  });
  const download = await fetch(readUrl);
  const downloaded = Buffer.from(await download.arrayBuffer());
  if (!download.ok || !downloaded.equals(body)) {
    throw new Error(`Exact-version verify download failed with HTTP ${download.status}`);
  }
  process.stdout.write(
    `${JSON.stringify({
      status: 'ok',
      versioning: 'Enabled',
      exactVersionRead: true,
      singleUseUpload: true,
      idempotentVariantPut: true,
    })}\n`,
  );
} finally {
  await emptyAndDeleteVerifyBucket().catch((error) => {
    process.stderr.write(`Verify bucket cleanup failed: ${String(error)}\n`);
    process.exitCode = 1;
  });
  client.destroy();
}
