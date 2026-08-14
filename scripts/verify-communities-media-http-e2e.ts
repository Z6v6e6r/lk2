import { createHash, randomUUID } from 'node:crypto';

import {
  communityFeedPageSchema,
  communityMediaStatusSchema,
  communityMediaUploadIssuedSchema,
  communityPendingModerationPageSchema,
  communityPostSchema,
} from '@phub/communities';
import sharp from 'sharp';
import { z } from 'zod';

import { readPrivateFixture, requirePinnedOrigin } from './communities-private-fixture.js';

const confirmation = 'I_ACKNOWLEDGE_SYNTHETIC_COMMUNITY_WRITES';
if (process.env.COMMUNITIES_MEDIA_E2E_CONFIRM !== confirmation) {
  throw new Error(`COMMUNITIES_MEDIA_E2E_CONFIRM must equal ${confirmation}`);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeUrl(name: string): URL {
  const url = new URL(required(name));
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error(`${name} must use HTTPS unless it is loopback`);
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

const userBase = safeUrl('COMMUNITIES_MEDIA_E2E_USER_BASE_URL');
const cupBase = safeUrl('COMMUNITIES_MEDIA_E2E_CUP_BASE_URL');
const tenantKey = required('COMMUNITIES_MEDIA_E2E_TENANT_KEY');
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tenantKey)) throw new Error('Invalid tenant key');
const fixture = z
  .object({
    synthetic: z.literal(true),
    userToken: z.string().min(32),
    cupToken: z.string().min(32),
    communityId: z.string().uuid(),
    expectedUserOrigin: z.string().url(),
    expectedCupOrigin: z.string().url(),
    allowedUploadOrigin: z.string().url(),
  })
  .strict()
  .parse(
    JSON.parse(
      await readPrivateFixture(
        required('COMMUNITIES_MEDIA_E2E_AUTH_FILE'),
        'COMMUNITIES_MEDIA_E2E_AUTH_FILE',
      ),
    ),
  );
const allowedUploadOrigin = new URL(fixture.allowedUploadOrigin).origin;
requirePinnedOrigin(userBase, fixture.expectedUserOrigin, 'COMMUNITIES_MEDIA_E2E_USER_BASE_URL');
requirePinnedOrigin(cupBase, fixture.expectedCupOrigin, 'COMMUNITIES_MEDIA_E2E_CUP_BASE_URL');

const timeoutMs = Number(process.env.COMMUNITIES_MEDIA_E2E_TIMEOUT_MS ?? 120_000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 300_000) {
  throw new Error('COMMUNITIES_MEDIA_E2E_TIMEOUT_MS must be between 10000 and 300000');
}
const prefix = `${tenantKey}/communities/${fixture.communityId}`;
const userRoot = new URL(`/user/api/v1/${prefix}`, userBase);
const adminRoot = new URL(`/admin/api/v1/${tenantKey}`, cupBase);
const operation = randomUUID();

function headers(token: string, command = false, cup = false): Record<string, string> {
  return {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'x-correlation-id': randomUUID(),
    ...(cup ? { 'x-app-platform': 'cup-admin' } : {}),
    ...(command
      ? { 'content-type': 'application/json', 'idempotency-key': `${operation}-${randomUUID()}` }
      : {}),
  };
}

async function jsonRequest<T>(input: {
  url: URL;
  token: string;
  schema: z.ZodType<T>;
  method?: 'GET' | 'POST';
  body?: unknown;
  cup?: boolean;
}): Promise<T> {
  const response = await fetch(input.url, {
    method: input.method ?? 'GET',
    headers: headers(input.token, input.method === 'POST', input.cup),
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { code?: unknown } | undefined;
    throw new Error(
      `HTTP ${response.status} ${typeof payload?.code === 'string' ? payload.code : 'UNEXPECTED_RESPONSE'}`,
    );
  }
  return input.schema.parse(await response.json());
}

function user(path: string): URL {
  return new URL(`${userRoot.pathname}${path}`, userBase);
}
function admin(path: string): URL {
  return new URL(`${adminRoot.pathname}${path}`, cupBase);
}
async function feedContains(postId: string): Promise<boolean> {
  const page = await jsonRequest({
    url: user('/feed?limit=50'),
    token: fixture.userToken,
    schema: communityFeedPageSchema,
  });
  return page.items.some((item) => item.id === postId);
}

async function assertUserVariantUnavailable(): Promise<void> {
  const response = await fetch(user(`/media/${issued.id}/variants/THUMBNAIL`), {
    method: 'GET',
    headers: headers(fixture.userToken),
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  if (![403, 404].includes(response.status)) {
    throw new Error(`Archived media remained deliverable with HTTP ${response.status}`);
  }
  if (response.headers.has('location')) {
    throw new Error('Archived media response exposed a redirect');
  }
  if (response.headers.get('content-type')?.startsWith('image/webp')) {
    throw new Error('Archived media response exposed image content');
  }
  await response.body?.cancel();
}

// Fail before the first write unless the fixture is an active MEMBER in a moderated community
// and the CUP principal can read that exact moderation queue.
const detail = await jsonRequest({
  url: user(''),
  token: fixture.userToken,
  schema: z
    .object({
      publishingPreset: z.literal('MODERATED_FEED'),
      viewerMembership: z
        .object({ status: z.literal('ACTIVE'), role: z.literal('MEMBER') })
        .passthrough(),
    })
    .passthrough(),
});
void detail;
await jsonRequest({
  url: admin(`/community-content/pending?communityId=${fixture.communityId}&limit=1`),
  token: fixture.cupToken,
  schema: communityPendingModerationPageSchema,
  cup: true,
});

const image = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#00a0c6' } })
  .webp()
  .toBuffer();
const sha256 = createHash('sha256').update(image).digest('hex');
const issued = await jsonRequest({
  url: user('/media/uploads'),
  token: fixture.userToken,
  schema: communityMediaUploadIssuedSchema,
  method: 'POST',
  body: { mediaType: 'IMAGE', contentType: 'image/webp', byteSize: image.byteLength, sha256 },
});
const uploadUrl = new URL(issued.upload.url);
if (uploadUrl.origin !== allowedUploadOrigin || uploadUrl.protocol !== userBase.protocol) {
  throw new Error('Upload grant escaped the explicitly allowed public origin');
}
const uploaded = await fetch(uploadUrl, {
  method: 'PUT',
  headers: issued.upload.requiredHeaders,
  body: image,
  redirect: 'error',
  signal: AbortSignal.timeout(15_000),
});
if (!uploaded.ok) throw new Error(`Signed upload failed with HTTP ${uploaded.status}`);

let media = await jsonRequest({
  url: user(`/media/${issued.id}/finalize`),
  token: fixture.userToken,
  schema: communityMediaStatusSchema,
  method: 'POST',
  body: { expectedRevision: issued.revision },
});
const deadline = Date.now() + timeoutMs;
while (media.state === 'SCANNING' && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  media = await jsonRequest({
    url: user(`/media/${issued.id}`),
    token: fixture.userToken,
    schema: communityMediaStatusSchema,
  });
}
if (media.state !== 'READY') throw new Error(`Media did not become READY: ${media.state}`);

let post = await jsonRequest({
  url: user('/posts'),
  token: fixture.userToken,
  schema: communityPostSchema,
  method: 'POST',
  body: { body: `Media E2E ${operation}`, mediaIds: [issued.id] },
});
let cleanupRevision = post.revision;
let failure: unknown;
try {
  if (post.status !== 'PENDING_MODERATION' || (await feedContains(post.id))) {
    throw new Error('Moderated post visibility invariant failed');
  }
  const pending = await jsonRequest({
    url: admin(`/community-content/pending?communityId=${fixture.communityId}&limit=50`),
    token: fixture.cupToken,
    schema: communityPendingModerationPageSchema,
    cup: true,
  });
  if (!pending.items.some((item) => item.post.id === post.id))
    throw new Error('Post missing from CUP queue');
  const grant = await jsonRequest({
    url: admin(
      `/communities/${fixture.communityId}/content/media/${issued.id}/variants/THUMBNAIL/url`,
    ),
    token: fixture.cupToken,
    schema: z
      .object({ url: z.string().url(), expiresAt: z.string().datetime({ offset: true }) })
      .strict(),
    cup: true,
  });
  const preview = await fetch(grant.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
  });
  if (!preview.ok || !preview.headers.get('content-type')?.startsWith('image/webp'))
    throw new Error('CUP preview failed');
  post = await jsonRequest({
    url: admin(`/communities/${fixture.communityId}/content/posts/${post.id}/approve`),
    token: fixture.cupToken,
    schema: communityPostSchema,
    method: 'POST',
    body: { expectedRevision: post.revision },
    cup: true,
  });
  cleanupRevision = post.revision;
  if (post.status !== 'PUBLISHED' || !(await feedContains(post.id)))
    throw new Error('Approved post missing from feed');
  post = await jsonRequest({
    url: user(`/posts/${post.id}/archive`),
    token: fixture.userToken,
    schema: communityPostSchema,
    method: 'POST',
    body: { expectedRevision: post.revision },
  });
  cleanupRevision = post.revision;
  if (
    post.status !== 'ARCHIVED' ||
    !post.retentionUntil ||
    Date.parse(post.retentionUntil) < Date.now() + 4.9 * 365 * 24 * 60 * 60 * 1_000 ||
    (await feedContains(post.id))
  ) {
    throw new Error('Archive invariant failed');
  }
  await assertUserVariantUnavailable();
  post = await jsonRequest({
    url: user(`/posts/${post.id}/restore`),
    token: fixture.userToken,
    schema: communityPostSchema,
    method: 'POST',
    body: { expectedRevision: post.revision },
  });
  cleanupRevision = post.revision;
  if (post.status !== 'PENDING_MODERATION')
    throw new Error('Restore must return MEMBER content to moderation');
  const restoredPending = await jsonRequest({
    url: admin(`/community-content/pending?communityId=${fixture.communityId}&limit=50`),
    token: fixture.cupToken,
    schema: communityPendingModerationPageSchema,
    cup: true,
  });
  const restoredItem = restoredPending.items.find((item) => item.post.id === post.id);
  if (!restoredItem || restoredItem.post.revision !== post.revision) {
    throw new Error('Restored post missing from the current CUP moderation queue');
  }
  post = await jsonRequest({
    url: admin(`/communities/${fixture.communityId}/content/posts/${post.id}/approve`),
    token: fixture.cupToken,
    schema: communityPostSchema,
    method: 'POST',
    body: { expectedRevision: post.revision },
    cup: true,
  });
  cleanupRevision = post.revision;
  if (post.status !== 'PUBLISHED' || !(await feedContains(post.id))) {
    throw new Error('Re-approved restored post missing from feed');
  }
  post = await jsonRequest({
    url: user(`/posts/${post.id}/archive`),
    token: fixture.userToken,
    schema: communityPostSchema,
    method: 'POST',
    body: { expectedRevision: post.revision },
  });
  cleanupRevision = post.revision;
  if (post.status !== 'ARCHIVED' || (await feedContains(post.id))) {
    throw new Error('Final synthetic post archive failed');
  }
  await assertUserVariantUnavailable();
} catch (error) {
  failure = error;
}
if (post.status === 'PUBLISHED' || post.status === 'PENDING_MODERATION') {
  try {
    post = await jsonRequest({
      url: user(`/posts/${post.id}/archive`),
      token: fixture.userToken,
      schema: communityPostSchema,
      method: 'POST',
      body: { expectedRevision: cleanupRevision },
    });
  } catch (error) {
    failure ??= error;
  }
}
if (failure) {
  if (failure instanceof Error) throw failure;
  throw new Error('Community media E2E failed with a non-Error rejection');
}
if (post.status !== 'ARCHIVED')
  throw new Error('Synthetic post cleanup did not finish in ARCHIVED');

process.stdout.write(
  `${JSON.stringify({ status: 'passed', tenantKey, communityId: fixture.communityId, mediaId: issued.id, postId: post.id, finalStatus: post.status })}\n`,
);
