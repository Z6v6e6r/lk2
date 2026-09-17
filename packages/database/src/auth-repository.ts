import { randomUUID } from 'node:crypto';

// `profile.user_summaries (tenant_id, phone_e164)` is unique since migration 0091: a phone that a
// phone login verified can belong to one account per tenant. The provider profile sync is the only
// writer, so its violation is mapped to a stable code instead of leaking a raw 23505 to the caller.
const VERIFIED_PHONE_INDEX = 'user_summaries_phone_lookup_idx';

function isVerifiedPhoneConflict(error: unknown): boolean {
  const candidate = error as { readonly code?: unknown; readonly constraint?: unknown };
  return candidate?.code === '23505' && candidate?.constraint === VERIFIED_PHONE_INDEX;
}

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
  readonly providerUserId?: string;
  readonly displayName: string;
  readonly phoneE164?: string;
  readonly email?: string;
  readonly photoUrl?: string;
  readonly correlationId: string;
}

export interface ResolveExistingExternalUserInput {
  readonly tenantId: string;
  readonly provider: TenantAuthProvider;
  readonly issuer: string;
  readonly subject: string;
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

export interface FindExternalSubjectUserInput {
  readonly tenantId: string;
  readonly provider: TenantAuthProvider;
  readonly issuer: string;
  readonly subject: string;
}

export type ConfirmProfilePhoneOutcome =
  | { readonly outcome: 'confirmed'; readonly releasedPhoneLast4?: string }
  | { readonly outcome: 'already_confirmed' }
  | { readonly outcome: 'phone_taken' };

export interface ConfirmProfilePhoneInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly phoneE164: string;
  readonly challengeId: string;
  readonly correlationId: string;
}

export interface IdentityAuthRepository {
  resolveTenantAuthConfig(tenantKey: string): Promise<TenantAuthContext | undefined>;
  getAuthUser(tenantId: string, userId: string): Promise<AuthUser | undefined>;
  resolveExistingExternalUser(
    input: ResolveExistingExternalUserInput,
  ): Promise<AuthUser | undefined>;
  upsertExternalUser(input: UpsertExternalUserInput): Promise<AuthUser>;
  /**
   * Read-only: which account already owns this provider subject, if any. Phone confirmation uses it to
   * stop before writing when the code exchange lands on an account other than the caller.
   */
  findExternalSubjectUser(input: FindExternalSubjectUserInput): Promise<AuthUser | undefined>;
  /**
   * Writes an attested phone on one account inside one transaction: refuses when another account in the
   * tenant already holds the phone (verified or as its provider viewer phone), audits a real change
   * once, and reports the previous masked tail so the caller can tell the person what was released.
   */
  confirmProfilePhone(input: ConfirmProfilePhoneInput): Promise<ConfirmProfilePhoneOutcome>;
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

interface AuthUserStatusRow extends AuthUserRow {
  readonly status: 'ACTIVE' | 'DISABLED';
}

interface AuthUserWithStatus {
  readonly user: AuthUser;
  readonly status: AuthUserStatusRow['status'];
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
    readonly resourceType?: 'AUTH_SESSION' | 'EXTERNAL_IDENTITY' | 'PROFILE_PHONE';
    readonly resourceId: string;
    readonly correlationId: string;
    readonly newValue?: unknown;
  },
): Promise<void> {
  await client.query(
    `
      insert into audit.audit_log (
        tenant_id, actor_id, action, resource_type, resource_id, result, correlation_id, new_value
      ) values ($1, $2, $3, $4, $5, 'SUCCESS', $6, $7::jsonb)
    `,
    [
      input.tenantId,
      input.actorId,
      input.action,
      input.resourceType ?? 'AUTH_SESSION',
      input.resourceId,
      input.correlationId,
      input.newValue === undefined ? null : JSON.stringify(input.newValue),
    ],
  );
}

async function selectExternalUserForUpdate(
  client: PoolClient,
  input: Pick<UpsertExternalUserInput, 'tenantId' | 'provider' | 'issuer' | 'subject'>,
): Promise<AuthUserWithStatus | undefined> {
  const row = await queryOne<AuthUserStatusRow>(
    client,
    `
      select
        u.id,
        u.tenant_id,
        u.status,
        p.display_name,
        case when p.phone_e164 is null then null else right(p.phone_e164, 4) end as phone_last_4
      from integration.external_identity_map e
      join identity.users u
        on u.tenant_id = e.tenant_id and u.id = e.user_id
      join profile.user_summaries p
        on p.tenant_id = u.tenant_id and p.user_id = u.id
      where e.tenant_id = $1
        and e.provider = $2
        and e.issuer = $3
        and e.subject = $4
      for update of e, u, p
    `,
    [input.tenantId, input.provider, input.issuer, input.subject],
  );
  return row ? { user: mapAuthUser(row), status: row.status } : undefined;
}

async function selectCanonicalProviderUserForUpdate(
  client: PoolClient,
  input: UpsertExternalUserInput,
): Promise<AuthUserWithStatus | undefined> {
  if (!input.providerUserId) return undefined;
  const row = await queryOne<AuthUserStatusRow>(
    client,
    `
      select
        u.id,
        u.tenant_id,
        u.status,
        p.display_name,
        case when p.phone_e164 is null then null else right(p.phone_e164, 4) end as phone_last_4
      from integration.external_entity_map e
      join identity.users u
        on u.tenant_id = e.tenant_id and u.id = e.internal_id
      join profile.user_summaries p
        on p.tenant_id = u.tenant_id and p.user_id = u.id
      where e.tenant_id = $1
        and e.external_system = $2
        and e.entity_type = 'viva_profile'
        and e.external_id = $3
      for update of e, u, p
    `,
    [input.tenantId, input.provider, input.providerUserId],
  );
  return row ? { user: mapAuthUser(row), status: row.status } : undefined;
}

async function linkExternalIdentity(
  client: PoolClient,
  input: UpsertExternalUserInput,
  userId: string,
): Promise<void> {
  const row = await queryOne<{ user_id: string } & QueryResultRow>(
    client,
    `
      insert into integration.external_identity_map (
        tenant_id, user_id, provider, issuer, subject
      ) values ($1, $2, $3, $4, $5)
      on conflict (tenant_id, issuer, subject)
      do update set provider = excluded.provider, last_seen_at = now()
      returning user_id
    `,
    [input.tenantId, userId, input.provider, input.issuer, input.subject],
  );
  if (!row || row.user_id !== userId) throw new Error('AUTH_CANONICAL_IDENTITY_CONFLICT');
}

async function ensureCanonicalProviderMapping(
  client: PoolClient,
  input: UpsertExternalUserInput,
  userId: string,
): Promise<void> {
  if (!input.providerUserId) return;
  const row = await queryOne<{ internal_id: string } & QueryResultRow>(
    client,
    `
      insert into integration.external_entity_map (
        tenant_id, external_system, entity_type, internal_id, external_id,
        last_synced_at, sync_status, sync_error_code
      ) values ($1, $2, 'viva_profile', $3, $4, now(), 'synced', null)
      on conflict (tenant_id, external_system, entity_type, external_id)
      do update set last_synced_at = now(), sync_status = 'synced', sync_error_code = null
      returning internal_id
    `,
    [input.tenantId, input.provider, userId, input.providerUserId],
  );
  if (!row || row.internal_id !== userId) throw new Error('AUTH_CANONICAL_IDENTITY_CONFLICT');
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

    resolveExistingExternalUser(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `${input.tenantId}\u001f${input.issuer}\u001f${input.subject}`,
        ]);
        const identity = await selectExternalUserForUpdate(client, input);
        if (!identity) return undefined;
        if (identity.status !== 'ACTIVE') throw new Error('AUTH_USER_NOT_ACTIVE');
        const { user } = identity;
        await client.query(
          `
            update integration.external_identity_map
            set last_seen_at = now()
            where tenant_id = $1 and issuer = $2 and subject = $3
          `,
          [input.tenantId, input.issuer, input.subject],
        );
        await writeSecurityAudit(client, {
          tenantId: input.tenantId,
          actorId: user.id,
          action: 'AUTH_EXISTING_SUBJECT_RESOLVED',
          resourceType: 'EXTERNAL_IDENTITY',
          resourceId: user.id,
          correlationId: input.correlationId,
        });
        return user;
      });
    },

    upsertExternalUser(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        // Serialize first-login races by the canonical provider user when available,
        // without making phone or email an identity lookup key.
        await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
          input.providerUserId
            ? `${input.tenantId}\u001f${input.provider}\u001f${input.providerUserId}`
            : `${input.tenantId}\u001f${input.issuer}\u001f${input.subject}`,
        ]);

        const identityUser = await selectExternalUserForUpdate(client, input);
        const canonicalUser = await selectCanonicalProviderUserForUpdate(client, input);
        if (identityUser && identityUser.status !== 'ACTIVE') {
          throw new Error('AUTH_USER_NOT_ACTIVE');
        }
        if (canonicalUser && canonicalUser.status !== 'ACTIVE') {
          throw new Error('AUTH_USER_NOT_ACTIVE');
        }
        if (identityUser && canonicalUser && identityUser.user.id !== canonicalUser.user.id) {
          throw new Error('AUTH_CANONICAL_IDENTITY_CONFLICT');
        }
        const existing = (canonicalUser ?? identityUser)?.user;
        if (existing) {
          await linkExternalIdentity(client, input, existing.id);
          await ensureCanonicalProviderMapping(client, input, existing.id);
          try {
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
          } catch (error) {
            if (isVerifiedPhoneConflict(error))
              throw new Error('AUTH_PHONE_ALREADY_BOUND', { cause: error });
            throw error;
          }
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

        try {
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
        } catch (error) {
          if (isVerifiedPhoneConflict(error))
            throw new Error('AUTH_PHONE_ALREADY_BOUND', { cause: error });
          throw error;
        }
        await linkExternalIdentity(client, input, user.id);
        await ensureCanonicalProviderMapping(client, input, user.id);

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

    findExternalSubjectUser(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const row = await queryOne<AuthUserStatusRow>(
          client,
          `
            select
              u.id,
              u.tenant_id,
              u.status,
              p.display_name,
              case when p.phone_e164 is null then null else right(p.phone_e164, 4) end as phone_last_4
            from integration.external_identity_map e
            join identity.users u
              on u.tenant_id = e.tenant_id and u.id = e.user_id
            join profile.user_summaries p
              on p.tenant_id = u.tenant_id and p.user_id = u.id
            where e.tenant_id = $1
              and e.provider = $2
              and e.issuer = $3
              and e.subject = $4
          `,
          [input.tenantId, input.provider, input.issuer, input.subject],
        );
        return row ? mapAuthUser(row) : undefined;
      });
    },

    confirmProfilePhone(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        const current = await queryOne<{ readonly phone_e164: string | null }>(
          client,
          `
            select phone_e164
            from profile.user_summaries
            where tenant_id = $1 and user_id = $2
            for update
          `,
          [input.tenantId, input.userId],
        );
        if (!current) throw new Error('AUTH_USER_NOT_ACTIVE');
        if (current.phone_e164 === input.phoneE164) return { outcome: 'already_confirmed' };

        // Another account may hold the number either as its verified phone or as the provider viewer
        // phone the CUP resolver falls back to; both make the number unavailable.
        const taken = await queryOne<{ readonly holder: string }>(
          client,
          `
            select holder from (
              select user_id as holder
                from profile.user_summaries
               where tenant_id = $1 and phone_e164 = $2 and user_id <> $3
              union all
              select internal_id as holder
                from integration.external_entity_map
               where tenant_id = $1
                 and external_system = 'VIVA'
                 and entity_type = 'legacy_viewer_phone'
                 and external_id = $2
                 and internal_id <> $3
            ) holders
            limit 1
          `,
          [input.tenantId, input.phoneE164, input.userId],
        );
        if (taken) return { outcome: 'phone_taken' };

        try {
          await client.query(
            `
              update profile.user_summaries
              set phone_e164 = $3, updated_at = now()
              where tenant_id = $1 and user_id = $2
            `,
            [input.tenantId, input.userId, input.phoneE164],
          );
        } catch (error) {
          // The unique index is the atomic guard against a concurrent claim.
          if (isVerifiedPhoneConflict(error)) return { outcome: 'phone_taken' };
          throw error;
        }
        await writeSecurityAudit(client, {
          tenantId: input.tenantId,
          actorId: input.userId,
          action: 'PROFILE_PHONE_CONFIRMED',
          resourceType: 'PROFILE_PHONE',
          resourceId: input.userId,
          correlationId: input.correlationId,
          newValue: {
            challengeId: input.challengeId,
            source: 'LOGIN_ATTESTED',
            releasedPhoneLast4: current.phone_e164 ? current.phone_e164.slice(-4) : null,
          },
        });
        return {
          outcome: 'confirmed',
          ...(current.phone_e164 ? { releasedPhoneLast4: current.phone_e164.slice(-4) } : {}),
        };
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
