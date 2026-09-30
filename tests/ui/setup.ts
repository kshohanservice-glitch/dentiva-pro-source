/**
 * jsdom preparation for the renderer tests.
 *
 * Only browser features that jsdom does not implement are stubbed here; the
 * bridge, the database and every service the screens talk to are real (see
 * `harness.tsx`). The stubs are deliberately inert — nothing in them can make a
 * broken screen look finished.
 */
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { installBridge, setRouter } from './bridge';

// Bind the renderer to the test bridge before any renderer module loads.
installBridge();

afterEach(() => {
  setRouter(null);
  cleanup();
});

// jsdom has no layout engine, so these observers are the ones the components
// expect (virtualised tables and the reduced-motion hook).
class ResizeObserverStub implements ResizeObserver {
  observe(): void {
    // no layout in jsdom
  }
  unobserve(): void {
    // no layout in jsdom
  }
  disconnect(): void {
    // no layout in jsdom
  }
}

class IntersectionObserverStub implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = '0px';
  readonly thresholds: ReadonlyArray<number> = [0];
  observe(): void {
    // no layout in jsdom
  }
  unobserve(): void {
    // no layout in jsdom
  }
  disconnect(): void {
    // no layout in jsdom
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

Object.defineProperty(window, 'ResizeObserver', { writable: true, value: ResizeObserverStub });
Object.defineProperty(window, 'IntersectionObserver', { writable: true, value: IntersectionObserverStub });

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

Element.prototype.scrollIntoView = vi.fn();
window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
