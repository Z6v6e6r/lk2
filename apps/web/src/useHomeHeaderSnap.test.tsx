// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHomeHeaderSnap } from './useHomeHeaderSnap.js';

function Home({ enabled = true }: { enabled?: boolean }) {
  const { homeRef, recommendationsRef } = useHomeHeaderSnap(enabled);
  return (
    <main ref={homeRef}>
      <button>Header link</button>
      <div ref={recommendationsRef}>Recommendations</div>
    </main>
  );
}

let scrollY = 0;
let reducedMotion = false;
let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  scrollY = 0;
  reducedMotion = false;
  vi.spyOn(window, 'scrollY', 'get').mockImplementation(() => scrollY);
  vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(3000);
  scrollTo = vi.fn((options: ScrollToOptions) => {
    scrollY = options.top ?? scrollY;
  });
  vi.stubGlobal('scrollTo', scrollTo);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: reducedMotion })),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup(enabled = true) {
  const view = render(<Home enabled={enabled} />);
  const home = view.container.querySelector('main')!;
  const recommendations = home.querySelector('div')!;
  vi.spyOn(home, 'getBoundingClientRect').mockImplementation(() => ({ top: -scrollY }) as DOMRect);
  vi.spyOn(recommendations, 'getBoundingClientRect').mockImplementation(
    () => ({ top: 400 - scrollY }) as DOMRect,
  );
  return { ...view, home, recommendations };
}
const finish = () =>
  act(() => {
    vi.advanceTimersByTime(300);
  });
const point = (x: number, y: number) => ({ clientX: x, clientY: y });

describe('Home header boundary snapping', () => {
  it('completes a touch scroll that the browser has already made non-cancelable', () => {
    const { home } = setup();
    fireEvent.touchStart(home, { touches: [point(100, 200)] });
    fireEvent.touchMove(home, { touches: [point(100, 180)], cancelable: false });
    scrollY = 20;
    fireEvent.scroll(window);
    finish();
    expect(scrollY).toBe(400);
  });

  it('does not retain touch direction after the gesture and inertia finish', () => {
    const { home } = setup();
    scrollY = 700;
    fireEvent.touchStart(home, { touches: [point(100, 200)] });
    fireEvent.touchMove(home, { touches: [point(100, 220)] });
    fireEvent.touchEnd(home, { touches: [] });
    finish();
    scrollY = 390;
    fireEvent.scroll(window);
    finish();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('snaps on the first downward wheel input and scrolls the feed normally on the next gesture', () => {
    const { home } = setup();
    expect(fireEvent.wheel(home, { deltaY: 2 })).toBe(false);
    finish();
    expect(scrollY).toBe(400);
    scrollTo.mockClear();
    expect(fireEvent.wheel(home, { deltaY: 50 })).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('returns fully to the header when scrolling up from the recommendation boundary', () => {
    const { home } = setup();
    scrollY = 400;
    expect(fireEvent.wheel(home, { deltaY: -2 })).toBe(false);
    finish();
    expect(scrollY).toBe(0);
  });

  it('does not jump to the header while still inside the feed, but completes the return on reaching it', () => {
    const { recommendations } = setup();
    scrollY = 700;
    expect(fireEvent.wheel(recommendations, { deltaY: -50 })).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();
    scrollY = 395;
    fireEvent.scroll(window);
    finish();
    expect(scrollY).toBe(0);
  });

  it('consumes the rest of a swipe so it cannot overshoot or reverse the snap', () => {
    const { home } = setup();
    fireEvent.touchStart(home, { touches: [point(100, 200)] });
    expect(fireEvent.touchMove(home, { touches: [point(100, 188)] })).toBe(false);
    finish();
    expect(scrollY).toBe(400);
    expect(fireEvent.touchMove(home, { touches: [point(100, 210)] })).toBe(false);
    fireEvent.scroll(window);
    finish();
    expect(scrollY).toBe(400);
    fireEvent.touchEnd(home, { touches: [] });
    fireEvent.touchStart(home, { touches: [point(100, 200)] });
    fireEvent.touchMove(home, { touches: [point(100, 212)] });
    finish();
    expect(scrollY).toBe(0);
  });

  it('preserves horizontal carousels, pinch zoom, taps and keyboard focus', () => {
    const { home } = setup();
    expect(fireEvent.wheel(home, { deltaX: 80, deltaY: 2 })).toBe(true);
    expect(fireEvent.wheel(home, { deltaY: 30, ctrlKey: true })).toBe(true);
    fireEvent.touchStart(home, { touches: [point(100, 200)] });
    expect(fireEvent.touchMove(home, { touches: [point(50, 195)] })).toBe(true);
    expect(fireEvent.touchMove(home, { touches: [point(50, 100)] })).toBe(true);
    fireEvent.touchEnd(home, { touches: [] });
    fireEvent.touchStart(home, { touches: [point(100, 200), point(120, 200)] });
    expect(fireEvent.touchMove(home, { touches: [point(100, 180), point(120, 220)] })).toBe(true);
    const button = home.querySelector('button')!;
    button.focus();
    expect(fireEvent.keyDown(button, { key: 'Tab' })).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('does not intercept dialogs or nested vertical scrolling', () => {
    const { home } = setup();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    home.append(dialog);
    expect(fireEvent.wheel(dialog, { deltaY: 30 })).toBe(true);
    const nested = document.createElement('div');
    nested.style.overflowY = 'auto';
    Object.defineProperty(nested, 'scrollHeight', { value: 500 });
    home.append(nested);
    expect(fireEvent.wheel(nested, { deltaY: 30 })).toBe(true);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('honors reduced motion and clamps the target for a short/empty feed', () => {
    const { home } = setup();
    reducedMotion = true;
    vi.spyOn(document.documentElement, 'scrollHeight', 'get').mockReturnValue(
      window.innerHeight + 200,
    );
    fireEvent.wheel(home, { deltaY: 10 });
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 200, behavior: 'instant' });
  });

  it('is disabled on other layouts/tabs and cancels animation on leaving recommendations', () => {
    const { home, rerender } = setup(false);
    expect(fireEvent.wheel(home, { deltaY: 20 })).toBe(true);
    rerender(<Home />);
    fireEvent.wheel(home, { deltaY: 20 });
    rerender(<Home enabled={false} />);
    finish();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(fireEvent.wheel(home, { deltaY: 20 })).toBe(true);
  });

  it('holds wheel momentum at the boundary until that gesture ends', () => {
    const { home } = setup();
    fireEvent.wheel(home, { deltaY: 10 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.wheel(home, { deltaY: 40 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.wheel(home, { deltaY: 20 });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(scrollY).toBe(400);
    expect(fireEvent.wheel(home, { deltaY: 5 })).toBe(false);
    finish();
    expect(fireEvent.wheel(home, { deltaY: 5 })).toBe(true);
  });
});
