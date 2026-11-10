import type { MouseEvent } from 'react';

/** Preserve the real previous route, its query/state and the native navigation history. */
export function handleGameDetailBack(event: MouseEvent<HTMLAnchorElement>): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    window.history.length <= 1
  )
    return;
  event.preventDefault();
  window.history.back();
}
