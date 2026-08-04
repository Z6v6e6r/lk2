import {
  GetBucketAclCommand,
  GetBucketCorsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  S3Client,
  type LifecycleRule,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import {
  lifecycleCanDeleteReady,
  policyAllowsAnonymousAccess,
} from './community-media-storage-preflight-support.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function csv(name: string): readonly string[] {
  const values = required(name)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(`${name} must contain unique comma-separated values`);
  }
  return values;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

const endpoint = required('S3_ENDPOINT');
const bucket = required('S3_BUCKET');
const expectedOrigins = new Set(csv('COMMUNITIES_MEDIA_ALLOWED_ORIGINS'));
const allowedMethods = new Set(['GET', 'HEAD', 'PUT']);
const allowedHeaders = new Set(
  (
    process.env.COMMUNITIES_MEDIA_ALLOWED_UPLOAD_HEADERS ??
    'content-type,cache-control,x-amz-checksum-sha256,x-amz-meta-padlhub-media-id,x-amz-meta-padlhub-sha256'
  )
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);
if (boolean('S3_AUTO_CREATE_BUCKET', false)) {
  throw new Error('Storage preflight requires S3_AUTO_CREATE_BUCKET=false');
}

const client = new S3Client({
  endpoint,
  region: process.env.S3_REGION?.trim() || 'us-east-1',
  credentials: {
    accessKeyId: required('S3_ACCESS_KEY'),
    secretAccessKey: required('S3_SECRET_KEY'),
  },
  forcePathStyle: boolean('S3_FORCE_PATH_STYLE', true),
  maxAttempts: 2,
  requestHandler: new NodeHttpHandler({ requestTimeout: 10_000, connectionTimeout: 3_000 }),
});

try {
  const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
  if (versioning.Status !== 'Enabled') {
    throw new Error('COMMUNITY_MEDIA_BUCKET_VERSIONING_REQUIRED');
  }

  const acl = await client.send(new GetBucketAclCommand({ Bucket: bucket }));
  const publicAcl = (acl.Grants ?? []).some((grant) =>
    grant.Grantee?.URI?.match(/AllUsers|AuthenticatedUsers/i),
  );
  if (publicAcl) throw new Error('COMMUNITY_MEDIA_BUCKET_PUBLIC_ACL_FORBIDDEN');

  try {
    const policy = await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
    if (policy.Policy && policyAllowsAnonymousAccess(policy.Policy)) {
      throw new Error('COMMUNITY_MEDIA_BUCKET_PUBLIC_POLICY_FORBIDDEN');
    }
  } catch (error) {
    if (!['NoSuchBucketPolicy', 'NoSuchPolicy'].includes(errorName(error) ?? '')) throw error;
  }

  const cors = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
  const observedOrigins = new Set<string>();
  for (const rule of cors.CORSRules ?? []) {
    for (const origin of rule.AllowedOrigins ?? []) {
      if (!expectedOrigins.has(origin)) {
        throw new Error(`COMMUNITY_MEDIA_CORS_ORIGIN_FORBIDDEN:${origin}`);
      }
      observedOrigins.add(origin);
    }
    for (const method of rule.AllowedMethods ?? []) {
      if (!allowedMethods.has(method.toUpperCase())) {
        throw new Error(`COMMUNITY_MEDIA_CORS_METHOD_FORBIDDEN:${method}`);
      }
    }
    for (const header of rule.AllowedHeaders ?? []) {
      if (header === '*' || !allowedHeaders.has(header.toLowerCase())) {
        throw new Error(`COMMUNITY_MEDIA_CORS_HEADER_FORBIDDEN:${header}`);
      }
    }
  }
  const missingOrigins = [...expectedOrigins].filter((origin) => !observedOrigins.has(origin));
  if (missingOrigins.length > 0) {
    throw new Error(`COMMUNITY_MEDIA_CORS_ORIGINS_MISSING:${missingOrigins.join(',')}`);
  }

  let lifecycleRules: readonly LifecycleRule[] = [];
  try {
    const lifecycle = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    );
    lifecycleRules = lifecycle.Rules ?? [];
  } catch (error) {
    if (!['NoSuchLifecycleConfiguration', 'NoSuchConfiguration'].includes(errorName(error) ?? '')) {
      throw error;
    }
  }
  if (lifecycleRules.some(lifecycleCanDeleteReady)) {
    throw new Error('COMMUNITY_MEDIA_READY_LIFECYCLE_DELETE_FORBIDDEN');
  }

  process.stdout.write(
    `${JSON.stringify({
      status: 'passed',
      bucket,
      versioning: 'Enabled',
      publicRead: false,
      corsOrigins: [...observedOrigins].sort(),
      readyLifecycleDeletion: false,
    })}\n`,
  );
} finally {
  client.destroy();
}
