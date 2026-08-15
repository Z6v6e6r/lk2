import { loadConfig } from '@phub/config';
import { describe, expect, it, vi } from 'vitest';

import { createCommunityReadRuntime } from './community-runtime.js';

const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const viewerUserId = '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca';
const communityId = '11111111-1111-4111-8111-111111111111';

function localConfig(stableLogoDeliveryEnabled: boolean) {
  return loadConfig({
    APP_ENV: 'ci',
    DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
    REDIS_URL: 'redis://localhost:6379',
    RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
    JWT_ISSUER: 'phub-identity',
    JWT_AUDIENCE: 'phub-api',
    JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
    JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
    COMMUNITIES_READ_MODE: 'local',
    COMMUNITY_LOGO_STABLE_DELIVERY_ENABLED: stableLogoDeliveryEnabled ? 'true' : 'false',
    S3_ENDPOINT: 'http://minio:9000',
    S3_PUBLIC_ENDPOINT: 'https://media.padlhub.test',
    S3_BUCKET: 'phub-media',
    S3_ACCESS_KEY: 'test-access',
    S3_SECRET_KEY: 'test-secret',
  });
}

function poolWithLogo(deliveryUrl: string | null) {
  const query = vi.fn((text: string) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') {
      return Promise.resolve({ rows: [] });
    }
    if (text.includes("set_config('app.tenant_id'")) return Promise.resolve({ rows: [] });
    return Promise.resolve({
      rows: [
        {
          id: communityId,
          title: 'Padel Friends',
          description: 'Description',
          logo_object_key: `community-logos/${tenantId}/${communityId}/${'a'.repeat(64)}.webp`,
          logo_url: deliveryUrl,
          is_verified: true,
          visibility: 'PUBLIC',
          join_policy: 'MODERATED',
          publishing_preset: 'STAFF_FEED',
          revision: 1,
          member_count: 42,
          created_at: new Date('2026-08-03T10:00:00.000Z'),
          updated_at: new Date('2026-08-03T11:00:00.000Z'),
          sort_created_at: '2026-08-03 10:00:00+00',
          membership_status: null,
          membership_role: null,
          membership_revision: null,
          ranking_position: null,
        },
      ],
    });
  });
  return { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as never;
}

describe('community runtime', () => {
  it('wires stable community-logo delivery into canonical local discovery and detail', async () => {
    const stablePath = `/public/api/v1/media/community-logos/${tenantId}/${communityId}`;
    const service = createCommunityReadRuntime({
      config: localConfig(true),
      pool: poolWithLogo(null),
    });
    expect(service).toBeDefined();
    if (!service) throw new Error('expected local community read runtime');

    await expect(
      service.listDiscoverable({ tenantId, viewerUserId, limit: 20 }),
    ).resolves.toMatchObject({ items: [{ logoUrl: stablePath }] });
    await expect(service.getDetail({ tenantId, viewerUserId, communityId })).resolves.toMatchObject(
      {
        outcome: 'found',
        detail: { logoUrl: stablePath },
      },
    );
  });
});
