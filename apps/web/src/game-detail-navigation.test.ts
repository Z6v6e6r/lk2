// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MouseEvent } from 'react';
import { handleGameDetailBack } from './game-detail-navigation.js';

function click(overrides: Partial<MouseEvent<HTMLAnchorElement>> = {}) {
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as MouseEvent<HTMLAnchorElement>;
}

afterEach(() => vi.restoreAllMocks());

describe('shared Web and Android detail back navigation', () => {
  it('traverses existing history instead of replacing the source with a fixed game list', () => {
    vi.spyOn(window.history, 'length', 'get').mockReturnValue(2);
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    const event = click();
    handleGameDetailBack(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(back).toHaveBeenCalledOnce();
  });

  it('keeps the home-link fallback for a direct entry without previous history', () => {
    vi.spyOn(window.history, 'length', 'get').mockReturnValue(1);
    const back = vi.spyOn(window.history, 'back');
    const event = click();
    handleGameDetailBack(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });

  it.each([
    { defaultPrevented: true },
    { button: 1 },
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
  ])('does not intercept native or already handled link activation: %j', (overrides) => {
    vi.spyOn(window.history, 'length', 'get').mockReturnValue(2);
    const back = vi.spyOn(window.history, 'back');
    const event = click(overrides);
    handleGameDetailBack(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });
});
