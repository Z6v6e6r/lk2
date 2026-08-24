import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_PG_CLOCK_SQL,
  COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_PG_CONSUME_SQL,
  COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_PG_CONTROL_PLANE_VERSION,
  createCommunitiesStagingRoleSplitTrustedInventoryPgControlPlane,
  type CommunitiesStagingRoleSplitTrustedInventoryPgControlPlaneClient,
} from './communities-staging-role-split-trusted-inventory-pg-control-plane.js';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const clockSubjectSha256 = sha256('external managed PostgreSQL clock subject');
const ledgerSubjectSha256 = sha256('external managed PostgreSQL ledger subject');
const authorizationSha256 = sha256('authorization');
const requestIdSha256 = sha256('request');

const consumptionInput = {
  authorizationSha256,
  requestIdSha256,
  expiresAtUnixSeconds: '2000',
  maximumAttempts: 1 as const,
};

function clientFrom(query: ReturnType<typeof vi.fn>) {
  return { query } as unknown as CommunitiesStagingRoleSplitTrustedInventoryPgControlPlaneClient;
}

function clientsFrom(query: ReturnType<typeof vi.fn>) {
  return {
    clockClient: clientFrom(query),
    ledgerClient: clientFrom(query),
  };
}

function validClockRow() {
  return { clockSubjectSha256, unixSeconds: '1000' };
}

function validConsumptionRow() {
  return {
    authorizationSha256,
    requestIdSha256,
    ledgerSubjectSha256,
    attempt: 1,
    consumedAtUnixSeconds: '1001',
  };
}

describe('trusted inventory external PostgreSQL clock and single-use ledger adapters', () => {
  it('binds two distinct subjects to fixed statements and returns only an all-false receipt', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [validClockRow()] })
      .mockResolvedValueOnce({ rows: [validConsumptionRow()] });
    const controlPlane = createCommunitiesStagingRoleSplitTrustedInventoryPgControlPlane({
      ...clientsFrom(query),
      clockSubjectSha256,
      ledgerSubjectSha256,
    });

    expect(COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_PG_CONTROL_PLANE_VERSION).toBe(
      'communities-staging-role-split-trusted-inventory-pg-control-plane-v1',
    );
    await expect(controlPlane.clock.nowUnixSeconds()).resolves.toBe('1000');
    const receipt = await controlPlane.ledger.consumeOnce(consumptionInput);

    expect(query).toHaveBeenNthCalledWith(
      1,
      COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_PG_CLOCK_SQL,
      [clockSubjectSha256],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      COMMUNITIES_STAGING_ROLE_SPLIT_TRUSTED_INVENTORY_PG_CONSUME_SQL,
      [ledgerSubjectSha256, authorizationSha256, requestIdSha256, '2000', 1],
    );
    expect(receipt).toMatchObject({
      status: 'CONSUMED',
      authorizationSha256,
      requestIdSha256,
      ledgerSubjectSha256,
      attempt: 1,
      consumedAtUnixSeconds: '1001',
    });
    expect(Object.values(receipt.authorizes).every((value) => value === false)).toBe(true);
    expect(Object.isFrozen(controlPlane)).toBe(true);
    expect(Object.isFrozen(controlPlane.clock)).toBe(true);
    expect(Object.isFrozen(controlPlane.ledger)).toBe(true);
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it('snapshots the query method before either adapter can be dispatched', async () => {
    const original = vi.fn().mockResolvedValue({ rows: [validClockRow()] });
    const replacement = vi.fn().mockRejectedValue(new Error('substituted client'));
    const clockClient = clientFrom(original);
    const controlPlane = createCommunitiesStagingRoleSplitTrustedInventoryPgControlPlane({
      clockClient,
      ledgerClient: clientFrom(vi.fn()),
      clockSubjectSha256,
      ledgerSubjectSha256,
    });
    (clockClient as { query: unknown }).query = replacement;

    await expect(controlPlane.clock.nowUnixSeconds()).resolves.toBe('1000');
    expect(original).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid clock subject', 'x'.repeat(64), ledgerSubjectSha256],
    ['invalid ledger subject', clockSubjectSha256, 'x'.repeat(64)],
    ['aliased subjects', clockSubjectSha256, clockSubjectSha256],
  ])('rejects %s before PostgreSQL access', (_name, clockSubject, ledgerSubject) => {
    const query = vi.fn();
    expect(() =>
      createCommunitiesStagingRoleSplitTrustedInventoryPgControlPlane({
        ...clientsFrom(query),
        clockSubjectSha256: clockSubject,
        ledgerSubjectSha256: ledgerSubject,
      }),
    ).toThrow(/CONFIG_INVALID/u);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects an aliased clock and ledger client before PostgreSQL access', () => {
    const query = vi.fn();
    const client = clientFrom(query);
    expect(() =>
      createCommunitiesStagingRoleSplitTrustedInventoryPgControlPlane({
        clockClient: client,
        ledgerClient: client,
        clockSubjectSha256,
        ledgerSubjectSha256,
      }),
    ).toThrow(/CONFIG_INVALID/u);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects widened construction input before PostgreSQL access', () => {
    const query = vi.fn();
    expect(() =>
      createCommunitiesStagingRoleSplitTrustedInventoryPgControlPlane({
        ...clientsFrom(query),
        clockSubjectSha256,
        ledgerSubjectSha256,
        executable: true,
      } as never),
    ).toThrow(/CONFIG_INVALID/u);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['no row', []],
    ['more than one row', [validClockRow(), validClockRow()]],
    ['subject drift', [{ ...validClockRow(), clockSubjectSha256: sha256('other clock') }]],
    ['non-canonical time', [{ ...validClockRow(), unixSeconds: '01000' }]],
    ['widened row', [{ ...validClockRow(), extra: true }]],
  ])('rejects a %s clock response', async (_name, rows) => {
    const query = vi.fn().mockResolvedValue({ rows });
    const { clock } = createCommunitiesStagingRoleSplitTrustedInventoryPgControlPlane({
      ...clientsFrom(query),
      clockSubjectSha256,
      ledgerSubjectSha256,
    });

    await expect(clock.nowUnixSeconds()).rejects.toMatchObject({
      code: 'CLOCK_RESPONSE_INVALID',
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it('maps an unavailable or ambiguous clock call to one terminal failure', async () => {
    const query = vi.fn().mockRejectedValue(new Error('response unavailable'));
    const { clock } = createCommunitiesStagingRoleSplitTrustedInventoryPgControlPlane({
      ...clientsFrom(query),
      clockSubjectSha256,
      ledgerSubjectSha256,
    });

    await expect(clock.nowUnixSeconds()).rejects.toMatchObject({ code: 'CLOCK_UNAVAILABLE' });
    expect(query).toHaveBeenCalledOnce();
  });

  it.each([undefined, {}, { rows: null }])(
    'rejects a malformed clock query result %#',
    async (result) => {
      const query = vi.fn().mockResolvedValue(result);
      const { clock } = createCommunitiesStagingRoleSplitTrustedInventoryPgControlPlane({
        ...clientsFrom(query),
        clockSubjectSha256,
        ledgerSubjectSha256,
      });
      await expect(clock.nowUnixSeconds()).rejects.toMatchObject({
        code: 'CLOCK_RESPONSE_INVALID',
      });
    },
  );

  it('rejects malformed consumption input before PostgreSQL access', async () => {
    const query = vi.fn();
    const { ledger } = createCommunitiesStagingRoleSplitTrustedInventoryPgControlPlane({
      ...clientsFrom(query),
      clockSubjectSha256,
      ledgerSubjectSha256,
    });

    await expect(
      ledger.consumeOnce({ ...consumptionInput, authorizationSha256: '0'.repeat(63) }),
    ).rejects.toMatchObject({ code: 'LEDGER_REQUEST_INVALID' });
    await expect(
      ledger.consumeOnce({ ...consumptionInput, expiresAtUnixSeconds: '02000' }),
    ).rejects.toMatchObject({ code: 'LEDGER_REQUEST_INVALID' });
    await expect(
      ledger.consumeOnce({ ...consumptionInput, extra: true } as never),
    ).rejects.toMatchObject({ code: 'LEDGER_REQUEST_INVALID' });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['no row', []],
    ['more than one row', [validConsumptionRow(), validConsumptionRow()]],
    ['authorization drift', [{ ...validConsumptionRow(), authorizationSha256: sha256('other') }]],
    ['request drift', [{ ...validConsumptionRow(), requestIdSha256: sha256('other') }]],
    ['ledger drift', [{ ...validConsumptionRow(), ledgerSubjectSha256: sha256('other') }]],
    ['attempt drift', [{ ...validConsumptionRow(), attempt: 2 }]],
    ['time drift', [{ ...validConsumptionRow(), consumedAtUnixSeconds: '-1' }]],
    ['widened row', [{ ...validConsumptionRow(), authorizesDatabaseMutation: true }]],
  ])('rejects a %s consumption response', async (_name, rows) => {
    const query = vi.fn().mockResolvedValue({ rows });
    const { ledger } = createCommunitiesStagingRoleSplitTrustedInventoryPgControlPlane({
      ...clientsFrom(query),
      clockSubjectSha256,
      ledgerSubjectSha256,
    });

    await expect(ledger.consumeOnce(consumptionInput)).rejects.toMatchObject({
      code: 'LEDGER_RESPONSE_INVALID',
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it('never retries an ambiguous or already-consumed ledger outcome', async () => {
    const query = vi.fn().mockRejectedValue(new Error('commit response lost'));
    const { ledger } = createCommunitiesStagingRoleSplitTrustedInventoryPgControlPlane({
      ...clientsFrom(query),
      clockSubjectSha256,
      ledgerSubjectSha256,
    });

    await expect(ledger.consumeOnce(consumptionInput)).rejects.toMatchObject({
      code: 'LEDGER_UNAVAILABLE',
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it.each([undefined, {}, { rows: null }])(
    'rejects a malformed ledger query result %#',
    async (result) => {
      const query = vi.fn().mockResolvedValue(result);
      const { ledger } = createCommunitiesStagingRoleSplitTrustedInventoryPgControlPlane({
        ...clientsFrom(query),
        clockSubjectSha256,
        ledgerSubjectSha256,
      });
      await expect(ledger.consumeOnce(consumptionInput)).rejects.toMatchObject({
        code: 'LEDGER_RESPONSE_INVALID',
      });
    },
  );
});
