import { describe, expect, it } from 'vitest';

import {
  GAME_LIFECYCLE_STATES,
  GameDomainError,
  assertGameLifecycleTransition,
  canTransitionGameLifecycle,
  type GameLifecycleState,
} from './index.js';

function expectDomainError(action: () => void, code: GameDomainError['code']): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(GameDomainError);
  expect((thrown as GameDomainError).code).toBe(code);
}

const expectedTransitions: Readonly<Record<GameLifecycleState, readonly GameLifecycleState[]>> = {
  DRAFT: ['PROVISIONING', 'CANCELLED'],
  PROVISIONING: ['SCHEDULED', 'CANCELLED'],
  SCHEDULED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['FINISHED', 'CANCELLED'],
  FINISHED: [],
  CANCELLED: [],
};

describe('game lifecycle', () => {
  it.each(
    GAME_LIFECYCLE_STATES.flatMap((from) => GAME_LIFECYCLE_STATES.map((to) => ({ from, to }))),
  )('allows only declared transition $from -> $to', ({ from, to }) => {
    const expected = expectedTransitions[from].includes(to);
    expect(canTransitionGameLifecycle(from, to)).toBe(expected);
    if (expected) {
      expect(() => assertGameLifecycleTransition(from, to)).not.toThrow();
    } else {
      expectDomainError(
        () => assertGameLifecycleTransition(from, to),
        'GAME_ILLEGAL_LIFECYCLE_TRANSITION',
      );
    }
  });

  it('keeps finished and cancelled states terminal', () => {
    for (const state of ['FINISHED', 'CANCELLED'] as const) {
      for (const target of GAME_LIFECYCLE_STATES) {
        expect(canTransitionGameLifecycle(state, target)).toBe(false);
      }
    }
  });
});
