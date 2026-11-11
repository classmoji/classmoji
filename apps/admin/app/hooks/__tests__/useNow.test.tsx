// @vitest-environment jsdom
import { act } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatDate, formatDateTime, formatNumber, relativeTime } from '~/utils/time';

// The root loader's data: the instant the server rendered at.
const rootData: { now?: number } = {};
vi.mock('react-router', () => ({ useRouteLoaderData: () => rootData }));

const { useNow } = await import('../useNow');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SERVER_AT = new Date('2026-11-11T03:07:00Z');
// 59.5 minutes before the server render: "59 min" then, "1 hour" 40 s later.
const EVENT_AT = new Date(SERVER_AT.getTime() - 59.5 * 60_000 + 1_000).toISOString();

const Row = () => <p>{relativeTime(EVENT_AT, useNow())}</p>;

let root: Root | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.useRealTimers();
});

describe('useNow', () => {
  it('hydrates "how long ago" text without a mismatch, then shows the browser clock', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    // Server render.
    vi.setSystemTime(SERVER_AT);
    rootData.now = Date.now();
    const container = document.createElement('div');
    container.innerHTML = renderToString(<Row />);
    expect(container.textContent).toBe('59 min');

    // The browser hydrates 40 seconds later.
    vi.setSystemTime(new Date(SERVER_AT.getTime() + 40_000));
    expect(relativeTime(EVENT_AT, new Date())).toBe('1 hour');

    const recovered: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(container, <Row />, { onRecoverableError: e => recovered.push(e) });
    });

    expect(recovered).toEqual([]);
    // After hydration it re-renders from the browser's clock.
    expect(container.textContent).toBe('1 hour');
  });
});

describe('formatDate / formatDateTime / formatNumber', () => {
  // Fixed zone and locale, so the output does not depend on the machine's.
  // (Engine differences, e.g. JavaScriptCore's " at ", are outside what a
  // Node test can see; see formatDateTime.)
  it('format in en-US and America/New_York', () => {
    // 03:07 UTC is 10:07 PM the evening before in America/New_York.
    expect(formatDate(SERVER_AT, { timeStyle: 'short' })).toBe('10:07 PM');
    expect(formatDate(SERVER_AT)).toBe('Nov 10, 2026');
    expect(formatDateTime(SERVER_AT)).toBe('Nov 10, 2026, 10:07 PM EST');
    expect(formatDateTime('2026-07-01T16:05:00Z')).toBe('Jul 1, 2026, 12:05 PM EDT');
    expect(formatNumber(1234567)).toBe('1,234,567');
  });
});
