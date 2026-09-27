/** Keep same-origin links inside React so Android's process-local session survives navigation. */
export function installMobileNavigation(document: Document, window: Window): () => void {
  const navigate = (event: MouseEvent): void => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a[href]');
    if (
      !(anchor instanceof HTMLAnchorElement) ||
      anchor.hasAttribute('download') ||
      (anchor.target && anchor.target !== '_self')
    )
      return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin !== window.location.origin || !['https:', 'http:'].includes(url.protocol))
      return;
    event.preventDefault();
    const href = `${url.pathname}${url.search}${url.hash}`;
    if (href !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.pushState({}, '', href);
      window.dispatchEvent(new PopStateEvent('popstate'));
      window.scrollTo({ top: 0 });
    }
  };
  document.addEventListener('click', navigate);
  return () => document.removeEventListener('click', navigate);
}
