// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HomeRecommendationPromotionDeck } from '@phub/home-projection';
import { RecommendationAdvertisingCard } from './RecommendationAdvertisingCard.js';

const items: HomeRecommendationPromotionDeck['items'] = [1, 2].map((index) => ({
  id: `10000000-0000-4000-8000-00000000000${index}`,
  title: `Акция ${index}`,
  route: `/offers/${index}`,
  imageUrl: `/ad-${index}.webp`,
}));
const deck = { items, repeatEveryCards: 4, rotationEnabled: true, intervalSeconds: 3 };
function show(overrides: Partial<HomeRecommendationPromotionDeck> = {}) {
  return render(
    <RecommendationAdvertisingCard
      item={items[0]!}
      deck={{ ...deck, ...overrides }}
      kind="card"
      layout="compact"
      photoGrid
    />,
  );
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('recommendation advertising rotation', () => {
  it('uses the CUP timer, wraps, pauses, and lets readers choose a slide', () => {
    vi.useFakeTimers();
    show();
    expect(screen.getByRole('link', { name: 'Реклама: Акция 1' })).toHaveAttribute(
      'href',
      '/offers/1',
    );
    void act(() => vi.advanceTimersByTime(2999));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/1');
    void act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/2');
    void act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/1');
    fireEvent.click(screen.getByRole('button', { name: 'Приостановить смену рекламы' }));
    void act(() => vi.advanceTimersByTime(9000));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/1');
    fireEvent.click(screen.getByRole('button', { name: 'Слайд 2: Акция 2' }));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/2');
    expect(screen.getByRole('button', { name: 'Слайд 2: Акция 2' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Продолжить смену рекламы' }));
    void act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/1');
  });
  it('stays still while focused or when autoplay is disabled', () => {
    vi.useFakeTimers();
    const { rerender } = show();
    fireEvent.focus(screen.getByRole('link'));
    void act(() => vi.advanceTimersByTime(6000));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/1');
    fireEvent.blur(screen.getByRole('link'));
    void act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/2');
    rerender(
      <RecommendationAdvertisingCard
        item={items[0]!}
        deck={{ ...deck, rotationEnabled: false }}
        kind="card"
        layout="compact"
      />,
    );
    void act(() => vi.advanceTimersByTime(6000));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/2');
    expect(screen.queryByRole('button', { name: /смену рекламы/ })).not.toBeInTheDocument();
  });
  it('honors reduced motion and does not add controls for a single creative', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const { unmount } = show();
    void act(() => vi.advanceTimersByTime(6000));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/1');
    expect(screen.queryByRole('button', { name: /смену рекламы/ })).not.toBeInTheDocument();
    unmount();
    show({ items: [items[0]!] });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('counts each visible exposure and reports clicks on the active slide', () => {
    vi.useFakeTimers();
    const engagement = vi.fn();
    render(
      <RecommendationAdvertisingCard
        item={items[0]!}
        deck={deck}
        kind="strip"
        layout="compact"
        photoGrid
        onEngagement={engagement}
      />,
    );
    void act(() => vi.advanceTimersByTime(3000));
    fireEvent.click(screen.getByRole('link'));
    expect(engagement).toHaveBeenCalledWith(items[1]!.id, 'CLICK');
    void act(() => vi.advanceTimersByTime(3000));
    expect(engagement.mock.calls.filter((call) => call[1] === 'IMPRESSION')).toHaveLength(3);
  });
  it('does not rotate offscreen or in a hidden document', () => {
    vi.useFakeTimers();
    let report: IntersectionObserverCallback | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          report = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    show();
    void act(() => vi.advanceTimersByTime(6000));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/1');
    void act(() =>
      report?.(
        [{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    void act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/2');
    void act(() => vi.advanceTimersByTime(2900));
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    void act(() => vi.advanceTimersByTime(6000));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/2');
    hidden.mockRestore();
    fireEvent(document, new Event('visibilitychange'));
    void act(() => vi.advanceTimersByTime(2999));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/2');
    void act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/1');
    void act(() => vi.advanceTimersByTime(2900));
    void act(() =>
      report?.(
        [{ isIntersecting: false, intersectionRatio: 0 } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    void act(() => vi.advanceTimersByTime(3000));
    void act(() =>
      report?.(
        [{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    void act(() => vi.advanceTimersByTime(2999));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/1');
    void act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/2');
  });
  it('falls back to a current creative when the selected one is removed', () => {
    const { rerender } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Слайд 2: Акция 2' }));
    rerender(
      <RecommendationAdvertisingCard
        item={items[0]!}
        deck={{ ...deck, items: [items[0]!] }}
        kind="card"
        layout="compact"
      />,
    );
    expect(screen.getByRole('link')).toHaveAttribute('href', '/offers/1');
  });
});
