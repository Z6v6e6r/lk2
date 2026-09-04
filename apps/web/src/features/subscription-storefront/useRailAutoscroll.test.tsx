// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useRailAutoscroll, initialRailFocusIndex } from './useRailAutoscroll.js';

function Harness(): React.JSX.Element {
  return <div className="subscription-plan-rail" />;
}

function mountWithHook(): void {
  function Probe(): null {
    const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
    useRailAutoscroll(ref);
    return null;
  }
  render(<Probe />);
}

describe('initialRailFocusIndex', () => {
  it('picks the center card for an odd count and card n/2 for an even count', () => {
    expect(initialRailFocusIndex(1)).toBe(0);
    expect(initialRailFocusIndex(2)).toBe(0); // 1-based n/2 = 1
    expect(initialRailFocusIndex(3)).toBe(1); // center
    expect(initialRailFocusIndex(4)).toBe(1); // 1-based n/2 = 2
    expect(initialRailFocusIndex(5)).toBe(2); // center
    expect(initialRailFocusIndex(6)).toBe(2); // 1-based n/2 = 3
  });
});

describe('useRailAutoscroll', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not schedule autoplay when the rail has no overflow', () => {
    const setInterval = vi.spyOn(window, 'setInterval');
    render(<Harness />);
    mountWithHook();
    expect(setInterval).not.toHaveBeenCalled();
  });

  it('does not schedule autoplay under prefers-reduced-motion', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });
    const setInterval = vi.spyOn(window, 'setInterval');
    mountWithHook();
    expect(setInterval).not.toHaveBeenCalled();
  });
});
