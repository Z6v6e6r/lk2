import {
  assertCommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt,
  COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_CONSUMPTION_RECEIPT_VERSION,
  type CommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt,
} from '../../../packages/database/src/communities-staging-role-split-trusted-inventory-authorization.js';

import type {
  CommunitiesStagingRoleSplitTrustedInventoryClock,
  CommunitiesStagingRoleSplitTrustedInventoryConsumptionLedger,
} from './communities-staging-role-split-trusted-inventory-authorization-loader.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const UNIX_SECONDS = /^(0|[1-9][0-9]{0,15})$/u;

export const COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_PG_CONTROL_PLANE_VERSION =
  'communities-staging-role-split-trusted-inventory-pg-control-plane-v1';

export const COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_PG_CLOCK_SQL =
  'select "clockSubjectSha256", "unixSeconds" from phub_gate4_control.read_time_v1($1::text)';

export const COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_PG_CONSUME_SQL =
  'select "authorizationSha256", "requestIdSha256", "ledgerSubjectSha256", "attempt", "consumedAtUnixSeconds" from phub_gate4_control.consume_once_v1($1::text, $2::text, $3::text, $4::text, $5::smallint)';

interface QueryResult<TRow extends object> {
  readonly rows: readonly TRow[];
}

export interface CommunitiesStagingRoleSplitTrustedInventoryPgControlPlaneClient {
  query<TRow extends object>(sql: string, values: readonly unknown[]): Promise<QueryResult<TRow>>;
}

interface ClockRow {
  readonly clockSubjectSha256: string;
  readonly unixSeconds: string;
}

interface ConsumptionRow {
  readonly authorizationSha256: string;
  readonly requestIdSha256: string;
  readonly ledgerSubjectSha256: string;
  readonly attempt: number;
  readonly consumedAtUnixSeconds: string;
}

type ConsumptionInput = Parameters<
  CommunitiesStagingRoleSplitTrustedInventoryConsumptionLedger['consumeOnce']
>[0];

const CLOCK_ROW_KEYS = ['clockSubjectSha256', 'unixSeconds'] as const;
const CONSUMPTION_ROW_KEYS = [
  'authorizationSha256',
  'requestIdSha256',
  'ledgerSubjectSha256',
  'attempt',
  'consumedAtUnixSeconds',
] as const;
const CONSUMPTION_INPUT_KEYS = [
  'authorizationSha256',
  'requestIdSha256',
  'expiresAtUnixSeconds',
  'maximumAttempts',
] as const;
const CONTROL_PLANE_INPUT_KEYS = [
  'clockClient',
  'ledgerClient',
  'clockSubjectSha256',
  'ledgerSubjectSha256',
] as const;

const FALSE_AUTHORITIES = Object.freeze({
  inventoryConnection: false as const,
  inventoryRead: false as const,
  artifactWrite: false as const,
  trustedInventoryDesignation: false as const,
  roleCreation: false as const,
  roleSplit: false as const,
  aclMutation: false as const,
  sharedDatabaseMutation: false as const,
  migration: false as const,
  deploy: false as const,
  activation: false as const,
});

export class CommunitiesStagingRoleSplitTrustedInventoryPgControlPlaneError extends Error {
  constructor(
    readonly code:
      | 'CONFIG_INVALID'
      | 'CLOCK_UNAVAILABLE'
      | 'CLOCK_RESPONSE_INVALID'
      | 'LEDGER_REQUEST_INVALID'
      | 'LEDGER_UNAVAILABLE'
      | 'LEDGER_RESPONSE_INVALID',
  ) {
    super(`COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_PG_CONTROL_PLANE_${code}`);
    this.name = 'CommunitiesStagingRoleSplitTrustedInventoryPgControlPlaneError';
  }
}

function fail(code: CommunitiesStagingRoleSplitTrustedInventoryPgControlPlaneError['code']): never {
  throw new CommunitiesStagingRoleSplitTrustedInventoryPgControlPlaneError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validSubject(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

export function createCommunitiesStagingRoleSplitTrustedInventoryPgControlPlane(input: {
  readonly clockClient: CommunitiesStagingRoleSplitTrustedInventoryPgControlPlaneClient;
  readonly ledgerClient: CommunitiesStagingRoleSplitTrustedInventoryPgControlPlaneClient;
  readonly clockSubjectSha256: string;
  readonly ledgerSubjectSha256: string;
}): Readonly<{
  clock: CommunitiesStagingRoleSplitTrustedInventoryClock;
  ledger: CommunitiesStagingRoleSplitTrustedInventoryConsumptionLedger;
}> {
  if (
    !hasExactKeys(input, CONTROL_PLANE_INPUT_KEYS) ||
    !isRecord(input.clockClient) ||
    !isRecord(input.ledgerClient) ||
    typeof input.clockClient.query !== 'function' ||
    typeof input.ledgerClient.query !== 'function' ||
    input.clockClient === input.ledgerClient ||
    !validSubject(input.clockSubjectSha256) ||
    !validSubject(input.ledgerSubjectSha256) ||
    input.clockSubjectSha256 === input.ledgerSubjectSha256
  )
    fail('CONFIG_INVALID');

  const clockQuery = input.clockClient.query.bind(input.clockClient);
  const ledgerQuery = input.ledgerClient.query.bind(input.ledgerClient);
  const clockSubjectSha256 = input.clockSubjectSha256;
  const ledgerSubjectSha256 = input.ledgerSubjectSha256;

  const clock = Object.freeze({
    subjectSha256: clockSubjectSha256,
    nowUnixSeconds: async (): Promise<string> => {
      let result: QueryResult<ClockRow>;
      try {
        result = await clockQuery<ClockRow>(
          COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_PG_CLOCK_SQL,
          [clockSubjectSha256],
        );
      } catch {
        fail('CLOCK_UNAVAILABLE');
      }
      if (!isRecord(result) || !Array.isArray(result.rows)) fail('CLOCK_RESPONSE_INVALID');
      const rows = result.rows as readonly ClockRow[];
      const row = rows[0];
      if (
        rows.length !== 1 ||
        row === undefined ||
        !hasExactKeys(row, CLOCK_ROW_KEYS) ||
        row.clockSubjectSha256 !== clockSubjectSha256 ||
        !UNIX_SECONDS.test(row.unixSeconds)
      )
        fail('CLOCK_RESPONSE_INVALID');
      return row.unixSeconds;
    },
  }) satisfies CommunitiesStagingRoleSplitTrustedInventoryClock;

  const ledger = Object.freeze({
    subjectSha256: ledgerSubjectSha256,
    consumeOnce: async (
      consumptionInput: ConsumptionInput,
    ): Promise<CommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt> => {
      if (
        !hasExactKeys(consumptionInput, CONSUMPTION_INPUT_KEYS) ||
        !validSubject(consumptionInput.authorizationSha256) ||
        !validSubject(consumptionInput.requestIdSha256) ||
        !UNIX_SECONDS.test(consumptionInput.expiresAtUnixSeconds) ||
        consumptionInput.maximumAttempts !== 1
      )
        fail('LEDGER_REQUEST_INVALID');

      let result: QueryResult<ConsumptionRow>;
      try {
        result = await ledgerQuery<ConsumptionRow>(
          COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_PG_CONSUME_SQL,
          [
            ledgerSubjectSha256,
            consumptionInput.authorizationSha256,
            consumptionInput.requestIdSha256,
            consumptionInput.expiresAtUnixSeconds,
            1,
          ],
        );
      } catch {
        fail('LEDGER_UNAVAILABLE');
      }
      if (!isRecord(result) || !Array.isArray(result.rows)) fail('LEDGER_RESPONSE_INVALID');
      const rows = result.rows as readonly ConsumptionRow[];
      const row = rows[0];
      if (
        rows.length !== 1 ||
        row === undefined ||
        !hasExactKeys(row, CONSUMPTION_ROW_KEYS) ||
        row.authorizationSha256 !== consumptionInput.authorizationSha256 ||
        row.requestIdSha256 !== consumptionInput.requestIdSha256 ||
        row.ledgerSubjectSha256 !== ledgerSubjectSha256 ||
        row.attempt !== 1 ||
        !UNIX_SECONDS.test(row.consumedAtUnixSeconds)
      )
        fail('LEDGER_RESPONSE_INVALID');

      const receipt = Object.freeze({
        schemaVersion: COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_CONSUMPTION_RECEIPT_VERSION,
        status: 'CONSUMED' as const,
        authorizationSha256: row.authorizationSha256,
        requestIdSha256: row.requestIdSha256,
        ledgerSubjectSha256: row.ledgerSubjectSha256,
        attempt: 1 as const,
        consumedAtUnixSeconds: row.consumedAtUnixSeconds,
        authorizes: FALSE_AUTHORITIES,
      });
      try {
        assertCommunitiesStagingRoleSplitTrustedInventoryConsumptionReceipt(receipt);
      } catch {
        fail('LEDGER_RESPONSE_INVALID');
      }
      return receipt;
    },
  }) satisfies CommunitiesStagingRoleSplitTrustedInventoryConsumptionLedger;

  return Object.freeze({ clock, ledger });
}
