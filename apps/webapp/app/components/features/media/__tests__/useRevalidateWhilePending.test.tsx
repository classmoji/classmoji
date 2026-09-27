// @vitest-environment jsdom
/**
 * The media page reloads itself only while a video is optimising: one reload
 * per fresh load while any row is PENDING, none once nothing is, and never on
 * top of a reload already in flight.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const revalidate = vi.fn();
let revalidatorState: 'idle' | 'loading' = 'idle';
vi.mock('react-router', () => ({
  useRevalidator: () => ({ revalidate, state: revalidatorState }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { useRevalidateWhilePending } = await import('../useRevalidateWhilePending');
const { PENDING_REVALIDATE_MS } = await import('../mediaState');

type Row = { status: 'READY' | 'UPLOADING'; processing: 'NONE' | 'PENDING' | 'DONE' | 'FAILED' };

function Probe({ rows }: { rows: Row[] }) {
  useRevalidateWhilePending(rows);
  return null;
}

let container: HTMLDivElement;
let root: Root;
const render = (rows: Row[]) => act(() => root.render(createElement(Probe, { rows })));

beforeEach(() => {
  vi.useFakeTimers();
  revalidate.mockReset();
  revalidatorState = 'idle';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('useRevalidateWhilePending', () => {
  it('reloads once per load while a row is optimising', async () => {
    await render([{ status: 'READY', processing: 'PENDING' }]);
    act(() => vi.advanceTimersByTime(PENDING_REVALIDATE_MS - 1));
    expect(revalidate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(revalidate).toHaveBeenCalledTimes(1);

    // No new data yet: no second reload from the same load.
    act(() => vi.advanceTimersByTime(PENDING_REVALIDATE_MS * 3));
    expect(revalidate).toHaveBeenCalledTimes(1);

    // The reload brought rows that are still pending: armed again.
    await render([{ status: 'READY', processing: 'PENDING' }]);
    act(() => vi.advanceTimersByTime(PENDING_REVALIDATE_MS));
    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  it('stops once nothing is optimising', async () => {
    await render([{ status: 'READY', processing: 'PENDING' }]);
    await render([{ status: 'READY', processing: 'DONE' }]);
    act(() => vi.advanceTimersByTime(PENDING_REVALIDATE_MS * 5));
    expect(revalidate).not.toHaveBeenCalled();
  });

  it.each([
    ['nothing processed', { status: 'READY', processing: 'NONE' }],
    ['a failed job', { status: 'READY', processing: 'FAILED' }],
    ['an upload in flight', { status: 'UPLOADING', processing: 'NONE' }],
  ] as const)('never polls for %s', async (_label, only) => {
    await render([only]);
    act(() => vi.advanceTimersByTime(PENDING_REVALIDATE_MS * 5));
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('does not stack a reload on one already in flight', async () => {
    revalidatorState = 'loading';
    await render([{ status: 'READY', processing: 'PENDING' }]);
    act(() => vi.advanceTimersByTime(PENDING_REVALIDATE_MS));
    expect(revalidate).not.toHaveBeenCalled();
  });
});
