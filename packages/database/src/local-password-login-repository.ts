import type { Pool, QueryResultRow } from 'pg';

import { queryOne, withTenantTransaction } from './connection.js';

export interface LocalPasswordCredential {
  readonly id: string;
  readonly userId: string;
  readonly generation: number;
  readonly passwordHash: string;
}
export interface LocalPasswordLoginInput {
  readonly tenantId: string;
  readonly emailKey: string;
  readonly credential: LocalPasswordCredential;
  readonly commandKeyHash: string;
  readonly requestHash: string;
  readonly sessionId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly correlationId: string;
}
export type LocalPasswordLoginResult =
  | { readonly outcome: 'invalid' | 'conflict' }
  | {
      readonly outcome: 'created' | 'replayed';
      readonly sessionId: string;
      readonly expiresAt: string;
      readonly user: {
        readonly id: string;
        readonly tenantId: string;
        readonly displayName: string;
        readonly phoneLast4?: string;
      };
    };
export interface LocalPasswordLoginRepository {
  findCredential(
    this: void,
    tenantId: string,
    emailKey: string,
  ): Promise<LocalPasswordCredential | undefined>;
  commitLogin(this: void, input: LocalPasswordLoginInput): Promise<LocalPasswordLoginResult>;
}
interface CredentialRow extends QueryResultRow {
  id: string;
  user_id: string;
  generation: number;
  password_hash: string;
  display_name: string;
  phone_last_4: string | null;
}
interface ReceiptRow extends QueryResultRow {
  request_hash: string;
  derivation_version: string;
  user_id: string;
  credential_id: string;
  credential_generation: number;
  session_id: string;
}
interface SessionRow extends QueryResultRow {
  id: string;
  expires_at: Date;
}
class ReceiptConflictError extends Error {}
const credentialSql = `select c.id, c.user_id, c.generation, c.password_hash,
  p.display_name, right(p.phone_e164, 4) as phone_last_4
  from identity.local_email_credentials c
  join identity.users u on u.tenant_id = c.tenant_id and u.id = c.user_id
  join profile.user_summaries p on p.tenant_id = u.tenant_id and p.user_id = u.id
  where c.tenant_id = $1 and c.email_key = $2 and c.status = 'ACTIVE'
    and u.status = 'ACTIVE' and c.email_verified_at <= now()`;

/** Login capability only. No enrollment/reset/contact writes or provider lookup. */
export function createLocalPasswordLoginRepository(pool: Pool): LocalPasswordLoginRepository {
  return {
    findCredential(tenantId, emailKey) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        await client.query("set local statement_timeout = '3s'");
        const row = await queryOne<CredentialRow>(client, credentialSql, [tenantId, emailKey]);
        return row
          ? {
              id: row.id,
              userId: row.user_id,
              generation: row.generation,
              passwordHash: row.password_hash,
            }
          : undefined;
      });
    },
    async commitLogin(input) {
      if (
        ![input.commandKeyHash, input.requestHash, input.tokenHash].every((value) =>
          /^[0-9a-f]{64}$/.test(value),
        )
      )
        throw new Error('LOCAL_PASSWORD_LOGIN_DIGEST_INVALID');
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.correlationId))
        throw new Error('LOCAL_PASSWORD_LOGIN_CORRELATION_INVALID');
      if (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= Date.now())
        throw new Error('LOCAL_PASSWORD_LOGIN_EXPIRY_INVALID');
      try {
        return await withTenantTransaction(
          pool,
          input.tenantId,
          async (client): Promise<LocalPasswordLoginResult> => {
            await client.query("set local lock_timeout = '2s'");
            await client.query("set local statement_timeout = '5s'");
            // Every credential/reset writer must take this same account lock before touching the method.
            const account = await queryOne(
              client,
              "select id from identity.users where tenant_id = $1 and id = $2 and status = 'ACTIVE' for update",
              [input.tenantId, input.credential.userId],
            );
            if (!account) return { outcome: 'invalid' };
            const current = await queryOne<CredentialRow>(client, credentialSql, [
              input.tenantId,
              input.emailKey,
            ]);
            if (
              !current ||
              current.id !== input.credential.id ||
              current.user_id !== input.credential.userId ||
              current.generation !== input.credential.generation ||
              current.password_hash !== input.credential.passwordHash
            )
              return { outcome: 'invalid' };
            const receipt = await queryOne<ReceiptRow>(
              client,
              `select request_hash, derivation_version, user_id, credential_id, credential_generation, session_id
             from identity.local_password_login_receipts where tenant_id = $1 and command_key_hash = $2`,
              [input.tenantId, input.commandKeyHash],
            );
            let session: SessionRow | undefined;
            if (receipt) {
              if (receipt.derivation_version !== 'LOCAL_PASSWORD_V1') return { outcome: 'invalid' };
              if (
                receipt.request_hash !== input.requestHash ||
                receipt.user_id !== current.user_id ||
                receipt.credential_id !== current.id ||
                receipt.credential_generation !== current.generation
              )
                return { outcome: 'conflict' };
              session = await queryOne<SessionRow>(
                client,
                `select id, expires_at from identity.refresh_sessions
               where tenant_id = $1 and user_id = $2 and id = $3 and id = $4 and token_hash = $5
                 and family_id = id and parent_session_id is null and rotated_at is null
                 and revoked_at is null and expires_at > now()`,
                [
                  input.tenantId,
                  current.user_id,
                  receipt.session_id,
                  input.sessionId,
                  input.tokenHash,
                ],
              );
              if (!session) return { outcome: 'invalid' };
            } else {
              session = await queryOne<SessionRow>(
                client,
                `insert into identity.refresh_sessions (id, tenant_id, user_id, family_id, token_hash, expires_at)
               values ($1, $2, $3, $1, $4, $5) returning id, expires_at`,
                [
                  input.sessionId,
                  input.tenantId,
                  current.user_id,
                  input.tokenHash,
                  input.expiresAt,
                ],
              );
              const inserted = await queryOne(
                client,
                `insert into identity.local_password_login_receipts
                 (tenant_id, command_key_hash, request_hash, user_id, credential_id, credential_generation, session_id, expires_at, derivation_version )
               values ($1, $2, $3, $4, $5, $6, $7, $8, 'LOCAL_PASSWORD_V1')
               on conflict (tenant_id, command_key_hash) do nothing returning session_id`,
                [
                  input.tenantId,
                  input.commandKeyHash,
                  input.requestHash,
                  current.user_id,
                  current.id,
                  current.generation,
                  input.sessionId,
                  input.expiresAt,
                ],
              );
              // Different accounts can race on one tenant-scoped key: roll back the losing session.
              if (!inserted) throw new ReceiptConflictError();
              await client.query(
                `insert into audit.audit_log (tenant_id, actor_id, action, resource_type, resource_id, result, reason, correlation_id)
               values ($1, $2, 'AUTH_PASSWORD_SESSION_CREATED', 'AUTH_SESSION', $3, 'SUCCESS', 'LOCAL_PASSWORD', $4)`,
                [input.tenantId, current.user_id, input.sessionId, input.correlationId],
              );
            }
            if (!session) throw new Error('LOCAL_PASSWORD_SESSION_CREATE_FAILED');
            return {
              outcome: receipt ? 'replayed' : 'created',
              sessionId: session.id,
              expiresAt: session.expires_at.toISOString(),
              user: {
                id: current.user_id,
                tenantId: input.tenantId,
                displayName: current.display_name,
                ...(current.phone_last_4 ? { phoneLast4: current.phone_last_4 } : {}),
              },
            };
          },
        );
      } catch (error) {
        if (error instanceof ReceiptConflictError) return { outcome: 'conflict' };
        throw error;
      }
    },
  };
}
