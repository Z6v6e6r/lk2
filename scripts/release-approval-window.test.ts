import { describe, expect, it } from 'vitest';

import { decideApprovalExtension } from './release-approval-window.js';

const sha = (char: string): string => char.repeat(64);
const at = (hoursFromBase: number): string =>
  new Date(Date.UTC(2026, 9, 25, 8, 0, 0) + hoursFromBase * 3_600_000).toISOString();

describe('release approval window', () => {
  it('extends an expired approval when the exact request inputs are unchanged', () => {
    const decision = decideApprovalExtension({
      approvedRequestSha256: sha('a'),
      currentRequestSha256: sha('a'),
      approvedAt: at(0),
      expiresAt: at(1),
      now: at(2),
    });
    expect(decision).toEqual({
      extend: true,
      expiresAt: at(6),
      reason: 'UNCHANGED_INPUTS',
    });
  });

  it('refuses an extension when the request inputs changed', () => {
    expect(
      decideApprovalExtension({
        approvedRequestSha256: sha('a'),
        currentRequestSha256: sha('b'),
        approvedAt: at(0),
        expiresAt: at(1),
        now: at(2),
      }),
    ).toEqual({ extend: false, reason: 'INPUTS_CHANGED' });
  });

  it('caps the extension by the total approval limit', () => {
    expect(
      decideApprovalExtension({
        approvedRequestSha256: sha('a'),
        currentRequestSha256: sha('a'),
        approvedAt: at(0),
        expiresAt: at(1),
        now: at(13),
      }),
    ).toEqual({ extend: false, reason: 'EXTENSION_LIMIT' });
  });

  it('does not "extend" an approval that is still valid and longer than the extension', () => {
    expect(
      decideApprovalExtension({
        approvedRequestSha256: sha('a'),
        currentRequestSha256: sha('a'),
        approvedAt: at(0),
        expiresAt: at(8),
        now: at(1),
      }),
    ).toEqual({ extend: false, reason: 'EXTENSION_NOT_NEEDED' });
  });

  it('rejects malformed hashes or timestamps', () => {
    expect(
      decideApprovalExtension({
        approvedRequestSha256: 'not-a-hash',
        currentRequestSha256: sha('a'),
        approvedAt: at(0),
        expiresAt: at(1),
        now: at(2),
      }),
    ).toEqual({ extend: false, reason: 'MALFORMED_APPROVAL' });
    expect(
      decideApprovalExtension({
        approvedRequestSha256: sha('a'),
        currentRequestSha256: sha('a'),
        approvedAt: '2026-10-25',
        expiresAt: at(1),
        now: at(2),
      }),
    ).toEqual({ extend: false, reason: 'MALFORMED_APPROVAL' });
  });
});
