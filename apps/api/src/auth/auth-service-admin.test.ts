import { loadConfig } from '@phub/config';
import { decodeJwt, jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { AuthService, type AuthRepository, type AuthUser } from './auth-service.js';

const config = loadConfig({
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ADMIN_AUDIENCE: 'phub-admin',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
});
const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const user: AuthUser = {
  id: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
  tenantId,
  displayName: 'Оператор',
};

function service(access: {
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
}) {
  const repository = {
    resolveTenantAuthBinding: () =>
      Promise.resolve({
        tenantId,
        tenantKey: 'local-padel',
        provider: 'LOCAL' as const,
        providerTenantKey: 'local-padel',
      }),
    rotateRefreshSession: () =>
      Promise.resolve({
        outcome: 'rotated' as const,
        identity: {
          sessionId: '55555555-5555-4555-8555-555555555555',
          tenantId,
          tenantKey: 'local-padel',
          user,
        },
      }),
    getUserAccessProfile: () => Promise.resolve(access),
  } as unknown as AuthRepository;
  return new AuthService({
    config,
    repository,
    challengeStore: {} as never,
    providers: new Map(),
  });
}

describe('admin access token audience', () => {
  it('issues a dedicated phub-admin token only with explicit notification permission', async () => {
    const session = await service({
      roles: ['client', 'admin'],
      permissions: ['profile.read', 'notifications.manage'],
    }).refreshSession(
      'local-padel',
      'existing-refresh-token',
      'admin-auth-test-correlation',
      'admin-auth-idempotency-test-0001',
      'admin',
    );
    const verified = await jwtVerify(
      session.accessToken,
      new TextEncoder().encode(config.JWT_ACCESS_SECRET),
      {
        issuer: config.JWT_ISSUER,
        audience: config.JWT_ADMIN_AUDIENCE,
        algorithms: ['HS256'],
      },
    );

    expect(verified.payload.roles).toEqual(['client', 'admin']);
    expect(verified.payload.permissions).toEqual(['profile.read', 'notifications.manage']);
    expect(session.roles).toEqual(['client', 'admin']);
  });

  it('does not leak administrative claims into a normal client token', async () => {
    const session = await service({
      roles: ['client', 'admin'],
      permissions: ['profile.read', 'notifications.manage'],
    }).refreshSession(
      'local-padel',
      'existing-refresh-token',
      'client-auth-test-correlation',
      'client-auth-idempotency-test-0001',
      'client',
    );
    const claims = decodeJwt(session.accessToken);

    expect(claims.roles).toEqual(['client']);
    expect(claims.permissions).toEqual(['profile.read']);
  });

  it('allows a location-only operator into the admin audience without leaking location grants', async () => {
    const locationAccess = {
      roles: ['client', 'admin'],
      permissions: ['profile.read', 'locations.read', 'locations.manage', 'locations.publish'],
    };
    const adminSession = await service(locationAccess).refreshSession(
      'local-padel',
      'existing-refresh-token',
      'location-admin-auth-correlation',
      'location-admin-auth-idempotency-0001',
      'admin',
    );
    expect(decodeJwt(adminSession.accessToken).permissions).toEqual(locationAccess.permissions);

    const clientSession = await service(locationAccess).refreshSession(
      'local-padel',
      'existing-refresh-token',
      'location-client-auth-correlation',
      'location-client-auth-idempotency-0001',
      'client',
    );
    expect(decodeJwt(clientSession.accessToken).permissions).toEqual(['profile.read']);
  });

  it('rejects admin audience issuance without the explicit grant', async () => {
    await expect(
      service({ roles: ['client'], permissions: ['profile.read'] }).refreshSession(
        'local-padel',
        'existing-refresh-token',
        'denied-auth-test-correlation',
        'denied-auth-idempotency-test-0001',
        'admin',
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'AUTH_ADMIN_ACCESS_DENIED' }));
  });

  it('checks admin access before rotating a browser refresh session', async () => {
    const rotateRefreshSession = vi.fn();
    const repository = {
      resolveTenantAuthBinding: () =>
        Promise.resolve({
          tenantId,
          tenantKey: 'local-padel',
          provider: 'LOCAL' as const,
          providerTenantKey: 'local-padel',
        }),
      getRefreshSessionPrincipal: () => Promise.resolve({ tenantId, userId: user.id }),
      getUserAccessProfile: () =>
        Promise.resolve({ roles: ['client'], permissions: ['profile.read'] }),
      rotateRefreshSession,
    } as unknown as AuthRepository;
    const authService = new AuthService({
      config,
      repository,
      challengeStore: {} as never,
      providers: new Map(),
    });

    await expect(
      authService.refreshSession(
        'local-padel',
        'existing-refresh-token',
        'preflight-auth-test-correlation',
        'preflight-auth-idempotency-test-0001',
        'admin',
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'AUTH_ADMIN_ACCESS_DENIED' }));
    expect(rotateRefreshSession).not.toHaveBeenCalled();
  });
});
