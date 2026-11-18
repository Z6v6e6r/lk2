/**
 * QA scenario 5 (authoritative) — activation confirmation must be idempotent.
 *
 * This proves the existing monthly subscription purchase, not the LK1 residency owner (#443)
 * or its separately prepared LK2 consumer (#684). The durable write path exercised here is:
 * a provider receipt is applied to `commerce.monthly_purchase_attempts`, moving the operation to
 * `PAID` and writing exactly one `SUBSCRIPTION_PURCHASE_STATE` audit row plus one outbox event
 * (packages/database/src/monthly-purchase-repository.ts:263-293, audit at :135-147).
 *
 * `saveReceipt()` short-circuits on `state === 'PAID'` or an identical receipt, so a retried
 * provider callback or a double-clicked confirmation must not duplicate the transition, the audit
 * row, the outbox event, or the attempt row. This test pins that.
 *
 * Local runs without SUBSCRIPTION_ACTIVATION_TEST_DATABASE_URL may skip. CI_REQUIRE_QA_POSTGRES=1
 * refuses a missing URL; CI verifies all five named cases passed in JUnit. Unavailable databases
 * and missing schemas fail normally rather than silently falling back to a skipped suite.
 */
import { createHash, randomUUID } from 'node:crypto';

import { mpHash, mpOfferId } from '@phub/domain/subscription-purchase';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  monthlyQuote,
  monthlyReceipt,
} from '../../domain/src/subscription-purchase.test-fixture.js';
import { withTenantTransaction } from './connection.js';
import {
  createMonthlyPurchaseRepository,
  type MonthlyActor,
  type MonthlyScope,
} from './monthly-purchase-repository.js';

const connectionString = process.env.SUBSCRIPTION_ACTIVATION_TEST_DATABASE_URL;
if (process.env.CI_REQUIRE_QA_POSTGRES === '1' && !connectionString?.trim())
  throw new Error('REQUIRED_QA_POSTGRES_MISSING_SUBSCRIPTION_ACTIVATION_TEST_DATABASE_URL');
const describePostgres = connectionString ? describe : describe.skip;

const TENANT_KEY = 'iSkq6G';

describePostgres(
  'scenario 5: subscription activation confirmation is idempotent',
  { timeout: 30_000 },
  () => {
    const poolOptions = {
      connectionString,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
      query_timeout: 10000,
    };
    const pool = new Pool({ ...poolOptions, max: 6 });
    // Two pools: a retried provider callback lands on a different connection than the original.
    const retryPool = new Pool({ ...poolOptions, max: 2 });
    const repository = createMonthlyPurchaseRepository(pool);
    const retryRepository = createMonthlyPurchaseRepository(retryPool);
    const tenantId = randomUUID();

    beforeAll(async () => {
      await pool.query(
        "insert into identity.tenants (id, tenant_key, display_name) values ($1, $2, 'Synthetic activation')",
        [tenantId, `activation-${tenantId}`],
      );
      await withTenantTransaction(pool, tenantId, (client) =>
        client.query(
          "insert into integration.identity_provider_bindings (tenant_id, provider, provider_tenant_key) values ($1, 'VIVA', $2)",
          [tenantId, TENANT_KEY],
        ),
      );
    });

    afterAll(async () => {
      await retryPool.end();
      await pool.end();
    });

    /** Seeds an operation already dispatched to the provider, ready for a receipt. */
    async function dispatched(): Promise<{
      actor: MonthlyActor;
      scope: MonthlyScope;
      operationId: string;
      receipt: ReturnType<typeof monthlyReceipt>;
    }> {
      const userId = randomUUID();
      const sessionId = randomUUID();
      const mappingId = randomUUID();
      const key = `activation-${randomUUID()}`;
      await withTenantTransaction(pool, tenantId, async (client) => {
        await client.query(
          "insert into identity.users (tenant_id, id, status) values ($1, $2, 'ACTIVE')",
          [tenantId, userId],
        );
        await client.query(
          "insert into identity.refresh_sessions (tenant_id, id, user_id, family_id, token_hash, expires_at) values ($1, $2, $3, $4, $5, now() + interval '1 hour')",
          [
            tenantId,
            sessionId,
            userId,
            randomUUID(),
            createHash('sha256').update(randomUUID()).digest('hex'),
          ],
        );
        await client.query(
          "insert into integration.external_entity_map (id, tenant_id, external_system, entity_type, internal_id, external_id, sync_status, last_synced_at) values ($1, $2, 'VIVA', 'viva_profile', $3, $4, 'synced', now())",
          [mappingId, tenantId, userId, `fixture-client-${userId}`],
        );
      });
      const actor: MonthlyActor = {
        tenantId,
        tenantKey: TENANT_KEY,
        userId,
        sessionId,
        correlationId: `activation-${randomUUID()}`,
      };
      const scope: MonthlyScope = { tenantId, userId, keySha256: mpHash(key) };
      const initial = await repository.begin(actor, scope);
      const quote = { ...monthlyQuote(), operationId: initial.id };
      await repository.saveQuote(actor, scope, quote);
      await repository.claimDispatch(actor, scope, {
        offerId: mpOfferId,
        expectedRevision: quote.revision,
        amountMinor: quote.amountMinor,
        currency: 'RUB',
      });
      const receipt = {
        ...monthlyReceipt(),
        operationId: initial.id,
        providerTransactionId: `fixture-tx-${initial.id}`,
      };
      return { actor, scope, operationId: initial.id, receipt };
    }

    async function durableCounts(operationId: string) {
      return withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<{
          attempts: string;
          paid_audits: string;
          paid_outbox: string;
          state: string;
        }>(
          `select
           (select count(*) from commerce.monthly_purchase_attempts
             where tenant_id = $1 and id = $2)::text as attempts,
           (select count(*) from audit.audit_log
             where tenant_id = $1 and resource_id = $2 and action = 'SUBSCRIPTION_PURCHASE_STATE'
               and new_value->>'state' = 'PAID')::text as paid_audits,
           (select count(*) from audit.outbox_events
             where tenant_id = $1 and aggregate_id = $2
               and payload->>'state' = 'PAID')::text as paid_outbox,
           (select state from commerce.monthly_purchase_attempts
             where tenant_id = $1 and id = $2)::text as state`,
          [tenantId, operationId],
        );
        const row = result.rows[0];
        if (!row) throw new Error('ACTIVATION_COUNTS_MISSING');
        return {
          attempts: Number(row.attempts),
          paidAudits: Number(row.paid_audits),
          paidOutbox: Number(row.paid_outbox),
          state: row.state,
        };
      });
    }

    it('applies one PAID transition and one audit/outbox row on the first confirmation', async () => {
      const { actor, scope, operationId, receipt } = await dispatched();
      const activated = await repository.saveReceipt(actor, scope, {
        ...receipt,
        state: 'PAID' as const,
        paymentUrl: null,
        paymentExpiresAt: null,
        providerSubscriptionId: `fixture-sub-${operationId}`,
      });
      expect(activated.state).toBe('PAID');
      expect(await durableCounts(operationId)).toMatchObject({
        attempts: 1,
        paidAudits: 1,
        paidOutbox: 1,
        state: 'PAID',
      });
    });

    it('does not duplicate the transition or audit row when the confirmation is repeated', async () => {
      const { actor, scope, operationId, receipt } = await dispatched();
      const paid = {
        ...receipt,
        state: 'PAID' as const,
        paymentUrl: null,
        paymentExpiresAt: null,
        providerSubscriptionId: `fixture-sub-${operationId}`,
      };
      const first = await repository.saveReceipt(actor, scope, paid);
      const before = await durableCounts(operationId);
      const second = await repository.saveReceipt(actor, scope, paid);
      const after = await durableCounts(operationId);

      expect(second.state).toBe('PAID');
      expect(second.id).toBe(first.id);
      // Identical second confirmation changes nothing durable.
      expect(after).toEqual(before);
      expect(after.paidAudits).toBe(1);
      expect(after.paidOutbox).toBe(1);
      expect(after.attempts).toBe(1);
    });

    it('stays idempotent when the retry arrives on another connection', async () => {
      const { actor, scope, operationId, receipt } = await dispatched();
      const paid = {
        ...receipt,
        state: 'PAID' as const,
        paymentUrl: null,
        paymentExpiresAt: null,
        providerSubscriptionId: `fixture-sub-${operationId}`,
      };
      await repository.saveReceipt(actor, scope, paid);
      const retried = await retryRepository.saveReceipt(actor, scope, paid);
      expect(retried.state).toBe('PAID');
      expect(await durableCounts(operationId)).toMatchObject({
        attempts: 1,
        paidAudits: 1,
        paidOutbox: 1,
        state: 'PAID',
      });
    });

    it('records pending then paid as two distinct transitions, never three', async () => {
      const { actor, scope, operationId, receipt } = await dispatched();
      await repository.saveReceipt(actor, scope, receipt);
      expect((await durableCounts(operationId)).state).toBe('PAYMENT_PENDING');

      const paid = {
        ...receipt,
        state: 'PAID' as const,
        paymentUrl: null,
        paymentExpiresAt: null,
        providerSubscriptionId: `fixture-sub-${operationId}`,
      };
      await repository.saveReceipt(actor, scope, paid);
      await repository.saveReceipt(actor, scope, paid);

      const counts = await durableCounts(operationId);
      expect(counts.state).toBe('PAID');
      expect(counts.paidAudits).toBe(1);
      expect(counts.paidOutbox).toBe(1);
      // Measured against real PostgreSQL: the operation records its quote, its dispatch and the two
      // receipt transitions — and the repeated PAID adds nothing. Assert the exact sequence rather
      // than a bare count so a duplicated transition cannot hide behind an equal-length list.
      const auditedStates = await withTenantTransaction(pool, tenantId, async (client) => {
        const result = await client.query<{ state: string | null }>(
          `select new_value->>'state' as state from audit.audit_log
          where tenant_id = $1 and resource_id = $2 and action = 'SUBSCRIPTION_PURCHASE_STATE'
          order by occurred_at`,
          [tenantId, operationId],
        );
        return result.rows.map((row) => row.state);
      });
      expect(auditedStates).toEqual(['QUOTED', 'DISPATCH_STARTED', 'PAYMENT_PENDING', 'PAID']);
    });

    it('refuses a confirmation whose provider transaction conflicts with the stored one', async () => {
      const { actor, scope, operationId, receipt } = await dispatched();
      await repository.saveReceipt(actor, scope, {
        ...receipt,
        state: 'PAID' as const,
        paymentUrl: null,
        paymentExpiresAt: null,
        providerSubscriptionId: `fixture-sub-${operationId}`,
      });
      const before = await durableCounts(operationId);

      await expect(
        repository.saveReceipt(actor, scope, {
          ...receipt,
          state: 'PAID' as const,
          paymentUrl: null,
          paymentExpiresAt: null,
          providerTransactionId: `other-tx-${operationId}`,
          providerSubscriptionId: `fixture-sub-${operationId}`,
        }),
      ).rejects.toThrow();

      const after = await durableCounts(operationId);
      expect(after).toEqual(before);
      expect(after.state).toBe('PAID');
    });
  },
);
