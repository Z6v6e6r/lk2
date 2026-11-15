import { describe, expect, it } from 'vitest';
import { gameResultWindowOpen, retainFinishedGame } from './index.js';

const endsAt = '2026-11-15T18:00:00+03:00';
const before = '2026-11-16T05:59:59.999+03:00';
const deadline = '2026-11-16T06:00:00+03:00';

describe('one game result deadline', () => {
  it.each(['AWAITING_SUBMISSION', 'PENDING_CONFIRMATION', 'DISPUTED'])(
    'keeps %s in My Games only before the deadline',
    (resultState) => {
      expect(
        retainFinishedGame({ lifecycleState: 'FINISHED', resultState, endsAt, now: before }),
      ).toBe(true);
      expect(
        retainFinishedGame({ lifecycleState: 'FINISHED', resultState, endsAt, now: deadline }),
      ).toBe(false);
    },
  );
  it.each(['CONFIRMED', 'VOID', 'NOT_AVAILABLE'])('never retains %s', (resultState) => {
    expect(
      retainFinishedGame({ lifecycleState: 'FINISHED', resultState, endsAt, now: before }),
    ).toBe(false);
  });
  it('does not retain a cancelled game or accept an invalid clock', () => {
    expect(
      retainFinishedGame({
        lifecycleState: 'CANCELLED',
        resultState: 'PENDING_CONFIRMATION',
        endsAt,
        now: before,
      }),
    ).toBe(false);
    expect(gameResultWindowOpen('invalid', before)).toBe(false);
    expect(gameResultWindowOpen(endsAt, deadline)).toBe(false);
  });
});
