import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createCommunitiesStagingRoleSplitTrustedInventoryPgControlPlane,
  type CommunitiesStagingRoleSplitTrustedInventoryPgControlPlaneClient,
} from './communities-staging-role-split-trusted-inventory-pg-control-plane.js';

const ADMIN_DATABASE = 'phub_gate4_control_verify';
const CLOCK_ROLE = 'phub_gate4_clock_verify';
const CONSUMER_ROLE = 'phub_gate4_consumer_verify';
const AUDITOR_ROLE = 'phub_gate4_auditor_verify';
const clockSubjectSha256 = createHash('sha256').update('gate4 clock subject').digest('hex');
const ledgerSubjectSha256 = createHash('sha256').update('gate4 ledger subject').digest('hex');
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function parseDisposableUrl(value: string | undefined): URL {
  if (value === undefined) throw new Error('GATE4_PG16_VERIFY_URL_MISSING');
  const parsed = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
    decodeURIComponent(parsed.pathname.slice(1)) !== ADMIN_DATABASE ||
    parsed.username !== 'postgres' ||
    !/^[a-f0-9]{64}$/u.test(parsed.password) ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw new Error('GATE4_PG16_VERIFY_URL_INVALID');
  return parsed;
}

function parseDisposableContainerId(value: string | undefined): string {
  if (value === undefined || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error('GATE4_PG16_VERIFY_CONTAINER_ID_INVALID');
  return value;
}

function parseDisposableContainerName(value: string | undefined): string {
  if (value === undefined || !/^phub-gate4-control-pg16-verify-[1-9][0-9]*$/u.test(value))
    throw new Error('GATE4_PG16_VERIFY_CONTAINER_NAME_INVALID');
  return value;
}

function roleUrl(base: URL, role: string): string {
  const result = new URL(base);
  result.username = role;
  return result.toString();
}

function adapterClient(
  client: Client,
): CommunitiesStagingRoleSplitTrustedInventoryPgControlPlaneClient {
  return {
    query: async <TRow extends object>(sql: string, values: readonly unknown[]) => {
      const result = await client.query(sql, [...values]);
      return { rows: result.rows as readonly TRow[] };
    },
  };
}

function controlPlane(clockClient: Client, ledgerClient: Client) {
  return createCommunitiesStagingRoleSplitTrustedInventoryPgControlPlane({
    clockClient: adapterClient(clockClient),
    ledgerClient: adapterClient(ledgerClient),
    clockSubjectSha256,
    ledgerSubjectSha256,
  });
}

async function futureExpiry(clockClient: Client, ledgerClient: Client): Promise<string> {
  const now = await controlPlane(clockClient, ledgerClient).clock.nowUnixSeconds();
  return (BigInt(now) + 120n).toString();
}

const configuredUrl = process.env.PHUB_GATE4_CONTROL_PG16_VERIFY_URL;
const baseUrl = configuredUrl === undefined ? null : parseDisposableUrl(configuredUrl);
const configuredContainerId =
  configuredUrl === undefined
    ? null
    : parseDisposableContainerId(process.env.PHUB_GATE4_CONTROL_PG16_VERIFY_CONTAINER_ID);
const configuredContainerName =
  configuredUrl === undefined
    ? null
    : parseDisposableContainerName(process.env.PHUB_GATE4_CONTROL_PG16_VERIFY_CONTAINER_NAME);

describe('Gate 4 PostgreSQL control-plane integration guard', () => {
  it('accepts only the exact loopback disposable admin database', () => {
    expect(() =>
      parseDisposableUrl(
        `postgresql://postgres:${'a'.repeat(64)}@127.0.0.1:55443/${ADMIN_DATABASE}`,
      ),
    ).not.toThrow();
    expect(() =>
      parseDisposableUrl(
        `postgresql://postgres:${'a'.repeat(64)}@database.example:55443/${ADMIN_DATABASE}`,
      ),
    ).toThrow('GATE4_PG16_VERIFY_URL_INVALID');
    expect(() =>
      parseDisposableUrl(`postgresql://postgres:${'a'.repeat(64)}@127.0.0.1:55443/postgres`),
    ).toThrow('GATE4_PG16_VERIFY_URL_INVALID');
  });

  it('accepts only the dedicated disposable container identity', () => {
    expect(parseDisposableContainerId('a'.repeat(64))).toBe('a'.repeat(64));
    expect(() => parseDisposableContainerId('a'.repeat(63))).toThrow(
      'GATE4_PG16_VERIFY_CONTAINER_ID_INVALID',
    );
    expect(parseDisposableContainerName('phub-gate4-control-pg16-verify-123')).toBe(
      'phub-gate4-control-pg16-verify-123',
    );
    expect(() => parseDisposableContainerName('postgres')).toThrow(
      'GATE4_PG16_VERIFY_CONTAINER_NAME_INVALID',
    );
  });
});

describe
  .skipIf(baseUrl === null)
  .sequential('Gate 4 external PostgreSQL control plane on disposable PostgreSQL 16', () => {
    let admin: Client;
    let clockClient: Client;
    let consumerA: Client;
    let consumerB: Client;
    let auditor: Client;

    beforeAll(async () => {
      if (baseUrl === null || configuredContainerId === null || configuredContainerName === null)
        throw new Error('GATE4_PG16_VERIFY_BINDING_MISSING');
      admin = new Client({ connectionString: baseUrl.toString() });
      clockClient = new Client({ connectionString: roleUrl(baseUrl, CLOCK_ROLE) });
      consumerA = new Client({ connectionString: roleUrl(baseUrl, CONSUMER_ROLE) });
      consumerB = new Client({ connectionString: roleUrl(baseUrl, CONSUMER_ROLE) });
      auditor = new Client({ connectionString: roleUrl(baseUrl, AUDITOR_ROLE) });
      const schemaPath = resolve(
        'deploy/postgresql/communities-role-split-gate4-control-plane-v1.sql',
      );
      const schema = await readFile(schemaPath, 'utf8');
      await admin.connect();
      await admin.query(schema);

      const password = baseUrl.password;
      await admin.query(`CREATE ROLE ${CLOCK_ROLE} LOGIN PASSWORD '${password}'`);
      await admin.query(`CREATE ROLE ${CONSUMER_ROLE} LOGIN PASSWORD '${password}'`);
      await admin.query(`CREATE ROLE ${AUDITOR_ROLE} LOGIN PASSWORD '${password}'`);
      await admin.query(`GRANT USAGE ON SCHEMA phub_gate4_control TO ${CLOCK_ROLE}`);
      await admin.query(`GRANT USAGE ON SCHEMA phub_gate4_control TO ${CONSUMER_ROLE}`);
      await admin.query(`GRANT USAGE ON SCHEMA phub_gate4_control TO ${AUDITOR_ROLE}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION phub_gate4_control.read_time_v1(text) TO ${CLOCK_ROLE}`,
      );
      await admin.query(
        `GRANT EXECUTE ON FUNCTION phub_gate4_control.consume_once_v1(text, text, text, text, smallint) TO ${CONSUMER_ROLE}`,
      );
      await admin.query(
        `GRANT SELECT ON phub_gate4_control.consumption_receipt_audit_v1 TO ${AUDITOR_ROLE}`,
      );

      await Promise.all([
        clockClient.connect(),
        consumerA.connect(),
        consumerB.connect(),
        auditor.connect(),
      ]);
    });

    afterAll(async () => {
      await Promise.allSettled([
        clockClient.end(),
        consumerA.end(),
        consumerB.end(),
        auditor.end(),
        admin.end(),
      ]);
    });

    it('fails closed until the independently provisioned subject binding exists', async () => {
      const clock = controlPlane(clockClient, consumerA).clock;
      await expect(clock.nowUnixSeconds()).rejects.toThrow(
        'COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_PG_CONTROL_PLANE_CLOCK_UNAVAILABLE',
      );

      await admin.query(
        `INSERT INTO phub_gate4_control.control_binding_v1
       (clock_subject_sha256, ledger_subject_sha256)
     VALUES ($1, $2)`,
        [clockSubjectSha256, ledgerSubjectSha256],
      );
    });

    it('returns externally bound monotonic server time without table access', async () => {
      const clock = controlPlane(clockClient, consumerA).clock;
      const before = await clock.nowUnixSeconds();
      const after = await clock.nowUnixSeconds();

      expect(BigInt(after)).toBeGreaterThanOrEqual(BigInt(before));
      await expect(
        clockClient.query('SELECT * FROM phub_gate4_control.control_binding_v1'),
      ).rejects.toThrow();
      await expect(
        clockClient.query('SELECT * FROM phub_gate4_control.consumption_receipt_v1'),
      ).rejects.toThrow();
    });

    it('atomically allows exactly one of two concurrent consumes', async () => {
      const expiresAtUnixSeconds = await futureExpiry(clockClient, consumerA);
      const input = {
        authorizationSha256: sha256('concurrent authorization'),
        requestIdSha256: sha256('concurrent request'),
        expiresAtUnixSeconds,
        maximumAttempts: 1 as const,
      };

      const outcomes = await Promise.allSettled([
        controlPlane(clockClient, consumerA).ledger.consumeOnce(input),
        controlPlane(clockClient, consumerB).ledger.consumeOnce(input),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
      const fulfilled = outcomes.find((outcome) => outcome.status === 'fulfilled');
      expect(fulfilled?.status === 'fulfilled' ? fulfilled.value.authorizes : undefined).toEqual({
        inventoryConnection: false,
        inventoryRead: false,
        artifactWrite: false,
        trustedInventoryDesignation: false,
        roleCreation: false,
        roleSplit: false,
        aclMutation: false,
        sharedDatabaseMutation: false,
        migration: false,
        deploy: false,
        activation: false,
      });

      const count = await auditor.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM phub_gate4_control.consumption_receipt_audit_v1
        WHERE authorization_sha256 = $1`,
        [input.authorizationSha256],
      );
      expect(count.rows).toEqual([{ count: '1' }]);
    });

    it('rejects replay by either authorization or request identity and rejects expiry', async () => {
      const expiresAtUnixSeconds = await futureExpiry(clockClient, consumerA);
      const authorizationSha256 = sha256('replay authorization');
      const requestIdSha256 = sha256('replay request');
      const ledger = controlPlane(clockClient, consumerA).ledger;
      await expect(
        ledger.consumeOnce({
          authorizationSha256,
          requestIdSha256,
          expiresAtUnixSeconds,
          maximumAttempts: 1,
        }),
      ).resolves.toMatchObject({ attempt: 1 });
      await expect(
        ledger.consumeOnce({
          authorizationSha256,
          requestIdSha256: sha256('different request'),
          expiresAtUnixSeconds,
          maximumAttempts: 1,
        }),
      ).rejects.toThrow(/LEDGER_UNAVAILABLE/u);
      await expect(
        ledger.consumeOnce({
          authorizationSha256: sha256('different authorization'),
          requestIdSha256,
          expiresAtUnixSeconds,
          maximumAttempts: 1,
        }),
      ).rejects.toThrow(/LEDGER_UNAVAILABLE/u);
      await expect(
        ledger.consumeOnce({
          authorizationSha256: sha256('expired authorization'),
          requestIdSha256: sha256('expired request'),
          expiresAtUnixSeconds: '1',
          maximumAttempts: 1,
        }),
      ).rejects.toThrow(/LEDGER_UNAVAILABLE/u);
    });

    it('burns an ambiguous committed attempt and never retries it inside the adapter', async () => {
      const expiresAtUnixSeconds = await futureExpiry(clockClient, consumerA);
      const authorizationSha256 = sha256('lost response authorization');
      const requestIdSha256 = sha256('lost response request');
      let calls = 0;
      const responseLossClient: CommunitiesStagingRoleSplitTrustedInventoryPgControlPlaneClient = {
        query: async (sql: string, values: readonly unknown[]) => {
          calls += 1;
          await consumerA.query(sql, [...values]);
          throw new Error('response lost after commit');
        },
      };
      const responseLossLedger = createCommunitiesStagingRoleSplitTrustedInventoryPgControlPlane({
        clockClient: adapterClient(clockClient),
        ledgerClient: responseLossClient,
        clockSubjectSha256,
        ledgerSubjectSha256,
      }).ledger;
      const input = {
        authorizationSha256,
        requestIdSha256,
        expiresAtUnixSeconds,
        maximumAttempts: 1 as const,
      };

      await expect(responseLossLedger.consumeOnce(input)).rejects.toThrow(/LEDGER_UNAVAILABLE/u);
      expect(calls).toBe(1);
      await expect(controlPlane(clockClient, consumerB).ledger.consumeOnce(input)).rejects.toThrow(
        /LEDGER_UNAVAILABLE/u,
      );

      const retained = await auditor.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM phub_gate4_control.consumption_receipt_audit_v1
        WHERE authorization_sha256 = $1 AND request_id_sha256 = $2`,
        [authorizationSha256, requestIdSha256],
      );
      expect(retained.rows).toEqual([{ count: '1' }]);
    });

    it('keeps consumer and auditor roles outside direct receipt mutation', async () => {
      await expect(
        consumerA.query(
          `INSERT INTO phub_gate4_control.consumption_receipt_v1
           (authorization_sha256, request_id_sha256, ledger_subject_sha256, attempt,
            consumed_at_unix_seconds, expires_at_unix_seconds)
         VALUES ($1, $2, $3, 1, 1, 2)`,
          [sha256('forbidden auth'), sha256('forbidden request'), ledgerSubjectSha256],
        ),
      ).rejects.toThrow();
      await expect(
        consumerA.query('TRUNCATE phub_gate4_control.consumption_receipt_v1'),
      ).rejects.toThrow();
      await expect(
        auditor.query('SELECT * FROM phub_gate4_control.consumption_receipt_v1'),
      ).rejects.toThrow();
      await expect(
        admin.query(
          'UPDATE phub_gate4_control.consumption_receipt_v1 SET attempt = attempt WHERE false',
        ),
      ).rejects.toThrow(/PHUB_GATE4_CONTROL_RECEIPT_MUTATION_FORBIDDEN/u);
    });

    it('fails closed when the external server clock regresses behind its durable fence', async () => {
      const future = (
        BigInt(await controlPlane(clockClient, consumerA).clock.nowUnixSeconds()) + 3600n
      ).toString();
      await admin.query(
        'UPDATE phub_gate4_control.control_binding_v1 SET last_seen_unix_seconds = $1',
        [future],
      );
      try {
        await expect(controlPlane(clockClient, consumerA).clock.nowUnixSeconds()).rejects.toThrow(
          /CLOCK_UNAVAILABLE/u,
        );
        await expect(
          controlPlane(clockClient, consumerA).ledger.consumeOnce({
            authorizationSha256: sha256('clock regression authorization'),
            requestIdSha256: sha256('clock regression request'),
            expiresAtUnixSeconds: (BigInt(future) + 3600n).toString(),
            maximumAttempts: 1,
          }),
        ).rejects.toThrow(/LEDGER_UNAVAILABLE/u);
      } finally {
        await admin.query(
          `UPDATE phub_gate4_control.control_binding_v1
            SET last_seen_unix_seconds =
              pg_catalog.floor(EXTRACT(EPOCH FROM pg_catalog.clock_timestamp()))::bigint`,
        );
      }
    });
  });
