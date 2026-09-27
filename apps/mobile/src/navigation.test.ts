// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installMobileNavigation } from './navigation.js';

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.innerHTML = '';
  window.history.replaceState({}, '', '/');
  vi.restoreAllMocks();
});
describe('mobile same-document navigation', () => {
  it('opens an existing LK2 section without reloading the session and releases listeners', () => {
    const push = vi.spyOn(window.history, 'pushState');
    const pop = vi.fn();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    window.addEventListener('popstate', pop);
    document.body.innerHTML = '<a href="/profile"><span>Профиль</span></a>';
    dispose = installMobileNavigation(document, window);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.querySelector('span')?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(window.location.pathname).toBe('/profile');
    expect(push).toHaveBeenCalledOnce();
    expect(pop).toHaveBeenCalledOnce();
    dispose();
    const second = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    document.querySelector('span')?.dispatchEvent(second);
    expect(second.defaultPrevented).toBe(false);
    window.removeEventListener('popstate', pop);
  });
  it.each(['https://outside.test/', 'mailto:support@example.test'])(
    'leaves external links outside the app router: %s',
    (href) => {
      const push = vi.spyOn(window.history, 'pushState');
      document.body.innerHTML = `<a href="${href}">Открыть</a>`;
      dispose = installMobileNavigation(document, window);
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
      document.querySelector('a')?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(push).not.toHaveBeenCalled();
    },
  );
});
