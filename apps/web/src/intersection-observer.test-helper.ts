/**
 * Controllable `IntersectionObserver` stub for jsdom tests.
 *
 * Home scrolls as one page, so the recommendation feed asks for its next page when a sentinel at
 * the end of the list enters the viewport. jsdom has no `IntersectionObserver`, and a real
 * observer could not be driven deterministically, so tests install this stub and fire the callback
 * for the sentinel explicitly.
 */
export interface IntersectionObserverStub {
  /** Fires the observer that watches the feed's load-more sentinel, if it is still attached. */
  readonly triggerLoadMoreSentinel: () => void;
  /** Restores the previous global implementation. */
  readonly restore: () => void;
}

interface StubInstance {
  readonly callback: IntersectionObserverCallback;
  readonly elements: Element[];
}

const SENTINEL_CLASS = 'booking-recommendations__sentinel';

export function stubIntersectionObserver(): IntersectionObserverStub {
  const original = Reflect.get(globalThis, 'IntersectionObserver') as unknown;
  const instances: StubInstance[] = [];

  class StubIntersectionObserver {
    public readonly root = null;
    public readonly rootMargin = '0px';
    public readonly thresholds: readonly number[] = [];
    private readonly elements: Element[] = [];

    public constructor(public readonly callback: IntersectionObserverCallback) {
      instances.push({ callback, elements: this.elements });
    }

    public observe(element: Element): void {
      this.elements.push(element);
    }

    public unobserve(element: Element): void {
      const index = this.elements.indexOf(element);
      if (index >= 0) this.elements.splice(index, 1);
    }

    public disconnect(): void {
      this.elements.length = 0;
    }

    public takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  Reflect.set(globalThis, 'IntersectionObserver', StubIntersectionObserver);

  return {
    triggerLoadMoreSentinel: () => {
      for (const instance of instances) {
        const sentinel = instance.elements.find((element) =>
          (element.className || '').toString().includes(SENTINEL_CLASS),
        );
        if (!sentinel) continue;
        instance.callback(
          [{ isIntersecting: true, target: sentinel } as unknown as IntersectionObserverEntry],
          instance as unknown as IntersectionObserver,
        );
      }
    },
    restore: () => {
      Reflect.set(globalThis, 'IntersectionObserver', original);
    },
  };
}
