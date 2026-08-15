import { describe, expect, it } from 'vitest';

import { CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES } from '@phub/database';

import {
  assertFoundationLedger,
  assertTenantFoundationState,
  assertTenantInventory,
} from './chat-push-foundation-verifier.js';

const checksum = 'a'.repeat(64);
const packaged = [
  { filename: '0068_existing.sql', checksum },
  ...CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES.map((filename) => ({ filename, checksum })),
];

const disabledGates = {
  web_push_enabled: false,
  booking_reminders_enabled: false,
  booking_binding_present: false,
  messaging_http_enabled: false,
  messaging_direct_enabled: false,
  messaging_realtime_enabled: false,
  messaging_contextual_enabled: false,
};

const emptyEndpoints = {
  endpoint_rows: 0,
  suspended_rows: 0,
  duplicate_live_owners: 0,
  pending_booking_lifecycle_events: 0,
};

describe('chat/push foundation verifier', () => {
  it('accepts the initial five-file state and a strict recovery prefix', () => {
    expect(
      assertFoundationLedger({
        applied: [{ filename: '0068_existing.sql', checksum }],
        packaged,
        phase: 'pre',
      }),
    ).toEqual({
      pendingFoundation: CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES,
      appliedFoundationCount: 0,
    });

    expect(
      assertFoundationLedger({
        applied: [
          { filename: '0068_existing.sql', checksum },
          ...CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES.slice(0, 2).map((filename) => ({
            filename,
            checksum,
          })),
        ],
        packaged,
        phase: 'drained',
      }),
    ).toEqual({
      pendingFoundation: CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES.slice(2),
      appliedFoundationCount: 2,
    });
  });

  it('rejects a non-prefix recovery, a sixth pending file and post-migration gaps', () => {
    expect(() =>
      assertFoundationLedger({
        applied: [
          { filename: '0068_existing.sql', checksum },
          { filename: CHAT_PUSH_FOUNDATION_MIGRATION_FILENAMES[1], checksum },
        ],
        packaged,
        phase: 'pre',
      }),
    ).toThrow('CHAT_PUSH_FOUNDATION_NON_PREFIX_LEDGER');

    expect(() =>
      assertFoundationLedger({
        applied: [],
        packaged: [{ filename: '0068_existing.sql', checksum }, ...packaged.slice(1)],
        phase: 'pre',
      }),
    ).toThrow('CHAT_PUSH_FOUNDATION_UNEXPECTED_PENDING');

    expect(() =>
      assertFoundationLedger({
        applied: [{ filename: '0068_existing.sql', checksum }],
        packaged,
        phase: 'post',
      }),
    ).toThrow('CHAT_PUSH_FOUNDATION_POST_MIGRATION_PENDING');
  });

  it('requires the approved tenant inventory to match active and inactive tenants exactly', () => {
    const tenants = [
      { tenant_id: '00000000-0000-4000-8000-000000000001', tenant_key: 'alpha-padel' },
      { tenant_id: '00000000-0000-4000-8000-000000000002', tenant_key: 'local-padel' },
    ];

    expect(
      assertTenantInventory({
        approvedTenantKeys: 'local-padel,alpha-padel',
        tenants,
      }).map((tenant) => tenant.tenant_key),
    ).toEqual(['alpha-padel', 'local-padel']);
    expect(() => assertTenantInventory({ approvedTenantKeys: 'local-padel', tenants })).toThrow(
      'CHAT_PUSH_FOUNDATION_TENANT_INVENTORY_MISMATCH',
    );
    expect(() =>
      assertTenantInventory({ approvedTenantKeys: 'local-padel,local-padel', tenants }),
    ).toThrow('CHAT_PUSH_FOUNDATION_TENANT_INVENTORY_INVALID');
  });

  it('fails closed for every enabled gate or non-empty endpoint/semantic state', () => {
    expect(() =>
      assertTenantFoundationState({ gates: disabledGates, endpoints: emptyEndpoints }),
    ).not.toThrow();

    for (const gate of Object.keys(disabledGates)) {
      expect(() =>
        assertTenantFoundationState({
          gates: { ...disabledGates, [gate]: true },
          endpoints: emptyEndpoints,
        }),
      ).toThrow('CHAT_PUSH_FOUNDATION_TENANT_GATE_ENABLED');
    }
    expect(() =>
      assertTenantFoundationState({
        gates: disabledGates,
        endpoints: { ...emptyEndpoints, endpoint_rows: 1 },
      }),
    ).toThrow('CHAT_PUSH_FOUNDATION_ENDPOINT_PRESENT');
    expect(() =>
      assertTenantFoundationState({
        gates: disabledGates,
        endpoints: { ...emptyEndpoints, pending_booking_lifecycle_events: 1 },
      }),
    ).toThrow('CHAT_PUSH_FOUNDATION_PENDING_BOOKING_EVENT_PRESENT');
    expect(() =>
      assertTenantFoundationState({
        gates: disabledGates,
        endpoints: emptyEndpoints,
        semanticRowCounts: [0, 1, 0],
      }),
    ).toThrow('CHAT_PUSH_FOUNDATION_SEMANTIC_ROW_PRESENT');
  });
});
