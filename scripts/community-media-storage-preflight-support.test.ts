import { describe, expect, it } from 'vitest';

import {
  lifecycleCanDeleteReady,
  lifecycleCleansQuarantineVersions,
  policyAllowsAnonymousAccess,
} from './community-media-storage-preflight-support.js';

describe('community media storage preflight policy', () => {
  it('rejects anonymous read while allowing a scoped service principal', () => {
    expect(
      policyAllowsAnonymousAccess(
        JSON.stringify({
          Statement: { Effect: 'Allow', Principal: '*', Action: 's3:GetObject' },
        }),
      ),
    ).toBe(true);
    expect(
      policyAllowsAnonymousAccess(
        JSON.stringify({
          Statement: {
            Effect: 'Allow',
            Principal: { AWS: 'arn:aws:iam::123456789012:role/phub-worker' },
            Action: 's3:GetObject',
          },
        }),
      ),
    ).toBe(false);
  });

  it('rejects lifecycle deletion of current or exact historical ready versions', () => {
    expect(
      lifecycleCanDeleteReady({
        ID: 'delete-ready',
        Status: 'Enabled',
        Filter: { Prefix: 'community-media/ready/' },
        Expiration: { Days: 3650 },
      }),
    ).toBe(true);
    expect(
      lifecycleCanDeleteReady({
        ID: 'delete-all-noncurrent',
        Status: 'Enabled',
        Filter: { Prefix: '' },
        NoncurrentVersionExpiration: { NoncurrentDays: 30 },
      }),
    ).toBe(true);
    expect(
      lifecycleCanDeleteReady({
        ID: 'expire-quarantine',
        Status: 'Enabled',
        Filter: { Prefix: 'community-media/quarantine/' },
        Expiration: { Days: 1 },
      }),
    ).toBe(false);
  });

  it('requires bounded cleanup for noncurrent quarantine versions', () => {
    expect(
      lifecycleCleansQuarantineVersions({
        ID: 'quarantine-noncurrent-cleanup',
        Status: 'Enabled',
        Filter: { Prefix: 'community-media/quarantine/' },
        NoncurrentVersionExpiration: { NoncurrentDays: 1 },
      }),
    ).toBe(true);
    expect(
      lifecycleCleansQuarantineVersions({
        ID: 'too-slow-cleanup',
        Status: 'Enabled',
        Filter: { Prefix: 'community-media/quarantine/' },
        NoncurrentVersionExpiration: { NoncurrentDays: 30 },
      }),
    ).toBe(false);
    expect(
      lifecycleCleansQuarantineVersions({
        ID: 'one-tenant-only',
        Status: 'Enabled',
        Filter: { Prefix: 'community-media/quarantine/one-tenant/' },
        NoncurrentVersionExpiration: { NoncurrentDays: 1 },
      }),
    ).toBe(false);
    expect(
      lifecycleCleansQuarantineVersions({
        ID: 'ready-only',
        Status: 'Enabled',
        Filter: { Prefix: 'community-media/ready/' },
        NoncurrentVersionExpiration: { NoncurrentDays: 1 },
      }),
    ).toBe(false);
  });
});
