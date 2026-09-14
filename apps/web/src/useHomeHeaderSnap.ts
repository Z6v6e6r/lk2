import { useEffect, useRef } from 'react';

/** Snap only across Home's hero; the recommendation feed keeps native scrolling. */
export function useHomeHeaderSnap(enabled: boolean) {
  const homeRef = useRef<HTMLElement>(null);
  const recommendationsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const home = homeRef.current;
    const recommendations = recommendationsRef.current;
    if (!enabled || !home || !recommendations) return;

    let frame = 0;
    let animating = false;
    let wheelConsumed = false;
    let wheelTimer = 0;
    let touchTimer = 0;
    let direction = 0;
    let touch: { x: number; y: number; axis: 'x' | 'y' | null; consumed: boolean } | null = null;

    const excluded = (target: EventTarget | null, delta: number) => {
      if (!(target instanceof Element)) return true;
      if (target.closest('[role="dialog"], dialog, input, textarea, select, .fh-bottom-nav'))
        return true;
      // Leave independently scrollable content to its own scroll container.
      for (let element = target; element !== home; element = element.parentElement!) {
        if (!element) return true;
        if (/(auto|scroll)/.test(getComputedStyle(element).overflowY)) {
          if (delta < 0 && element.scrollTop > 0) return true;
          if (delta > 0 && element.scrollTop + element.clientHeight < element.scrollHeight)
            return true;
        }
      }
      return false;
    };

    const snap = (delta: number): boolean => {
      if (delta === 0) return false;
      if (animating) return true;
      const current = window.scrollY;
      const top = Math.max(0, home.getBoundingClientRect().top + current);
      const boundary = recommendations.getBoundingClientRect().top + current;
      if (boundary <= top + 1 || current < top - 1 || current > boundary + 1) return false;
      if (delta > 0 ? current >= boundary - 1 : current <= top + 1) return false;
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const target = Math.min(delta > 0 ? boundary : top, maxScroll);
      if (Math.abs(target - current) < 1) return false;
      direction = 0;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        window.scrollTo({ top: target, behavior: 'instant' });
        return true;
      }
      animating = true;
      const started = performance.now();
      const step = (now: number) => {
        const progress = Math.min(1, (now - started) / 220);
        window.scrollTo({
          top: current + (target - current) * (1 - (1 - progress) ** 3),
          behavior: 'instant',
        });
        if (progress < 1) frame = requestAnimationFrame(step);
        else animating = false;
      };
      frame = requestAnimationFrame(step);
      return true;
    };

    const onWheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        event.metaKey ||
        !event.cancelable ||
        Math.abs(event.deltaY) <= Math.abs(event.deltaX) ||
        excluded(event.target, event.deltaY)
      )
        return;
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => {
        wheelTimer = 0;
        wheelConsumed = false;
        direction = 0;
      }, 160);
      direction = wheelConsumed ? 0 : Math.sign(event.deltaY);
      if (wheelConsumed || snap(direction)) {
        wheelConsumed = true;
        event.preventDefault();
      }
    };
    const onTouchStart = (event: TouchEvent) => {
      window.clearTimeout(touchTimer);
      direction = 0;
      const point = event.touches.length === 1 ? event.touches[0] : null;
      touch = point ? { x: point.clientX, y: point.clientY, axis: null, consumed: false } : null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const point = event.touches[0];
      if (event.touches.length !== 1) {
        touch = null;
        direction = 0;
        return;
      }
      if (!touch || !point) return;
      const dx = touch.x - point.clientX;
      const dy = touch.y - point.clientY;
      if (!touch.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 8)
        touch.axis = Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
      if (touch.axis !== 'y' || excluded(event.target, dy)) return;
      direction = touch.consumed ? 0 : Math.sign(dy);
      if (event.cancelable && (touch.consumed || snap(direction))) {
        touch.consumed = true;
        event.preventDefault();
      }
      touch.x = point.clientX;
      touch.y = point.clientY;
    };
    const onTouchEnd = () => {
      touch = null;
      touchTimer = window.setTimeout(() => {
        direction = 0;
      }, 160);
    };
    const onTouchCancel = () => {
      touch = null;
      direction = 0;
    };
    const onScroll = () => {
      if (!touch && direction !== 0) {
        window.clearTimeout(touchTimer);
        touchTimer = window.setTimeout(() => {
          direction = 0;
        }, 160);
      }
      // Also handle native touch scrolling/inertia entering the hero interval.
      if (!animating && direction !== 0 && snap(direction)) {
        if (touch) touch.consumed = true;
        else if (wheelTimer) wheelConsumed = true;
      }
    };

    home.addEventListener('wheel', onWheel, { passive: false });
    home.addEventListener('touchstart', onTouchStart, { passive: true });
    home.addEventListener('touchmove', onTouchMove, { passive: false });
    home.addEventListener('touchend', onTouchEnd);
    home.addEventListener('touchcancel', onTouchCancel);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(wheelTimer);
      window.clearTimeout(touchTimer);
      home.removeEventListener('wheel', onWheel);
      home.removeEventListener('touchstart', onTouchStart);
      home.removeEventListener('touchmove', onTouchMove);
      home.removeEventListener('touchend', onTouchEnd);
      home.removeEventListener('touchcancel', onTouchCancel);
      window.removeEventListener('scroll', onScroll);
    };
  }, [enabled]);

  return { homeRef, recommendationsRef };
}
