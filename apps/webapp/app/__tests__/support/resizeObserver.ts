/**
 * Vitest setup: a do-nothing `ResizeObserver` for the jsdom tests.
 *
 * jsdom has none, and antd components construct one when they mount (antd 6
 * more of them, through `@rc-component/resize-observer`, with no polyfill).
 * jsdom lays nothing out, so there is never a size to report: observing is a
 * no-op. Only a DOM environment gets it, and only when nothing has defined one
 * already; a test that needs a working observer can still assign its own.
 */
if (typeof window !== 'undefined' && typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
}
