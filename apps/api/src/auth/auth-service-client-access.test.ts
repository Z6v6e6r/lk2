import { FULL_CLIENT_PERMISSIONS } from '@phub/auth';
import { loadConfig } from '@phub/config';
import { decodeJwt } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { AuthService, type AuthRepository, type AuthUser } from './auth-service.js';

const environment = {
  APP_ENV: 'ci',
  DATABASE_URL: 'postgresql://phub:test@localhost:5432/phub',
  REDIS_URL: 'redis://localhost:6379',
  RABBITMQ_URL: 'amqp://phub:test@localhost:5672',
  JWT_ISSUER: 'phub-identity',
  JWT_AUDIENCE: 'phub-api',
  JWT_ADMIN_AUDIENCE: 'phub-admin',
  JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters',
  JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters',
} as const;

const config = loadConfig(environment);
const betaConfig = loadConfig({ ...environment, BETA_FULL_CLIENT_ACCESS_ENABLED: 'true' });
const tenantId = '86afbe01-0318-4dd2-bc25-303b7bf0d430';
const sessionId = '55555555-5555-4555-8555-555555555555';
const user: AuthUser = {
  id: '49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca',
  tenantId,
  displayName: 'Игрок',
};

/**
 * A peer who registered after the last `user:access:beta-full` backfill: the stored profile has no
 * `chat.direct.create`, so every messaging gate below the token refuses them, while the beta switch
 * still adds the catalog to the token itself.
 */
function service(
  input: {
    readonly access?: {
      readonly roles: readonly string[];
      readonly permissions: readonly string[];
    };
    readonly persisted?: {
      readonly roles: readonly string[];
      readonly permissions: readonly string[];
    };
    readonly serviceConfig?: typeof config;
    readonly withEnsure?: boolean;
    readonly resolveUndefined?: boolean;
    readonly rejectEnsure?: boolean;
  } = {},
) {
  const ensureClientPermissions = vi.fn().mockResolvedValue(
    input.persisted ?? {
      roles: ['client'],
      permissions: [...FULL_CLIENT_PERMISSIONS],
    },
  );
  if (input.resolveUndefined) ensureClientPermissions.mockResolvedValue(undefined);
  if (input.rejectEnsure) {
    ensureClientPermissions.mockRejectedValue(new Error('USER_ACCESS_WRITE_FAILED'));
  }
  const onClientAccessConvergenceFailure = vi.fn();
  const getUserAccessProfile = vi
    .fn()
    .mockResolvedValue(input.access ?? { roles: ['client'], permissions: ['profile.read'] });
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
          sessionId,
          tenantId,
          tenantKey: 'local-padel',
          user,
        },
      }),
    getUserAccessProfile,
    ...(input.withEnsure === false ? {} : { ensureClientPermissions }),
  } as unknown as AuthRepository;
  return {
    service: new AuthService({
      config: input.serviceConfig ?? config,
      repository,
      challengeStore: {} as never,
      providers: new Map(),
      onClientAccessConvergenceFailure,
    }),
    ensureClientPermissions,
    getUserAccessProfile,
    onClientAccessConvergenceFailure,
  };
}

function refresh(
  authService: AuthService,
  audience: 'client' | 'admin' = 'client',
): ReturnType<AuthService['refreshSession']> {
  return authService.refreshSession(
    'local-padel',
    'existing-refresh-token',
    'client-access-correlation',
    'client-access-idempotency-0001',
    audience,
  );
}

describe('closed-beta client access convergence', () => {
  it('makes the beta catalog durable before a client token carries it', async () => {
    const { service: authService, ensureClientPermissions } = service({
      serviceConfig: betaConfig,
      persisted: { roles: ['client'], permissions: [...FULL_CLIENT_PERMISSIONS] },
    });

    const session = await refresh(authService);

    expect(ensureClientPermissions).toHaveBeenCalledWith({
      tenantId,
      userId: user.id,
      permissions: [...FULL_CLIENT_PERMISSIONS],
      correlationId: 'client-access-correlation',
    });
    // The token is signed from the converged profile, so the stored row and the claims agree.
    expect(decodeJwt(session.accessToken).permissions).toEqual(
      expect.arrayContaining([...FULL_CLIENT_PERMISSIONS]),
    );
    expect(session.permissions).toContain('chat.direct.create');
  });

  it('keeps every operator-granted role and permission the stored row already had', async () => {
    const { service: authService, ensureClientPermissions } = service({
      serviceConfig: betaConfig,
      persisted: {
        roles: ['client', 'admin'],
        permissions: [...FULL_CLIENT_PERMISSIONS, 'notifications.manage'],
      },
    });

    const session = await refresh(authService);

    // The repository owns the union; the service must never send a narrowed set to overwrite it.
    expect(ensureClientPermissions).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: [...FULL_CLIENT_PERMISSIONS] }),
    );
    // Admin-only claims are still stripped from a client token.
    expect(decodeJwt(session.accessToken).permissions).not.toContain('notifications.manage');
    expect(decodeJwt(session.accessToken).roles).toEqual(['client']);
  });

  it('does not touch the stored profile while the beta switch is off', async () => {
    const {
      service: authService,
      ensureClientPermissions,
      getUserAccessProfile,
    } = service({
      access: { roles: ['client'], permissions: ['profile.read'] },
    });

    const session = await refresh(authService);

    expect(ensureClientPermissions).not.toHaveBeenCalled();
    expect(getUserAccessProfile).toHaveBeenCalledWith(tenantId, user.id);
    expect(decodeJwt(session.accessToken).permissions).toEqual(['profile.read']);
  });

  it('leaves the stored profile untouched for the admin audience', async () => {
    const {
      service: authService,
      ensureClientPermissions,
      getUserAccessProfile,
    } = service({
      serviceConfig: betaConfig,
      access: { roles: ['client', 'admin'], permissions: ['profile.read', 'notifications.manage'] },
    });

    await refresh(authService, 'admin');

    expect(ensureClientPermissions).not.toHaveBeenCalled();
    expect(getUserAccessProfile).toHaveBeenCalledWith(tenantId, user.id);
  });

  it('degrades to the stored profile when the repository cannot converge it', async () => {
    const { service: authService, getUserAccessProfile } = service({
      serviceConfig: betaConfig,
      access: { roles: ['client'], permissions: ['profile.read'] },
      withEnsure: false,
    });

    const session = await refresh(authService);

    expect(getUserAccessProfile).toHaveBeenCalledWith(tenantId, user.id);
    expect(session.accessToken).toEqual(expect.any(String));
  });

  it('falls back to the stored profile when the convergence write fails', async () => {
    // The refresh token has already rotated by now, so a write failure must not cost a login.
    const {
      service: authService,
      getUserAccessProfile,
      onClientAccessConvergenceFailure,
    } = service({
      serviceConfig: betaConfig,
      access: { roles: ['client'], permissions: ['profile.read'] },
      rejectEnsure: true,
    });

    const session = await refresh(authService);

    expect(getUserAccessProfile).toHaveBeenCalledWith(tenantId, user.id);
    expect(session.accessToken).toEqual(expect.any(String));
    const failure = onClientAccessConvergenceFailure.mock.calls[0]?.[0] as
      | {
          readonly tenantId: string;
          readonly userId: string;
          readonly correlationId: string;
          readonly error: unknown;
        }
      | undefined;
    expect(failure?.tenantId).toBe(tenantId);
    expect(failure?.userId).toBe(user.id);
    expect(failure?.correlationId).toBe('client-access-correlation');
    expect(failure?.error).toBeInstanceOf(Error);
  });

  it('falls back to the stored profile when the convergence finds no row', async () => {
    const {
      service: authService,
      getUserAccessProfile,
      onClientAccessConvergenceFailure,
    } = service({
      serviceConfig: betaConfig,
      access: { roles: ['client'], permissions: ['profile.read'] },
      resolveUndefined: true,
    });

    const session = await refresh(authService);

    expect(getUserAccessProfile).toHaveBeenCalledWith(tenantId, user.id);
    expect(session.accessToken).toEqual(expect.any(String));
    expect(onClientAccessConvergenceFailure).not.toHaveBeenCalled();
  });
});
