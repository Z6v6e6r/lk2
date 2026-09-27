import { useEffect, useState } from 'react';

/** Compare protocol/host explicitly: custom-scheme URL.origin can be the string "null". */
export function isAppNavigation(destination: URL, current: URL): boolean {
  return (
    destination.protocol === current.protocol &&
    destination.host === current.host &&
    destination.username === '' &&
    destination.password === ''
  );
}

export function useCabinetRoute(): string {
  const [route, setRoute] = useState('/');
  useEffect(() => {
    // A new authenticated cabinet starts at home, including after a different account signs in.
    window.history.replaceState(null, '', '/');
    const changed = () => {
      setRoute(window.location.pathname + window.location.search);
      window.dispatchEvent(new Event('hashchange'));
    };
    const clicked = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')) return;
      const target = new URL(anchor.href, window.location.href);
      if (!isAppNavigation(target, new URL(window.location.href))) return;
      event.preventDefault();
      window.history.pushState(null, '', target.pathname + target.search + target.hash);
      changed();
      if (target.hash) {
        // Existing profile settings anchors must still scroll inside the native SPA.
        document.getElementById(target.hash.slice(1))?.scrollIntoView({ behavior: 'instant' });
      } else window.scrollTo({ top: 0, behavior: 'instant' });
    };
    document.addEventListener('click', clicked);
    window.addEventListener('popstate', changed);
    return () => {
      document.removeEventListener('click', clicked);
      window.removeEventListener('popstate', changed);
    };
  }, []);
  return route;
}
