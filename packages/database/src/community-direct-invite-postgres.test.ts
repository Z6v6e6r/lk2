import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenantTransaction } from './connection.js';
import { createCommunityDirectInviteRepository } from './community-direct-invite-repository.js';

const connectionString = process.env.COMMUNITY_DIRECT_INVITE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describePostgres('community DIRECT invite real PostgreSQL quota/grant invariants', () => {
  const pool = new Pool({ connectionString, max: 12 });
  const repository = createCommunityDirectInviteRepository(pool);
  const tenantId = randomUUID();
  const ownerUserId = randomUUID();
  const adminUserId = randomUUID();
  const operatorUserId = randomUUID();
  let sequence = 0;

  function command(actorUserId: string, prefix: string) {
    sequence += 1;
    const idempotencyKey = `${prefix}-${String(sequence).padStart(8, '0')}`;
    return {
      tenantId,
      actorUserId,
      idempotencyKey,
      requestHash: hash(idempotencyKey),
      correlationId: `postgres-${idempotencyKey}`,
    };
  }

  async function createCommunity(): Promise<string> {
    const communityId = randomUUID();
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `insert into communities.communities (
           tenant_id, id, title, visibility, join_policy, status, created_by
         ) values ($1, $2, $3, 'OPEN', 'INSTANT', 'ACTIVE', $4)`,
        [tenantId, communityId, `Quota integration ${communityId}`, ownerUserId],
      );
      await client.query(
        `insert into communities.memberships (
           tenant_id, community_id, user_id, role, status, joined_at
         ) values
           ($1, $2, $3, 'OWNER', 'ACTIVE', now()),
           ($1, $2, $4, 'ADMIN', 'ACTIVE', now())`,
        [tenantId, communityId, ownerUserId, adminUserId],
      );
    });
    return communityId;
  }

  async function issue(communityId: string, actorUserId: string, label: string) {
    const base = command(actorUserId, `issue-${label}`);
    return repository.issue({
      ...base,
      communityId,
      tokenHash: hash(`token-${base.idempotencyKey}`),
      tokenKeyId: 'postgres-integration',
      expectedIssuerMembershipRevision: 0,
    });
  }

  async function createGrant(communityId: string, label: string) {
    return repository.createQuotaGrant({
      ...command(operatorUserId, `grant-${label}`),
      communityId,
      capability: 'communities.invite.quota.override',
      reasonCode: 'INTEGRATION_TEST',
      ticketId: `TEST-${label}`,
    });
  }

  beforeAll(async () => {
    await pool.query(
      `insert into identity.tenants (id, tenant_key, display_name)
       values ($1, $2, $3)`,
      [tenantId, `direct-invite-${tenantId}`, 'DIRECT invite integration'],
    );
    await withTenantTransaction(pool, tenantId, async (client) => {
      await client.query(
        `insert into identity.users (tenant_id, id, status)
         values ($1, $2, 'ACTIVE'), ($1, $3, 'ACTIVE'), ($1, $4, 'ACTIVE')`,
        [tenantId, ownerUserId, adminUserId, operatorUserId],
      );
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('lets exactly one concurrent issuer consume one grant above the five-active cap', async () => {
    const communityId = await createCommunity();
    for (let index = 0; index < 5; index += 1) {
      await expect(issue(communityId, ownerUserId, `cap-seed-${index}`)).resolves.toMatchObject({
        outcome: 'issued',
      });
    }
    const granted = await createGrant(communityId, 'one-consumer');
    expect(granted).toMatchObject({ outcome: 'granted', grant: { state: 'ACTIVE' } });

    const results = await Promise.all([
      issue(communityId, ownerUserId, 'cap-race-owner'),
      issue(communityId, adminUserId, 'cap-race-admin'),
    ]);
    expect(results.filter((result) => result.outcome === 'issued')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'active_limit_exceeded')).toHaveLength(1);

    await withTenantTransaction(pool, tenantId, async (client) => {
      const grants = await client.query<{ state: string; consumed_by_invite_id: string | null }>(
        `select state, consumed_by_invite_id
           from communities.direct_invite_quota_grants
          where tenant_id = $1 and community_id = $2`,
        [tenantId, communityId],
      );
      expect(grants.rows).toHaveLength(1);
      expect(grants.rows[0]?.state).toBe('CONSUMED');
      expect(typeof grants.rows[0]?.consumed_by_invite_id).toBe('string');
      const active = await client.query<{ count: string }>(
        `select count(*)::text as count
           from communities.direct_invites
          where tenant_id = $1 and community_id = $2
            and state = 'ACTIVE' and expires_at > now()`,
        [tenantId, communityId],
      );
      expect(active.rows[0]?.count).toBe('6');
    });
  });

  it('rejects the twenty-first rolling ISSUE even after every prior link is revoked', async () => {
    const communityId = await createCommunity();
    for (let index = 0; index < 20; index += 1) {
      const issued = await issue(communityId, ownerUserId, `daily-${index}`);
      expect(issued.outcome).toBe('issued');
      if (issued.outcome !== 'issued') throw new Error('seed issue failed');
      await expect(
        repository.revoke({
          ...command(ownerUserId, `revoke-daily-${index}`),
          inviteId: issued.invite.id,
          expectedInviteRevision: 1,
        }),
      ).resolves.toMatchObject({ outcome: 'revoked' });
    }
    await expect(issue(communityId, ownerUserId, 'daily-21')).resolves.toMatchObject({
      outcome: 'daily_limit_exceeded',
    });
  });

  it('replays a successful ISSUE while saturated without consuming a grant', async () => {
    const communityId = await createCommunity();
    const replayBase = command(ownerUserId, 'replay-original');
    const replayInput = {
      ...replayBase,
      communityId,
      tokenHash: hash(`token-${replayBase.idempotencyKey}`),
      tokenKeyId: 'postgres-integration',
      expectedIssuerMembershipRevision: 0,
    };
    const original = await repository.issue(replayInput);
    expect(original).toMatchObject({ outcome: 'issued', replayed: false });
    for (let index = 0; index < 4; index += 1) {
      await expect(issue(communityId, ownerUserId, `replay-seed-${index}`)).resolves.toMatchObject({
        outcome: 'issued',
      });
    }
    const grant = await createGrant(communityId, 'replay-unused');
    expect(grant.outcome).toBe('granted');
    await expect(repository.issue(replayInput)).resolves.toMatchObject({
      outcome: 'issued',
      replayed: true,
    });
    await withTenantTransaction(pool, tenantId, async (client) => {
      const state = await client.query<{ state: string }>(
        `select state from communities.direct_invite_quota_grants
          where tenant_id = $1 and community_id = $2`,
        [tenantId, communityId],
      );
      expect(state.rows[0]?.state).toBe('ACTIVE');
    });
  });

  it('rolls back grant consumption and invite insertion when command evidence fails', async () => {
    const communityId = await createCommunity();
    for (let index = 0; index < 5; index += 1) {
      await expect(
        issue(communityId, ownerUserId, `rollback-seed-${index}`),
      ).resolves.toMatchObject({
        outcome: 'issued',
      });
    }
    await createGrant(communityId, 'rollback');
    const failing = command(ownerUserId, 'forced-command-failure');
    await pool.query(`
      create or replace function public.fail_direct_invite_test_command()
      returns trigger language plpgsql as $$
      begin
        if new.idempotency_key = '${failing.idempotencyKey}' then
          raise exception 'forced direct invite command failure';
        end if;
        return new;
      end
      $$;
      drop trigger if exists fail_direct_invite_test_command_trigger
        on communities.direct_invite_commands;
      create trigger fail_direct_invite_test_command_trigger
        before insert on communities.direct_invite_commands
        for each row execute function public.fail_direct_invite_test_command();
    `);
    await expect(
      repository.issue({
        ...failing,
        communityId,
        tokenHash: hash(`token-${failing.idempotencyKey}`),
        tokenKeyId: 'postgres-integration',
        expectedIssuerMembershipRevision: 0,
      }),
    ).rejects.toThrow('forced direct invite command failure');
    await withTenantTransaction(pool, tenantId, async (client) => {
      const grant = await client.query<{ state: string }>(
        `select state from communities.direct_invite_quota_grants
          where tenant_id = $1 and community_id = $2`,
        [tenantId, communityId],
      );
      expect(grant.rows[0]?.state).toBe('ACTIVE');
      const active = await client.query<{ count: string }>(
        `select count(*)::text as count from communities.direct_invites
          where tenant_id = $1 and community_id = $2
            and state = 'ACTIVE' and expires_at > now()`,
        [tenantId, communityId],
      );
      expect(active.rows[0]?.count).toBe('5');
    });
  });
});
