import { timingSafeEqual } from 'node:crypto';

import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { externalSubjectAdvisoryKey } from './auth-repository.js';
import { queryOne, withTenantTransaction } from './connection.js';

export type ExternalSubjectLinkOutcome = 'LINKED' | 'UNCHANGED';

export interface SubjectLinkSessionContext {
  readonly familyId: string;
  readonly phoneE164?: string;
}

export interface SubjectLinkCommandIdentity {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly sessionFamilyId: string;
  readonly audience: 'client';
  readonly challengeId: string;
  readonly commandKeyHash: string;
  readonly requestHash: string;
}

export type SubjectLinkCommandInspection =
  | { readonly outcome: 'missing' }
  | { readonly outcome: 'replayed'; readonly result: ExternalSubjectLinkOutcome }
  | { readonly outcome: 'conflict' | 'challenge_used' };

export type SubjectLinkCommandResult =
  | { readonly outcome: 'completed'; readonly result: ExternalSubjectLinkOutcome }
  | { readonly outcome: 'replayed'; readonly result: ExternalSubjectLinkOutcome }
  | {
      readonly outcome:
        'conflict' | 'challenge_used' | 'invalid_session' | 'phone_drift' | 'foreign_subject';
    };

export interface PhoneSubjectLinkRepository {
  readSessionContext(input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly presentedSessionId: string;
  }): Promise<SubjectLinkSessionContext | undefined>;
  inspectCommand(input: SubjectLinkCommandIdentity): Promise<SubjectLinkCommandInspection>;
  completeCommand(
    input: SubjectLinkCommandIdentity & {
      readonly presentedSessionId: string;
      readonly phoneE164: string;
      readonly issuer: string;
      readonly subject: string;
      readonly correlationId: string;
    },
  ): Promise<SubjectLinkCommandResult>;
}

interface CommandRow extends QueryResultRow {
  readonly actor_user_id: string;
  readonly session_family_id: string;
  readonly challenge_id: string;
  readonly audience: string;
  readonly command_key_hash: string;
  readonly request_hash: string;
  readonly outcome: ExternalSubjectLinkOutcome | null;
  readonly completed_at: Date | string | null;
}

const digestPattern = /^[0-9a-f]{64}$/;

function sameDigest(left: string, right: string): boolean {
  return (
    digestPattern.test(left) &&
    digestPattern.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  );
}

function validIdentity(input: SubjectLinkCommandIdentity): void {
  if (!digestPattern.test(input.commandKeyHash) || !digestPattern.test(input.requestHash)) {
    throw new Error('SUBJECT_LINK_DIGEST_INVALID');
  }
}

async function deadlines(client: PoolClient): Promise<void> {
  await client.query("set local lock_timeout = '2s'");
  await client.query("set local statement_timeout = '5s'");
}

function commandMatches(row: CommandRow, input: SubjectLinkCommandIdentity): boolean {
  return (
    row.actor_user_id === input.actorUserId &&
    row.session_family_id === input.sessionFamilyId &&
    row.challenge_id === input.challengeId &&
    row.audience === input.audience &&
    row.command_key_hash === input.commandKeyHash &&
    sameDigest(row.request_hash, input.requestHash)
  );
}

async function inspectWithClient(
  client: PoolClient,
  input: SubjectLinkCommandIdentity,
): Promise<SubjectLinkCommandInspection> {
  const byKey = await queryOne<CommandRow>(
    client,
    `select actor_user_id, session_family_id, challenge_id, audience,
            command_key_hash, request_hash, outcome, completed_at
       from identity.external_subject_link_commands
      where tenant_id = $1 and command_key_hash = $2`,
    [input.tenantId, input.commandKeyHash],
  );
  if (byKey) {
    if (!commandMatches(byKey, input)) return { outcome: 'conflict' };
    if (!byKey.completed_at || !byKey.outcome) return { outcome: 'conflict' };
    return { outcome: 'replayed', result: byKey.outcome };
  }
  const byChallenge = await queryOne<{ command_key_hash: string } & QueryResultRow>(
    client,
    `select command_key_hash from identity.external_subject_link_commands
      where tenant_id = $1 and challenge_id = $2`,
    [input.tenantId, input.challengeId],
  );
  return byChallenge ? { outcome: 'challenge_used' } : { outcome: 'missing' };
}

async function activeSessionContext(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly presentedSessionId: string;
  },
  lock: boolean,
): Promise<SubjectLinkSessionContext | undefined> {
  const presented = await queryOne<
    { family_id: string; phone_e164: string | null } & QueryResultRow
  >(
    client,
    `select presented.family_id, profile.phone_e164
       from identity.refresh_sessions presented
       join identity.users actor
         on actor.tenant_id = presented.tenant_id and actor.id = presented.user_id
       join profile.user_summaries profile
         on profile.tenant_id = actor.tenant_id and profile.user_id = actor.id
      where presented.tenant_id = $1
        and presented.user_id = $2
        and presented.id = $3
        and presented.revoked_at is null
        and presented.expires_at > clock_timestamp()
        and actor.status = 'ACTIVE'
      ${lock ? 'for update of actor, profile, presented' : ''}`,
    [input.tenantId, input.actorUserId, input.presentedSessionId],
  );
  if (!presented) return undefined;
  const current = await client.query<{ id: string }>(
    `select current.id
       from identity.refresh_sessions current
      where current.tenant_id = $1
        and current.user_id = $2
        and current.family_id = $3
        and current.revoked_at is null
        and current.rotated_at is null
        and current.expires_at > clock_timestamp()
        and not exists (
          select 1 from identity.refresh_sessions revoked
           where revoked.tenant_id = current.tenant_id
             and revoked.family_id = current.family_id
             and revoked.revoked_at is not null
        )
      ${lock ? 'for update of current' : ''}`,
    [input.tenantId, input.actorUserId, presented.family_id],
  );
  if (current.rows.length !== 1) return undefined;
  return {
    familyId: presented.family_id,
    ...(presented.phone_e164 ? { phoneE164: presented.phone_e164 } : {}),
  };
}

class CommandUniqueConflict extends Error {}

export function createPhoneSubjectLinkRepository(pool: Pool): PhoneSubjectLinkRepository {
  const repository: PhoneSubjectLinkRepository = {
    readSessionContext(input) {
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await deadlines(client);
        return activeSessionContext(client, input, false);
      });
    },

    inspectCommand(input) {
      validIdentity(input);
      return withTenantTransaction(pool, input.tenantId, async (client) => {
        await deadlines(client);
        return inspectWithClient(client, input);
      });
    },

    async completeCommand(input) {
      validIdentity(input);
      try {
        return await withTenantTransaction(pool, input.tenantId, async (client) => {
          await deadlines(client);
          // The ordinary login/upsert path takes this exact lock before any account row. Keep the
          // same order here so login and link serialize without a subject-lock/user-row deadlock.
          await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
            externalSubjectAdvisoryKey(input),
          ]);
          const session = await activeSessionContext(client, input, true);
          if (!session || session.familyId !== input.sessionFamilyId) {
            return { outcome: 'invalid_session' } as const;
          }

          // Receipt replay is allowed only after the presented token is re-bound to the same active
          // family. It deliberately precedes phone/subject reads so a lost response remains replayable.
          const existing = await inspectWithClient(client, input);
          if (existing.outcome !== 'missing') return existing;
          if (session.phoneE164 !== input.phoneE164) return { outcome: 'phone_drift' } as const;

          const phoneOwners = await client.query<{ user_id: string }>(
            `select user_id from profile.user_summaries
              where tenant_id = $1 and phone_e164 = $2
              order by user_id
              limit 2
              for key share`,
            [input.tenantId, input.phoneE164],
          );
          if (phoneOwners.rows.length !== 1 || phoneOwners.rows[0]?.user_id !== input.actorUserId) {
            return { outcome: 'phone_drift' } as const;
          }

          const mapping = await queryOne<{ user_id: string; provider: string } & QueryResultRow>(
            client,
            `select user_id, provider from integration.external_identity_map
              where tenant_id = $1 and issuer = $2 and subject = $3
              for update`,
            [input.tenantId, input.issuer, input.subject],
          );
          if (mapping && (mapping.user_id !== input.actorUserId || mapping.provider !== 'VIVA')) {
            return { outcome: 'foreign_subject' } as const;
          }
          const result: ExternalSubjectLinkOutcome = mapping ? 'UNCHANGED' : 'LINKED';

          const command = await client.query<{ id: string }>(
            `insert into identity.external_subject_link_commands (
               tenant_id, actor_user_id, session_family_id, challenge_id,
               audience, command_key_hash, request_hash
             ) values ($1, $2, $3, $4, $5, $6, $7)
             on conflict do nothing
             returning id`,
            [
              input.tenantId,
              input.actorUserId,
              input.sessionFamilyId,
              input.challengeId,
              input.audience,
              input.commandKeyHash,
              input.requestHash,
            ],
          );
          const commandId = command.rows[0]?.id;
          if (!commandId) throw new CommandUniqueConflict();

          if (!mapping) {
            await client.query(
              `insert into integration.external_identity_map (
                 tenant_id, user_id, provider, issuer, subject
               ) values ($1, $2, 'VIVA', $3, $4)`,
              [input.tenantId, input.actorUserId, input.issuer, input.subject],
            );
          }
          const completed = await client.query(
            `update identity.external_subject_link_commands
                set outcome = $3, completed_at = clock_timestamp()
              where tenant_id = $1 and id = $2 and outcome is null and completed_at is null`,
            [input.tenantId, commandId, result],
          );
          if (completed.rowCount !== 1) throw new Error('SUBJECT_LINK_RECEIPT_NOT_COMPLETED');
          await client.query(
            `insert into audit.audit_log (
               tenant_id, actor_id, action, resource_type, resource_id, result, correlation_id
             ) values ($1, $2, 'AUTH_EXTERNAL_SUBJECT_LINK_COMPLETED',
                       'EXTERNAL_IDENTITY', $3, 'SUCCESS', $4)`,
            [input.tenantId, input.actorUserId, commandId, input.correlationId],
          );
          return { outcome: 'completed', result } as const;
        });
      } catch (error) {
        if (!(error instanceof CommandUniqueConflict)) throw error;
        const inspected = await repository.inspectCommand(input);
        return inspected.outcome === 'missing' ? { outcome: 'conflict' } : inspected;
      }
    },
  };
  return repository;
}
