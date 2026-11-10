import { describe, expect, it } from 'vitest';

import { autoConfirmRequestHash, isAutoConfirmDue } from '@phub/database';

const SUBMISSION = '86185005-7855-4b0f-a10e-ea97f7dce4b1';

describe('autoConfirmRequestHash', () => {
  it('produces the lowercase hex digest the command ledger accepts', () => {
    const hash = autoConfirmRequestHash({
      submissionId: SUBMISSION,
      revision: 1,
      confirmationWindowHours: 12,
    });

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with the submission revision, so a replay is not mistaken for a new command', () => {
    const first = autoConfirmRequestHash({
      submissionId: SUBMISSION,
      revision: 1,
      confirmationWindowHours: 12,
    });
    const second = autoConfirmRequestHash({
      submissionId: SUBMISSION,
      revision: 2,
      confirmationWindowHours: 12,
    });

    expect(second).not.toBe(first);
  });

  it('is stable for the same submission and window', () => {
    const input = { submissionId: SUBMISSION, revision: 1, confirmationWindowHours: 12 };

    expect(autoConfirmRequestHash(input)).toBe(autoConfirmRequestHash(input));
  });
});

describe('isAutoConfirmDue', () => {
  it('rejects an in-window pending submission and accepts an elapsed one', () => {
    const submittedAt = '2026-11-09T08:19:42.638Z';

    expect(
      isAutoConfirmDue({
        state: 'PENDING_CONFIRMATION',
        submittedAt,
        now: '2026-11-09T20:19:42.000Z',
        confirmationWindowHours: 12,
      }),
    ).toBe(false);
    expect(
      isAutoConfirmDue({
        state: 'PENDING_CONFIRMATION',
        submittedAt,
        now: '2026-11-09T20:20:00.000Z',
        confirmationWindowHours: 12,
      }),
    ).toBe(true);
  });
});
