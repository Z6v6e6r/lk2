import { createIdentityAuthRepository, type IdentityAuthRepository } from '@phub/database';
import type { Pool } from 'pg';

import type {
  AuthRepository,
  AuthUser,
  RefreshSessionRotation,
  TenantAuthBinding,
} from './auth-service.js';

export class PostgresAuthRepository implements AuthRepository {
  private readonly repository: IdentityAuthRepository;

  public constructor(pool: Pool) {
    this.repository = createIdentityAuthRepository(pool);
  }

  public async resolveTenantAuthBinding(tenantKey: string): Promise<TenantAuthBinding | undefined> {
    const context = await this.repository.resolveTenantAuthConfig(tenantKey);
    if (!context) return undefined;
    return {
      tenantId: context.tenantId,
      tenantKey: context.tenantKey,
      provider: context.provider,
      providerTenantKey: context.providerTenantKey ?? context.tenantKey,
    };
  }

  public upsertExternalIdentity(input: {
    readonly binding: TenantAuthBinding;
    readonly identity: {
      readonly issuer: string;
      readonly subject: string;
      readonly displayName: string;
      readonly phoneE164: string;
    };
    readonly correlationId: string;
  }): Promise<AuthUser> {
    return this.repository.upsertExternalUser({
      tenantId: input.binding.tenantId,
      provider: input.binding.provider,
      issuer: input.identity.issuer,
      subject: input.identity.subject,
      displayName: input.identity.displayName,
      phoneE164: input.identity.phoneE164,
      correlationId: input.correlationId,
    });
  }

  public async createRefreshSession(input: {
    readonly sessionId: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly tokenHash: string;
    readonly expiresAt: Date;
    readonly correlationId: string;
  }): Promise<void> {
    await this.repository.createRefreshSession({
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      correlationId: input.correlationId,
    });
  }

  public async rotateRefreshSession(input: {
    readonly tenantKey: string;
    readonly currentTokenHash: string;
    readonly nextTokenHash: string;
    readonly nextExpiresAt: Date;
    readonly correlationId: string;
    readonly nextSessionId: string;
  }): Promise<RefreshSessionRotation> {
    const context = await this.repository.resolveTenantAuthConfig(input.tenantKey);
    if (!context) return { outcome: 'invalid' };
    const result = await this.repository.rotateRefreshSession({
      tenantId: context.tenantId,
      currentTokenHash: input.currentTokenHash,
      nextTokenHash: input.nextTokenHash,
      nextExpiresAt: input.nextExpiresAt,
      correlationId: input.correlationId,
      nextSessionId: input.nextSessionId,
    });
    if (result.outcome === 'recent_replay') return { outcome: 'race' };
    if (result.outcome !== 'rotated') return { outcome: 'invalid' };
    return {
      outcome: 'rotated',
      identity: {
        sessionId: result.session.id,
        tenantId: result.session.tenantId,
        tenantKey: context.tenantKey,
        user: result.user,
      },
    };
  }

  public async revokeRefreshSession(
    tenantKey: string,
    tokenHash: string,
    correlationId: string,
  ): Promise<boolean> {
    const context = await this.repository.resolveTenantAuthConfig(tenantKey);
    if (!context) return false;
    return this.repository.revokeRefreshSession({
      tenantId: context.tenantId,
      tokenHash,
      reason: 'USER_LOGOUT',
      correlationId,
    });
  }

  public getUserContext(tenantId: string, userId: string): Promise<AuthUser | undefined> {
    return this.repository.getAuthUser(tenantId, userId);
  }

  public async findRefreshSessionById(
    tenantKey: string,
    sessionId: string,
  ): Promise<
    | {
        readonly sessionId: string;
        readonly tenantId: string;
        readonly tenantKey: string;
        readonly user: AuthUser;
      }
    | undefined
  > {
    const context = await this.repository.resolveTenantAuthConfig(tenantKey);
    if (!context) return undefined;
    const result = await this.repository.findActiveRefreshSessionById({
      tenantId: context.tenantId,
      sessionId,
    });
    if (!result) return undefined;
    return {
      sessionId: result.session.id,
      tenantId: result.session.tenantId,
      tenantKey: context.tenantKey,
      user: result.user,
    };
  }
}
