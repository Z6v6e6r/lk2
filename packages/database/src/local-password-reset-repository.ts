import { timingSafeEqual } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { revokeAllRefreshSessionsForUserInTransaction } from './auth-repository.js';
import { queryOne, withTenantTransaction } from './connection.js';

interface ProofCommand {
  readonly tenantId: string;
  readonly proofId: string;
  readonly tokenHash: string;
  readonly commandKeyHash: string;
}
export interface PasswordResetSnapshot {
  readonly credentialId: string;
  readonly userId: string;
  readonly generation: number;
  readonly passwordHash: string;
  readonly consumed: boolean;
}
export interface PasswordResetCommit extends ProofCommand {
  readonly snapshot: PasswordResetSnapshot;
  readonly newPasswordHash?: string;
  readonly correlationId: string;
}
export interface LocalPasswordResetRepository {
  prepare(
    this: void,
    input: ProofCommand & { readonly emailKey: string },
  ): Promise<
    | { readonly outcome: 'prepared'; readonly emailKey: string }
    | { readonly outcome: 'invalid' | 'conflict' | 'limited' }
  >;
  activate(this: void, input: ProofCommand): Promise<boolean>;
  cancel(this: void, input: ProofCommand): Promise<void>;
  inspect(this: void, input: ProofCommand): Promise<PasswordResetSnapshot | undefined>;
  commit(
    this: void,
    input: PasswordResetCommit,
  ): Promise<'changed' | 'replayed' | 'retry' | 'invalid'>;
}
interface CredentialRow extends QueryResultRow {
  id: string;
  user_id: string;
  email_key: string;
  generation: number;
  password_hash: string;
}
interface ProofRow extends QueryResultRow {
  id: string;
  user_id: string;
  credential_id: string;
  credential_generation: number;
  command_key_hash: string;
  token_hash: string;
  status: string;
  attempts: number;
  unexpired: boolean;
}
class CommandConflictError extends Error {}
const hashPattern = /^[0-9a-f]{64}$/;
const passwordPattern = /^phub-scrypt-v1\$131072\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/;
function validCommand(input: ProofCommand): void {
  if (!hashPattern.test(input.tokenHash) || !hashPattern.test(input.commandKeyHash))
    throw new Error('PASSWORD_RESET_DIGEST_INVALID');
}
function sameHash(left: string, right: string): boolean {
  return (
    hashPattern.test(left) &&
    hashPattern.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  );
}
async function deadlines(client: PoolClient): Promise<void> {
  await client.query("set local lock_timeout = '2s'");
  await client.query("set local statement_timeout = '5s'");
}
async function lockAccount(client: PoolClient, tenantId: string, userId: string): Promise<boolean> {
  return !!(await queryOne(
    client,
    "select id from identity.users where tenant_id = $1 and id = $2 and status = 'ACTIVE' for update",
    [tenantId, userId],
  ));
}
async function credential(
  client: PoolClient,
  tenantId: string,
  userId: string,
): Promise<CredentialRow | undefined> {
  return queryOne<CredentialRow>(
    client,
    `select id, user_id, email_key, generation, password_hash from identity.local_email_credentials
    where tenant_id = $1 and user_id = $2 and status = 'ACTIVE' and email_verified_at <= now()`,
    [tenantId, userId],
  );
}
async function proof(client: PoolClient, input: ProofCommand): Promise<ProofRow | undefined> {
  return queryOne<ProofRow>(
    client,
    `select *, expires_at > clock_timestamp() as unexpired from identity.local_password_reset_proofs
    where tenant_id = $1 and id = $2`,
    [input.tenantId, input.proofId],
  );
}
async function authorizeProof(
  client: PoolClient,
  input: ProofCommand,
  row: ProofRow,
): Promise<boolean> {
  if (
    !row.unexpired ||
    !['DELIVERED', 'CONSUMED'].includes(row.status) ||
    row.attempts >= 5 ||
    row.command_key_hash !== input.commandKeyHash
  )
    return false;
  if (sameHash(row.token_hash, input.tokenHash)) return true;
  // A consumed command cannot be blocked by subsequent unauthenticated guesses.
  if (row.status === 'DELIVERED')
    await client.query(
      `update identity.local_password_reset_proofs
    set attempts = attempts + 1, status = case when attempts + 1 >= 5 then 'BLOCKED' else status end
    where tenant_id = $1 and id = $2`,
      [input.tenantId, input.proofId],
    );
  return false;
}

/** Internal trusted proof/reset owner. No routes, credential enrollment or runtime wiring. */
export function createLocalPasswordResetRepository(pool: Pool): LocalPasswordResetRepository {
  return {
    async prepare(input) {
      validCommand(input);
      try {
        return await withTenantTransaction(pool, input.tenantId, async (client) => {
          await deadlines(client);
          const initial = await queryOne<CredentialRow>(
            client,
            'select id, user_id from identity.local_email_credentials where tenant_id = $1 and email_key = $2',
            [input.tenantId, input.emailKey],
          );
          if (!initial || !(await lockAccount(client, input.tenantId, initial.user_id)))
            return { outcome: 'invalid' };
          const current = await credential(client, input.tenantId, initial.user_id);
          if (
            !current ||
            current.id !== initial.id ||
            current.email_key !== input.emailKey ||
            current.generation >= 2147483647
          )
            return { outcome: 'invalid' };
          if (
            await queryOne(
              client,
              'select id from identity.local_password_reset_proofs where tenant_id = $1 and command_key_hash = $2',
              [input.tenantId, input.commandKeyHash],
            )
          )
            return { outcome: 'conflict' };
          const rate = await queryOne<{ limited: boolean } & QueryResultRow>(
            client,
            `select count(*) >= 5 or coalesce(max(created_at) > now() - interval '1 minute', false) as limited
            from identity.local_password_reset_proofs where tenant_id = $1 and user_id = $2 and created_at > now() - interval '1 hour'`,
            [input.tenantId, current.user_id],
          );
          if (rate?.limited) return { outcome: 'limited' };
          const inserted = await queryOne(
            client,
            `insert into identity.local_password_reset_proofs
            (id, tenant_id, user_id, credential_id, credential_generation, command_key_hash, token_hash)
            values ($1, $2, $3, $4, $5, $6, $7) on conflict (tenant_id, command_key_hash) do nothing returning id`,
            [
              input.proofId,
              input.tenantId,
              current.user_id,
              current.id,
              current.generation,
              input.commandKeyHash,
              input.tokenHash,
            ],
          );
          if (!inserted) throw new CommandConflictError();
          return { outcome: 'prepared', emailKey: current.email_key };
        });
      } catch (error) {
        if (error instanceof CommandConflictError) return { outcome: 'conflict' };
        throw error;
      }
    },
    async activate(input) {
      validCommand(input);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await deadlines(client);
        const row = await proof(client, input);
        if (!row || !(await lockAccount(client, input.tenantId, row.user_id))) return false;
        const current = await credential(client, input.tenantId, row.user_id);
        if (
          !current ||
          current.id !== row.credential_id ||
          current.generation !== row.credential_generation
        )
          return false;
        const activated = await client.query(
          `update identity.local_password_reset_proofs set status = 'DELIVERED', delivered_at = now()
          where tenant_id = $1 and id = $2 and token_hash = $3 and command_key_hash = $4 and status = 'PENDING' and expires_at > clock_timestamp()`,
          [input.tenantId, input.proofId, input.tokenHash, input.commandKeyHash],
        );
        return activated.rowCount === 1;
      });
    },
    async cancel(input) {
      validCommand(input);
      await withTenantTransaction(pool, input.tenantId, async (client) => {
        await deadlines(client);
        const row = await proof(client, input);
        if (!row) return;
        // Serialize cancellation with consumption, including disabled accounts. Never undo a reset.
        await client.query(
          'select id from identity.users where tenant_id = $1 and id = $2 for update',
          [input.tenantId, row.user_id],
        );
        await client.query(
          `update identity.local_password_reset_proofs set status = 'CANCELLED'
          where tenant_id = $1 and id = $2 and token_hash = $3 and command_key_hash = $4 and status in ('PENDING','DELIVERED')`,
          [input.tenantId, input.proofId, input.tokenHash, input.commandKeyHash],
        );
      });
    },
    async inspect(input) {
      validCommand(input);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await deadlines(client);
        const initial = await proof(client, input);
        if (!initial || !(await lockAccount(client, input.tenantId, initial.user_id)))
          return undefined;
        const row = await proof(client, input);
        if (!row || !(await authorizeProof(client, input, row))) return undefined;
        const current = await credential(client, input.tenantId, row.user_id);
        if (
          !current ||
          current.id !== row.credential_id ||
          current.generation !== row.credential_generation + (row.status === 'CONSUMED' ? 1 : 0)
        )
          return undefined;
        return {
          credentialId: current.id,
          userId: current.user_id,
          generation: current.generation,
          passwordHash: current.password_hash,
          consumed: row.status === 'CONSUMED',
        };
      });
    },
    async commit(input) {
      validCommand(input);
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.correlationId))
        throw new Error('PASSWORD_RESET_CORRELATION_INVALID');
      if (input.newPasswordHash !== undefined && !passwordPattern.test(input.newPasswordHash))
        throw new Error('PASSWORD_RESET_HASH_INVALID');
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await deadlines(client);
        if (!(await lockAccount(client, input.tenantId, input.snapshot.userId))) return 'invalid';
        const row = await proof(client, input);
        if (
          !row ||
          row.user_id !== input.snapshot.userId ||
          row.credential_id !== input.snapshot.credentialId ||
          !(await authorizeProof(client, input, row))
        )
          return 'invalid';
        const current = await credential(client, input.tenantId, row.user_id);
        if (!current || current.id !== row.credential_id) return 'invalid';
        const receipt = await queryOne<{ resulting_generation: number } & QueryResultRow>(
          client,
          `select resulting_generation from identity.local_password_reset_receipts where tenant_id = $1 and command_key_hash = $2 and proof_id = $3`,
          [input.tenantId, input.commandKeyHash, input.proofId],
        );
        if (receipt) {
          if (row.status !== 'CONSUMED' || current.generation !== receipt.resulting_generation)
            return 'invalid';
          if (
            current.generation !== input.snapshot.generation ||
            current.password_hash !== input.snapshot.passwordHash
          )
            return 'retry';
          // The caller must verify the submitted password against this exact current snapshot for replay.
          return input.snapshot.consumed && input.newPasswordHash === undefined
            ? 'replayed'
            : 'retry';
        }
        if (
          row.status !== 'DELIVERED' ||
          input.snapshot.consumed ||
          !input.newPasswordHash ||
          current.generation !== row.credential_generation ||
          current.generation !== input.snapshot.generation ||
          current.password_hash !== input.snapshot.passwordHash ||
          current.generation >= 2147483647
        )
          return 'invalid';
        const consumed = await client.query(
          `update identity.local_password_reset_proofs set status = 'CONSUMED', consumed_at = clock_timestamp()
          where tenant_id = $1 and id = $2 and status = 'DELIVERED' and expires_at > clock_timestamp()`,
          [input.tenantId, input.proofId],
        );
        if (consumed.rowCount !== 1) return 'invalid';
        await client.query(
          `update identity.local_email_credentials set password_hash = $3, generation = generation + 1, updated_at = now()
          where tenant_id = $1 and id = $2`,
          [input.tenantId, current.id, input.newPasswordHash],
        );
        await revokeAllRefreshSessionsForUserInTransaction(client, {
          tenantId: input.tenantId,
          userId: current.user_id,
          reason: 'CREDENTIAL_RESET',
          correlationId: input.correlationId,
        });
        // Revoke local provider delegation custody; no call to Viva and no restoration by recovery.
        await client.query(
          `update integration.user_delegations set revoked_at = now(), revoke_reason = 'CREDENTIAL_RESET', updated_at = now()
          where tenant_id = $1 and user_id = $2 and revoked_at is null`,
          [input.tenantId, current.user_id],
        );
        await client.query(
          `insert into identity.local_password_reset_receipts
          (tenant_id, command_key_hash, proof_id, user_id, credential_id, credential_generation, resulting_generation)
          values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            input.tenantId,
            input.commandKeyHash,
            input.proofId,
            current.user_id,
            current.id,
            current.generation,
            current.generation + 1,
          ],
        );
        await client.query(
          `insert into audit.audit_log (tenant_id, actor_id, action, resource_type, resource_id, result, reason, correlation_id)
          values ($1, null, 'AUTH_LOCAL_PASSWORD_RESET', 'AUTH_CREDENTIAL', $2, 'SUCCESS', 'EMAIL_PROOF', $3)`,
          [input.tenantId, current.id, input.correlationId],
        );
        return 'changed';
      });
    },
  };
}
