import { describe, expect, it } from 'vitest';

import { assertMigrationLedgerCompatible } from './migration-ledger-policy.js';

const shifted = {
  filename: '0054_community_membership_pin_commands.sql',
  checksum: 'e4fdedbccd25d4ffc656029dbe7220ad465b577ff2aa4ec4ee4a369cf533150e',
};
const profileVisibility = {
  filename: '0053_profile_visibility_sections.sql',
  checksum: 'b6c7603110b6c208b11b274f5b7f9ff0eb3bf0ebacdb986201b3e9c944286266',
};

describe('migration ledger policy', () => {
  it('accepts a fresh ledger and the exact shifted Communities history', () => {
    expect(() =>
      assertMigrationLedgerCompatible({ applied: [], packaged: [shifted] }),
    ).not.toThrow();
    expect(() =>
      assertMigrationLedgerCompatible({
        applied: [profileVisibility, shifted],
        packaged: [profileVisibility, shifted],
      }),
    ).not.toThrow();
  });

  it('rejects the superseded canonical Communities history before migration execution', () => {
    expect(() =>
      assertMigrationLedgerCompatible({
        applied: [
          shifted,
          {
            filename: '0060_community_membership_pin_commands.sql',
            checksum: 'a'.repeat(64),
          },
        ],
        packaged: [shifted],
      }),
    ).toThrow('COMMUNITIES_CANONICAL_HISTORY_REJECTED:0060_community_membership_pin_commands.sql');
  });

  it('rejects a checksum mismatch anywhere in the packaged ledger before applying missing files', () => {
    expect(() =>
      assertMigrationLedgerCompatible({
        applied: [{ ...shifted, checksum: 'b'.repeat(64) }],
        packaged: [shifted],
      }),
    ).toThrow('MIGRATION_CHECKSUM_MISMATCH:0054_community_membership_pin_commands.sql');
  });

  it('rejects mixed shifted and superseded canonical histories', () => {
    expect(() =>
      assertMigrationLedgerCompatible({
        applied: [
          shifted,
          { filename: '0075_community_media_operational_recovery.sql', checksum: 'c'.repeat(64) },
        ],
        packaged: [shifted],
      }),
    ).toThrow(
      'COMMUNITIES_CANONICAL_HISTORY_REJECTED:0075_community_media_operational_recovery.sql',
    );
  });

  it('accepts only the reviewed exact-checksum legacy messaging migrations', () => {
    expect(() =>
      assertMigrationLedgerCompatible({
        applied: [
          {
            filename: '0043_messaging_runtime.sql',
            checksum: '32512565880a9062a432eb68ec192b0640570f1636d2f2a946ab4ebc5bf96465',
          },
        ],
        packaged: [shifted],
      }),
    ).not.toThrow();
    expect(() =>
      assertMigrationLedgerCompatible({
        applied: [
          {
            filename: '0044_contextual_messaging_projection.sql',
            checksum: '103976b96034ac3996c47c9adc536d22c06c5bc0ad12352af1413241b9c50832',
          },
        ],
        packaged: [shifted],
      }),
    ).not.toThrow();
    expect(() =>
      assertMigrationLedgerCompatible({
        applied: [
          {
            filename: '0043_messaging_runtime.sql',
            checksum: '32512565880a9062a432eb68ec192b0640570f1636d2f2a946ab4ebc5bf96465',
          },
          {
            filename: '0044_contextual_messaging_projection.sql',
            checksum: '103976b96034ac3996c47c9adc536d22c06c5bc0ad12352af1413241b9c50832',
          },
        ],
        packaged: [shifted],
      }),
    ).not.toThrow();

    expect(() =>
      assertMigrationLedgerCompatible({
        applied: [{ filename: '0043_messaging_runtime.sql', checksum: 'd'.repeat(64) }],
        packaged: [shifted],
      }),
    ).toThrow('MIGRATION_CHECKSUM_MISMATCH:0043_messaging_runtime.sql');
    expect(() =>
      assertMigrationLedgerCompatible({
        applied: [
          {
            filename: '0044_contextual_messaging_projection.sql',
            checksum: 'e'.repeat(64),
          },
        ],
        packaged: [shifted],
      }),
    ).toThrow('MIGRATION_CHECKSUM_MISMATCH:0044_contextual_messaging_projection.sql');
  });

  it('rejects every unreviewed ledger row while accepting the restored exact 0053 bytes', () => {
    expect(() =>
      assertMigrationLedgerCompatible({
        applied: [profileVisibility],
        packaged: [profileVisibility, shifted],
      }),
    ).not.toThrow();
    expect(() =>
      assertMigrationLedgerCompatible({
        applied: [
          {
            filename: '0053_unreviewed_branch_hotfix.sql',
            checksum: 'b6c7603110b6c208b11b274f5b7f9ff0eb3bf0ebacdb986201b3e9c944286266',
          },
        ],
        packaged: [profileVisibility, shifted],
      }),
    ).toThrow('MIGRATION_LEDGER_UNKNOWN:0053_unreviewed_branch_hotfix.sql');
  });
});
