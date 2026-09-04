import { useEffect, type RefObject } from 'react';

const EDGE_EPSILON = 8;

function railGap(rail: HTMLElement): number {
  const style = window.getComputedStyle(rail);
  return Number.parseFloat(style.columnGap || style.gap || '0') || 0;
}

function cardStep(rail: HTMLElement): number {
  const item = rail.querySelector<HTMLElement>('.subscription-plan-rail__item');
  if (!item) return rail.clientWidth;
  return item.offsetWidth + railGap(rail);
}

/** Compare card track width to the rail viewport — independent of center-snap padding. */
function trackOverflowsViewport(rail: HTMLElement): boolean {
  const items = rail.querySelectorAll<HTMLElement>('.subscription-plan-rail__item');
  if (items.length === 0) return false;
  let track = 0;
  for (const item of items) track += item.offsetWidth;
  track += railGap(rail) * (items.length - 1);
  return track > rail.clientWidth + EDGE_EPSILON;
}

function syncOverflowState(rail: HTMLElement): boolean {
  const overflowing = trackOverflowsViewport(rail);
  rail.dataset.overflow = overflowing ? 'true' : 'false';
  return overflowing;
}

/**
 * Initial focused card (0-based):
 * - odd count → center card
 * - even count → card number n/2 (1-based), i.e. index n/2 - 1
 */
export function initialRailFocusIndex(cardCount: number): number {
  if (cardCount <= 0) return 0;
  return Math.floor((cardCount - 1) / 2);
}

function prefersCenteredRail(): boolean {
  return window.matchMedia?.('(max-width: 719px)').matches ?? true;
}

function scrollRailToFocusedCard(rail: HTMLElement, focusIndex: number): void {
  const items = rail.querySelectorAll<HTMLElement>('.subscription-plan-rail__item');
  const target = items[focusIndex] ?? items[0];
  if (!target) return;
  const left = target.offsetLeft + target.offsetWidth / 2 - rail.clientWidth / 2;
  const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
  rail.scrollTo({ left: Math.min(maxScroll, Math.max(0, left)), behavior: 'auto' });
}

export function useRailAutoscroll(
  railRef: RefObject<HTMLDivElement | null>,
  options: { readonly intervalMs?: number; readonly itemCount?: number } = {},
): void {
  const intervalMs = options.intervalMs ?? 5000;
  const itemCount = options.itemCount;

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    let intervalId = 0;
    let resumeId = 0;
    let programmaticUntil = 0;
    let paused = false;
    let didInitialScroll = false;
    let rafOuter = 0;
    let rafInner = 0;

    function hasOverflow(): boolean {
      return syncOverflowState(rail!);
    }

    function applyInitialFocus(): void {
      const overflowing = hasOverflow();
      if (!overflowing) {
        didInitialScroll = false;
        rail!.scrollLeft = 0;
        return;
      }
      if (didInitialScroll) return;

      // Tablet/desktop: free-scroll from the start, no center focus.
      if (!prefersCenteredRail()) {
        rail!.scrollLeft = 0;
        didInitialScroll = true;
        return;
      }

      window.cancelAnimationFrame(rafOuter);
      window.cancelAnimationFrame(rafInner);
      // Wait two frames so overflow spacers (::before/::after) are laid out.
      rafOuter = window.requestAnimationFrame(() => {
        rafInner = window.requestAnimationFrame(() => {
          const items = rail!.querySelectorAll('.subscription-plan-rail__item');
          programmaticUntil = Date.now() + 500;
          scrollRailToFocusedCard(rail!, initialRailFocusIndex(items.length));
          didInitialScroll = true;
        });
      });
    }

    function tick(): void {
      if (!rail || document.hidden || paused || reducedMotion || !hasOverflow()) return;
      const maxScroll = rail.scrollWidth - rail.clientWidth;
      const atEnd = rail.scrollLeft >= maxScroll - EDGE_EPSILON;
      programmaticUntil = Date.now() + 1000;
      rail.scrollTo({ left: atEnd ? 0 : rail.scrollLeft + cardStep(rail), behavior: 'smooth' });
    }

    function start(): void {
      window.clearInterval(intervalId);
      if (reducedMotion) return;
      intervalId = window.setInterval(tick, intervalMs);
    }

    function pause(): void {
      paused = true;
    }

    function resume(): void {
      paused = false;
      start();
    }

    function onUserScroll(): void {
      if (Date.now() < programmaticUntil) return;
      pause();
      window.clearTimeout(resumeId);
      resumeId = window.setTimeout(resume, intervalMs);
    }

    applyInitialFocus();
    start();

    const centerMedia = window.matchMedia?.('(max-width: 719px)');
    function onCenterModeChange(): void {
      didInitialScroll = false;
      applyInitialFocus();
    }
    centerMedia?.addEventListener?.('change', onCenterModeChange);

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            applyInitialFocus();
          })
        : null;
    resizeObserver?.observe(rail);

    rail.addEventListener('scroll', onUserScroll, { passive: true });
    rail.addEventListener('touchstart', onUserScroll, { passive: true });
    rail.addEventListener('wheel', onUserScroll, { passive: true });
    rail.addEventListener('pointerenter', pause);
    rail.addEventListener('pointerleave', resume);
    rail.addEventListener('focusin', pause);
    rail.addEventListener('focusout', resume);

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(resumeId);
      window.cancelAnimationFrame(rafOuter);
      window.cancelAnimationFrame(rafInner);
      centerMedia?.removeEventListener?.('change', onCenterModeChange);
      resizeObserver?.disconnect();
      rail.removeEventListener('scroll', onUserScroll);
      rail.removeEventListener('touchstart', onUserScroll);
      rail.removeEventListener('wheel', onUserScroll);
      rail.removeEventListener('pointerenter', pause);
      rail.removeEventListener('pointerleave', resume);
      rail.removeEventListener('focusin', pause);
      rail.removeEventListener('focusout', resume);
    };
  }, [railRef, intervalMs, itemCount]);
}
