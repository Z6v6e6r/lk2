import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export type TenantAuthProvider = 'VIVA' | 'LOCAL';

export interface TenantAuthContext {
  readonly tenantId: string;
  readonly tenantKey: string;
  readonly provider: TenantAuthProvider;
  readonly providerTenantKey?: string;
}

export interface AuthUser {
  readonly id: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly phoneLast4?: string;
}

export interface RefreshSession {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly familyId: string;
  readonly expiresAt: string;
}

export interface RefreshSessionWithUser {
  readonly session: RefreshSession;
  readonly user: AuthUser;
}

export interface UpsertExternalUserInput {
  readonly tenantId: string;
  readonly provider: TenantAuthProvider;
  readonly issuer: string;
  readonly subject: string;
  readonly displayName: string;
  readonly phoneE164?: string;
  readonly email?: string;
  readonly photoUrl?: string;
  readonly correlationId: string;
}

export interface CreateRefreshSessionInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly sessionId?: string;
  readonly familyId?: string;
  readonly correlationId: string;
}

export interface RotateRefreshSessionInput {
  readonly tenantId: string;
  readonly currentTokenHash: string;
  readonly nextTokenHash: string;
  readonly nextExpiresAt: Date;
  readonly nextSessionId?: string;
  readonly correlationId: string;
}

export type RefreshSessionRotationResult =
  | {
      readonly outcome: 'rotated';
      readonly session: RefreshSession;
      readonly user: AuthUser;
    }
  | { readonly outcome: 'recent_replay' }
  | { readonly outcome: 'invalid' }
  | { readonly outcome: 'reuse_detected' };

export interface IdentityAuthRepository {
  resolveTenantAuthConfig(tenantKey: string): Promise<TenantAuthContext | undefined>;
  getAuthUser(tenantId: string, userId: string): Promise<AuthUser | undefined>;
  upsertExternalUser(input: UpsertExternalUserInput): Promise<AuthUser>;
  createRefreshSession(input: CreateRefreshSessionInput): Promise<RefreshSession>;
  findActiveRefreshSession(input: {
    readonly tenantId: string;
    readonly tokenHash: string;
  }): Promise<RefreshSession | undefined>;
  findActiveRefreshSessionById(input: {
    readonly tenantId: string;
    readonly sessionId: string;
  }): Promise<RefreshSessionWithUser | undefined>;
  rotateRefreshSession(input: RotateRefreshSessionInput): Promise<RefreshSessionRotationResult>;
  revokeRefreshSession(input: {
    readonly tenantId: string;
    readonly tokenHash: string;
    readonly reason?: string;
    readonly correlationId: string;
  }): Promise<boolean>;
}

interface TenantRow extends QueryResultRow {
  readonly id: string;
  readonly tenant_key: string;
}

interface TenantAuthRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly tenant_key: string;
  readonly provider: TenantAuthProvider;
  readonly provider_tenant_key: string | null;
}

interface AuthUserRow extends QueryResultRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly display_name: string;
  readonly phone_last_4: string | null;
}

interface RefreshSessionRow extends QueryResultRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly family_id: string;
  readonly expires_at: Date | string;
  readonly rotated_at?: Date | string | null;
  readonly revoked_at?: Date | string | null;
  readonly recently_rotated?: boolean;
  readonly replaced_by_session_id?: string | null;
}

const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

function assertTokenHash(value: string): void {
  if (!TOKEN_HASH_PATTERN.test(value)) {
    throw new Error('REFRESH_TOKEN_HASH_INVALID');
  }
}

function assertFutureExpiry(value: Date): void {
  if (!Number.isFinite(value.getTime()) || value.getTime() <= Date.now()) {
    throw new Error('REFRESH_SESSION_EXPIRY_INVALID');
  }
}

function mapTenantAuthContext(row: TenantAuthRow): TenantAuthContext {
  return {
    tenantId: row.tenant_id,
    tenantKey: row.tenant_key,
    provider: row.provider,
    ...(row.provider_tenant_key ? { providerTenantKey: row.provider_tenant_key } : {}),
  };
}

function mapAuthUser(row: AuthUserRow): AuthUser {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    displayName: row.display_name,
    ...(row.phone_last_4 ? { phoneLast4: row.phone_last_4 } : {}),
  };
}

function mapRefreshSession(row: RefreshSessionRow): RefreshSession {
  const expiresAt =
    row.expires_at instanceof Date
      ? row.expires_at.toISOString()
      : new Date(row.expires_at).toISOString();
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    familyId: row.family_id,
    expiresAt,
  };
}

async function getAuthUserWithClient(
  client: PoolClient,
  tenantId: string,
  userId: string,
): Promise<AuthUser | undefined> {
  const row = await queryOne<AuthUserRow>(
    client,
    `
      select
        u.id,
        u.tenant_id,
        p.display_name,
        case when p.phone_e164 is null then null else right(p.phone_e164, 4) end as phone_last_4
      from identity.users u
      join profile.user_summaries p
        on p.tenant_id = u.tenant_id and p.user_id = u.id
      where u.tenant_id = $1 and u.id = $2 and u.status = 'ACTIVE'
    `,
    [tenantId, userId],
  );
  return row ? mapAuthUser(row) : undefined;
}

async function writeSecurityAudit(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorId: string;
    readonly action: string;
    readonly resourceType?: 'AUTH_SESSION' | 'EXTERNAL_IDENTITY';
    readonly resourceId: string;
    readonly correlationId: string;
  },
): Promise<void> {
  await client.query(
    `
      insert into audit.audit_log (
        tenant_id, actor_id, action, resource_type, resource_id, result, correlation_id
      ) values ($1, $2, $3, $4, $5, 'SUCCESS', $6)
    `,
    [
      input.tenantId,
      input.actorId,
      input.action,
      input.resourceType ?? 'AUTH_SESSION',
      input.resourceId,
      input.correlationId,
    ],
  );
}

async function selectExternalUserForUpdate(
  client: PoolClient,
  input: UpsertExternalUserInput,
): Promise<AuthUser | undefined> {
  const row = await queryOne<AuthUserRow>(
    client,
    `
      select
        u.id,
        u.tenant_id,
        p.display_name,
        case when p.phone_e164 is null then null else right(p.phone_e164, 4) end as phone_last_4
      from integration.external_identity_map e
      join identity.users u
        on u.tenant_id = e.tenant_id and u.id = e.user_id
      join profile.user_summaries p
        on p.tenant_id = u.tenant_id and p.user_id = u.id
      where e.tenant_id = $1 and e.issuer = $2 and e.subject = $3
      for update of e, u, p
    `,
    [input.tenantId, input.issuer, input.subject],
  );
  return row ? mapAuthUser(row) : undefined;
}

export function createIdentityAuthRepository(pool: Pool): IdentityAuthRepository {
  return {
    async resolveTenantAuthConfig(tenantKey) {
      const tenant = (
        await pool.query<TenantRow>(
          'select id, tenant_key from identity.tenants where tenant_key = $1 and active = true',
          [tenantKey],
        )
      ).rows[0];
      if (!tenant) return undefined;

      return withTenantTransaction(pool, tenant.id, async (client) => {
        const row = await queryOne<TenantAuthRow>(
          client,
          `
            select c.tenant_id, t.tenant_key, c.provider, c.provider_tenant_key
            from integration.identity_provider_bindings c
            join identity.tenants t on t.id = c.tenant_id
            where c.tenant_id = $1 and t.active = true
          `,
          [tenant.id],
        );
        return row ? mapTenantAuthContext(row) : undefined;
      });
    },

    getAuthUser(tenantId, userId) {
      return withTenantTransaction(pool, tenantId, (client) =>
        getAuthUserWithClient(client, tenantId, userId),
      );
    },

    upsertExternalUser(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        // Serialize first-login races without making phone a lookup key.
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}\u001f${input.issuer}\u001f${input.subject}`,
        ]);

        const existing = await selectExternalUserForUpdate(client, input);
        if (existing) {
          await client.query(
            `
              update integration.external_identity_map
              set provider = $4, last_seen_at = now()
              where tenant_id = $1 and issuer = $2 and subject = $3
            `,
            [input.tenantId, input.issuer, input.subject, input.provider],
          );
          await client.query(
            `
              update profile.user_summaries
              set
                display_name = $3,
                phone_e164 = coalesce($4, phone_e164),
                email = coalesce($5, email),
                photo_url = coalesce($6, photo_url),
                updated_at = now()
              where tenant_id = $1 and user_id = $2
            `,
            [
              input.tenantId,
              existing.id,
              input.displayName,
              input.phoneE164 ?? null,
              input.email ?? null,
              input.photoUrl ?? null,
            ],
          );
          await client.query(
            'update identity.users set updated_at = now() where tenant_id = $1 and id = $2',
            [input.tenantId, existing.id],
          );
          const updated = await getAuthUserWithClient(client, input.tenantId, existing.id);
          if (!updated) throw new Error('AUTH_USER_NOT_ACTIVE');
          await writeSecurityAudit(client, {
            tenantId: input.tenantId,
            actorId: existing.id,
            action: 'AUTH_IDENTITY_SYNCED',
            resourceType: 'EXTERNAL_IDENTITY',
            resourceId: existing.id,
            correlationId: input.correlationId,
          });
          return updated;
        }

        const user = await queryOne<{ id: string } & QueryResultRow>(
          client,
          `
            insert into identity.users (tenant_id)
            values ($1)
            returning id
          `,
          [input.tenantId],
        );
        if (!user) throw new Error('AUTH_USER_CREATE_FAILED');

        await client.query(
          `
            insert into profile.user_summaries (
              tenant_id, user_id, display_name, phone_e164, email, photo_url
            ) values ($1, $2, $3, $4, $5, $6)
          `,
          [
            input.tenantId,
            user.id,
            input.displayName,
            input.phoneE164 ?? null,
            input.email ?? null,
            input.photoUrl ?? null,
          ],
        );
        await client.query(
          `
            insert into integration.external_identity_map (
              tenant_id, user_id, provider, issuer, subject
            ) values ($1, $2, $3, $4, $5)
          `,
          [input.tenantId, user.id, input.provider, input.issuer, input.subject],
        );

        const created = await getAuthUserWithClient(client, input.tenantId, user.id);
        if (!created) throw new Error('AUTH_USER_CREATE_FAILED');
        await writeSecurityAudit(client, {
          tenantId: input.tenantId,
          actorId: user.id,
          action: 'AUTH_IDENTITY_LINKED',
          resourceType: 'EXTERNAL_IDENTITY',
          resourceId: user.id,
          correlationId: input.correlationId,
        });
        return created;
      });
    },

    createRefreshSession(input) {
      assertTokenHash(input.tokenHash);
      assertFutureExpiry(input.expiresAt);
      const sessionId = input.sessionId ?? randomUUID();
      const familyId = input.familyId ?? sessionId;
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<RefreshSessionRow>(
          client,
          `
            insert into identity.refresh_sessions (
              id, tenant_id, user_id, family_id, token_hash, expires_at
            )
            select $1, u.tenant_id, u.id, $4, $5, $6
            from identity.users u
            where u.tenant_id = $2 and u.id = $3 and u.status = 'ACTIVE'
            returning id, tenant_id, user_id, family_id, expires_at
          `,
          [sessionId, input.tenantId, input.userId, familyId, input.tokenHash, input.expiresAt],
        );
        if (!row) throw new Error('AUTH_USER_NOT_ACTIVE');
        await writeSecurityAudit(client, {
          tenantId: input.tenantId,
          actorId: input.userId,
          action: 'AUTH_SESSION_CREATED',
          resourceId: row.id,
          correlationId: input.correlationId,
        });
        return mapRefreshSession(row);
      });
    },

    findActiveRefreshSession(input) {
      assertTokenHash(input.tokenHash);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<RefreshSessionRow>(
          client,
          `
            select rs.id, rs.tenant_id, rs.user_id, rs.family_id, rs.expires_at
            from identity.refresh_sessions rs
            join identity.users u
              on u.tenant_id = rs.tenant_id and u.id = rs.user_id
            where
              rs.tenant_id = $1
              and rs.token_hash = $2
              and rs.revoked_at is null
              and rs.rotated_at is null
              and rs.expires_at > now()
              and u.status = 'ACTIVE'
          `,
          [input.tenantId, input.tokenHash],
        );
        return row ? mapRefreshSession(row) : undefined;
      });
    },

    findActiveRefreshSessionById(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<RefreshSessionRow>(
          client,
          `
            select rs.id, rs.tenant_id, rs.user_id, rs.family_id, rs.expires_at
            from identity.refresh_sessions rs
            join identity.users u
              on u.tenant_id = rs.tenant_id and u.id = rs.user_id
            where
              rs.tenant_id = $1
              and rs.id = $2
              and rs.revoked_at is null
              and rs.rotated_at is null
              and rs.expires_at > now()
              and u.status = 'ACTIVE'
          `,
          [input.tenantId, input.sessionId],
        );
        if (!row) return undefined;
        const user = await getAuthUserWithClient(client, row.tenant_id, row.user_id);
        return user ? { session: mapRefreshSession(row), user } : undefined;
      });
    },

    rotateRefreshSession(input) {
      assertTokenHash(input.currentTokenHash);
      assertTokenHash(input.nextTokenHash);
      assertFutureExpiry(input.nextExpiresAt);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const current = await queryOne<RefreshSessionRow>(
          client,
          `
            select
              rs.id,
              rs.tenant_id,
              rs.user_id,
              rs.family_id,
              rs.expires_at,
              rs.rotated_at,
              rs.revoked_at,
              rs.replaced_by_session_id,
              (rs.rotated_at is not null and rs.rotated_at > now() - interval '10 seconds')
                as recently_rotated
            from identity.refresh_sessions rs
            join identity.users u
              on u.tenant_id = rs.tenant_id and u.id = rs.user_id
            where rs.tenant_id = $1 and rs.token_hash = $2 and u.status = 'ACTIVE'
            for update of rs
          `,
          [input.tenantId, input.currentTokenHash],
        );
        if (!current || current.revoked_at) return { outcome: 'invalid' };

        if (current.rotated_at) {
          if (current.replaced_by_session_id) {
            const replay = await queryOne<RefreshSessionRow>(
              client,
              `
                select id, tenant_id, user_id, family_id, expires_at
                from identity.refresh_sessions
                where
                  tenant_id = $1
                  and id = $2
                  and token_hash = $3
                  and revoked_at is null
                  and expires_at > now()
              `,
              [input.tenantId, current.replaced_by_session_id, input.nextTokenHash],
            );
            if (replay) {
              const user = await getAuthUserWithClient(client, replay.tenant_id, replay.user_id);
              if (!user) return { outcome: 'invalid' };
              return { outcome: 'rotated', session: mapRefreshSession(replay), user };
            }
          }
          if (current.recently_rotated) return { outcome: 'recent_replay' };
          await client.query(
            `
              update identity.refresh_sessions
              set
                revoked_at = coalesce(revoked_at, now()),
                revoke_reason = coalesce(revoke_reason, 'TOKEN_REUSE_DETECTED')
              where tenant_id = $1 and family_id = $2
            `,
            [input.tenantId, current.family_id],
          );
          return { outcome: 'reuse_detected' };
        }
        if (new Date(current.expires_at).getTime() <= Date.now()) return { outcome: 'invalid' };

        const nextSessionId = input.nextSessionId ?? randomUUID();
        const next = await queryOne<RefreshSessionRow>(
          client,
          `
            insert into identity.refresh_sessions (
              id,
              tenant_id,
              user_id,
              family_id,
              token_hash,
              parent_session_id,
              expires_at
            ) values ($1, $2, $3, $4, $5, $6, $7)
            returning id, tenant_id, user_id, family_id, expires_at
          `,
          [
            nextSessionId,
            current.tenant_id,
            current.user_id,
            current.family_id,
            input.nextTokenHash,
            current.id,
            input.nextExpiresAt,
          ],
        );
        if (!next) throw new Error('REFRESH_SESSION_ROTATION_FAILED');

        await client.query(
          `
            update identity.refresh_sessions
            set rotated_at = now(), last_used_at = now(), replaced_by_session_id = $3
            where tenant_id = $1 and id = $2
          `,
          [input.tenantId, current.id, next.id],
        );
        const user = await getAuthUserWithClient(client, current.tenant_id, current.user_id);
        if (!user) throw new Error('AUTH_USER_NOT_ACTIVE');
        await writeSecurityAudit(client, {
          tenantId: input.tenantId,
          actorId: current.user_id,
          action: 'AUTH_SESSION_ROTATED',
          resourceId: next.id,
          correlationId: input.correlationId,
        });
        return { outcome: 'rotated', session: mapRefreshSession(next), user };
      });
    },

    revokeRefreshSession(input) {
      assertTokenHash(input.tokenHash);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const current = await queryOne<{ family_id: string; user_id: string } & QueryResultRow>(
          client,
          `
            select family_id, user_id
            from identity.refresh_sessions
            where tenant_id = $1 and token_hash = $2
            for update
          `,
          [input.tenantId, input.tokenHash],
        );
        if (!current) return false;

        const result = await client.query(
          `
            update identity.refresh_sessions
            set
              revoked_at = coalesce(revoked_at, now()),
              revoke_reason = coalesce(revoke_reason, $3)
            where tenant_id = $1 and family_id = $2
          `,
          [input.tenantId, current.family_id, input.reason ?? 'USER_LOGOUT'],
        );
        await writeSecurityAudit(client, {
          tenantId: input.tenantId,
          actorId: current.user_id,
          action: 'AUTH_SESSION_REVOKED',
          resourceId: current.family_id,
          correlationId: input.correlationId,
        });
        return (result.rowCount ?? 0) > 0;
      });
    },
  };
}
