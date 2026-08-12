import { readFileSync } from 'node:fs';

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { registerCommunityExperienceRoutes } from './community-experience-routes.js';
const allEnabled = { detail: true, feed: true, chat: true, rating: true } as const;
import { LegacyCommunityExperienceError } from './legacy-community-experience-repository.js';
const id = '11111111-1111-4111-8111-111111111111';
describe('community experience routes', () => {
  it('contracts all read-only routes with the actual global rate-limit response', () => {
    const contract = parse(
      readFileSync(
        new URL('../../../../contracts/openapi/user/v1/openapi.yaml', import.meta.url),
        'utf8',
      ),
    ) as {
      paths: Record<string, { get?: { responses?: Record<string, unknown> } }>;
    };
    for (const suffix of ['', '/feed', '/chat', '/rating']) {
      expect(
        contract.paths[`/{tenantKey}/community-views/{communityId}${suffix}`]?.get?.responses,
      ).toHaveProperty('429');
    }
  });

  it('requires tenant-authentication and returns 503 before integration is enabled', async () => {
    const anonymous = Fastify();
    registerCommunityExperienceRoutes(anonymous, {
      authenticatedTenantHandlers: [],
      enabled: allEnabled,
    });
    expect(
      (await anonymous.inject({ method: 'GET', url: `/user/api/v1/t/community-views/${id}` }))
        .statusCode,
    ).toBe(401);
    await anonymous.close();
    const app = Fastify();
    app.addHook('preHandler', (request) => {
      (
        request as typeof request & {
          tenantId: string;
          padlHubClaims: {
            sub: string;
            tenants: string[];
            roles: string[];
            permissions: string[];
            sid: string;
          };
        }
      ).tenantId = 'tenant';
      (
        request as typeof request & {
          padlHubClaims: {
            sub: string;
            tenants: string[];
            roles: string[];
            permissions: string[];
            sid: string;
          };
        }
      ).padlHubClaims = {
        sub: 'viewer',
        tenants: ['tenant'],
        roles: [],
        permissions: [],
        sid: 'session',
      };
      return Promise.resolve();
    });
    registerCommunityExperienceRoutes(app, {
      authenticatedTenantHandlers: [],
      enabled: allEnabled,
    });
    expect(
      (await app.inject({ method: 'GET', url: `/user/api/v1/t/community-views/${id}` })).statusCode,
    ).toBe(503);
    await app.close();
  });
  it('passes only JWT tenant/viewer to a bounded service request', async () => {
    const getFeed = vi.fn().mockResolvedValue({ items: [] });
    const app = Fastify();
    app.addHook('preHandler', (request) => {
      (
        request as typeof request & {
          tenantId: string;
          padlHubClaims: {
            sub: string;
            tenants: string[];
            roles: string[];
            permissions: string[];
            sid: string;
          };
        }
      ).tenantId = 'tenant';
      (
        request as typeof request & {
          padlHubClaims: {
            sub: string;
            tenants: string[];
            roles: string[];
            permissions: string[];
            sid: string;
          };
        }
      ).padlHubClaims = {
        sub: 'viewer',
        tenants: ['tenant'],
        roles: [],
        permissions: [],
        sid: 'session',
      };
      return Promise.resolve();
    });
    registerCommunityExperienceRoutes(app, {
      authenticatedTenantHandlers: [],
      enabled: allEnabled,
      service: { getDetail: vi.fn(), getFeed, getChat: vi.fn(), getRating: vi.fn() },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/user/api/v1/t/community-views/${id}/feed?limit=20`,
    });
    expect(response.statusCode).toBe(200);
    expect(getFeed).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant',
        viewerUserId: 'viewer',
        communityId: id,
        limit: 20,
      }),
    );
    await app.close();
  });
  it('hides non-members as 404 and fails upstream service errors closed with 503', async () => {
    const app = Fastify();
    app.addHook('preHandler', (request) => {
      (
        request as typeof request & {
          tenantId: string;
          padlHubClaims: {
            sub: string;
            tenants: string[];
            roles: string[];
            permissions: string[];
            sid: string;
          };
        }
      ).tenantId = 'tenant';
      (
        request as typeof request & {
          padlHubClaims: {
            sub: string;
            tenants: string[];
            roles: string[];
            permissions: string[];
            sid: string;
          };
        }
      ).padlHubClaims = {
        sub: 'viewer',
        tenants: ['tenant'],
        roles: [],
        permissions: [],
        sid: 'session',
      };
      return Promise.resolve();
    });
    registerCommunityExperienceRoutes(app, {
      authenticatedTenantHandlers: [],
      enabled: allEnabled,
      service: {
        getDetail: vi
          .fn()
          .mockRejectedValueOnce(
            new LegacyCommunityExperienceError('COMMUNITY_EXPERIENCE_FORBIDDEN'),
          )
          .mockRejectedValueOnce(
            new LegacyCommunityExperienceError('COMMUNITY_EXPERIENCE_UNAVAILABLE'),
          ),
        getFeed: vi.fn(),
        getChat: vi.fn(),
        getRating: vi.fn(),
      },
    });
    expect(
      (await app.inject({ method: 'GET', url: `/user/api/v1/t/community-views/${id}` })).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/user/api/v1/t/community-views/${id}` })).statusCode,
    ).toBe(503);
    await app.close();
  });
});
