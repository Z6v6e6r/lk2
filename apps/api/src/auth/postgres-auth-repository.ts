import { createIdentityAuthRepository, type IdentityAuthRepository } from '@phub/database';
import type { Pool, PoolClient } from 'pg';

import type {
  AuthRepository,
  AuthUser,
  RefreshSessionRotation,
  TenantAuthBinding,
} from './auth-service.js';

export class PostgresAuthRepository implements AuthRepository {
  private readonly repository: IdentityAuthRepository;

  public constructor(private readonly pool: Pool) {
    this.repository = createIdentityAuthRepository(pool);
  }

  private async withTenant<T>(
    tenantId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await operation(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
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
      readonly providerUserId?: string;
      readonly displayName: string;
      readonly phoneE164?: string;
    };
    readonly correlationId: string;
  }): Promise<AuthUser> {
    return this.repository.upsertExternalUser({
      tenantId: input.binding.tenantId,
      provider: input.binding.provider,
      issuer: input.identity.issuer,
      subject: input.identity.subject,
      ...(input.identity.providerUserId ? { providerUserId: input.identity.providerUserId } : {}),
      displayName: input.identity.displayName,
      ...(input.identity.phoneE164 ? { phoneE164: input.identity.phoneE164 } : {}),
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

  public async revokeVivaDelegationForRefreshSession(
    tenantKey: string,
    tokenHash: string,
    correlationId: string,
  ): Promise<void> {
    const context = await this.repository.resolveTenantAuthConfig(tenantKey);
    if (!context) return;
    await this.withTenant(context.tenantId, async (client) => {
      const result = await client.query(
        `
          update integration.user_delegations d
          set revoked_at = now(), revoke_reason = 'USER_LOGOUT', updated_at = now()
          where d.tenant_id = $1
            and d.user_id = (
              select rs.user_id
              from identity.refresh_sessions rs
              where rs.tenant_id = $1 and rs.token_hash = $2
              limit 1
            )
            and d.revoked_at is null
        `,
        [context.tenantId, tokenHash],
      );
      if (result.rowCount) {
        await client.query(
          `insert into audit.audit_log (tenant_id, action, resource_type, result, correlation_id)
           values ($1, 'VIVA_DELEGATION_REVOKED', 'VIVA_DELEGATION', 'SUCCESS', $2)`,
          [context.tenantId, correlationId],
        );
      }
    });
  }

  public getUserContext(tenantId: string, userId: string): Promise<AuthUser | undefined> {
    return this.repository.getAuthUser(tenantId, userId);
  }

  public saveVivaDelegation(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly issuer: string;
    readonly subject: string;
    readonly refreshTokenCiphertext: string;
    readonly encryptionKeyVersion: string;
    readonly grantedScopes: readonly string[];
    readonly refreshExpiresAt?: Date;
    readonly correlationId: string;
  }): Promise<void> {
    return this.withTenant(input.tenantId, async (client) => {
      // A canonical Viva profile can become linked to a newer OAuth subject/user
      // after legacy duplicate users are reconciled. Serialize all delegation
      // replacements for the canonical PadlHub user, remove an obsolete subject
      // already attached to that user, then transfer the subject-owned row.
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${input.tenantId}\u001f${input.userId}\u001fVIVA\u001f${input.issuer}`,
      ]);
      await client.query(
        `
          delete from integration.user_delegations
          where tenant_id = $1
            and user_id = $2
            and provider = 'VIVA'
            and issuer = $3
            and subject <> $4
        `,
        [input.tenantId, input.userId, input.issuer, input.subject],
      );
      await client.query(
        `
          insert into integration.user_delegations (
            tenant_id, user_id, provider, issuer, subject, refresh_token_ciphertext,
            encryption_key_version, granted_scopes, refresh_expires_at, last_refreshed_at
          ) values ($1, $2, 'VIVA', $3, $4, $5, $6, $7, $8, now())
          on conflict (tenant_id, issuer, subject)
          do update set
            user_id = excluded.user_id,
            provider = excluded.provider,
            refresh_token_ciphertext = excluded.refresh_token_ciphertext,
            encryption_key_version = excluded.encryption_key_version,
            granted_scopes = excluded.granted_scopes,
            refresh_expires_at = excluded.refresh_expires_at,
            last_refreshed_at = now(),
            refresh_failed_at = null,
            refresh_failure_code = null,
            revoked_at = null,
            revoke_reason = null,
            updated_at = now()
        `,
        [
          input.tenantId,
          input.userId,
          input.issuer,
          input.subject,
          input.refreshTokenCiphertext,
          input.encryptionKeyVersion,
          input.grantedScopes,
          input.refreshExpiresAt ?? null,
        ],
      );
      await client.query(
        `insert into audit.audit_log (tenant_id, actor_id, action, resource_type, result, correlation_id)
         values ($1, $2, 'VIVA_DELEGATION_SAVED', 'VIVA_DELEGATION', 'SUCCESS', $3)`,
        [input.tenantId, input.userId, input.correlationId],
      );
    });
  }

  public getVivaDelegation(input: { readonly tenantId: string; readonly userId: string }): Promise<
    | {
        readonly issuer: string;
        readonly subject: string;
        readonly refreshTokenCiphertext: string;
        readonly encryptionKeyVersion: string;
        readonly refreshExpiresAt?: string;
      }
    | undefined
  > {
    return this.withTenant(input.tenantId, async (client) => {
      const row = (
        await client.query<{
          issuer: string;
          subject: string;
          refresh_token_ciphertext: string;
          encryption_key_version: string;
          refresh_expires_at: Date | string | null;
        }>(
          `
            select issuer, subject, refresh_token_ciphertext, encryption_key_version, refresh_expires_at
            from integration.user_delegations
            where tenant_id = $1 and user_id = $2 and provider = 'VIVA' and revoked_at is null
            order by updated_at desc
            limit 1
          `,
          [input.tenantId, input.userId],
        )
      ).rows[0];
      if (!row) return undefined;
      return {
        issuer: row.issuer,
        subject: row.subject,
        refreshTokenCiphertext: row.refresh_token_ciphertext,
        encryptionKeyVersion: row.encryption_key_version,
        ...(row.refresh_expires_at
          ? { refreshExpiresAt: new Date(row.refresh_expires_at).toISOString() }
          : {}),
      };
    });
  }

  public recordLegalAcceptances(input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly correlationId: string;
    readonly source: 'VIVA_OAUTH';
    readonly publicOfferVersion: string;
    readonly personalDataPolicyVersion: string;
    readonly oauthStateHash: string;
  }): Promise<void> {
    return this.withTenant(input.tenantId, async (client) => {
      const intent = await client.query(
        `
          update legal.document_acceptance_intents
          set user_id = $2, completed_at = now()
          where tenant_id = $1 and state_hash = $3 and completed_at is null
        `,
        [input.tenantId, input.userId, input.oauthStateHash],
      );
      if (intent.rowCount !== 1) throw new Error('LEGAL_ACCEPTANCE_INTENT_NOT_FOUND');
      await client.query(
        `
          insert into legal.document_acceptances (
            tenant_id, user_id, document_kind, document_version, correlation_id, source
          ) values
            ($1, $2, 'PUBLIC_OFFER', $3, $5, $6),
            ($1, $2, 'PERSONAL_DATA_POLICY', $4, $5, $6)
          on conflict (tenant_id, user_id, document_kind, document_version) do nothing
        `,
        [
          input.tenantId,
          input.userId,
          input.publicOfferVersion,
          input.personalDataPolicyVersion,
          input.correlationId,
          input.source,
        ],
      );
    });
  }

  public recordLegalAcceptanceIntent(input: {
    readonly tenantId: string;
    readonly provider: 'vkid' | 'yandex';
    readonly stateHash: string;
    readonly correlationId: string;
    readonly publicOfferVersion: string;
    readonly personalDataPolicyVersion: string;
  }): Promise<void> {
    return this.withTenant(input.tenantId, async (client) => {
      await client.query(
        `
          insert into legal.document_acceptance_intents (
            tenant_id, state_hash, provider, public_offer_version,
            personal_data_policy_version, correlation_id
          ) values ($1, $2, $3, $4, $5, $6)
          on conflict (tenant_id, state_hash) do nothing
        `,
        [
          input.tenantId,
          input.stateHash,
          input.provider,
          input.publicOfferVersion,
          input.personalDataPolicyVersion,
          input.correlationId,
        ],
      );
      await client.query(
        `insert into audit.audit_log (tenant_id, action, resource_type, result, correlation_id)
         values ($1, 'LEGAL_ACCEPTANCE_INTENT_RECORDED', 'LEGAL_ACCEPTANCE', 'SUCCESS', $2)`,
        [input.tenantId, input.correlationId],
      );
    });
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
