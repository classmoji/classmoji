// @vitest-environment jsdom
/**
 * Time on an attempt resumed after a gap. Opening the drawer posts
 * `recordModalOpen`; the server adds the time away (since the last close) to
 * both durations and answers with them. The server only ever raises a
 * duration, so the drawer's clock has to start from those values: a clock
 * still on the values loaded with the page (before the gap) sends totals below
 * the stored ones, and every second spent after resuming is dropped. These
 * cases run the real focus tracker under fake timers.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({ default: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { useAttemptTime } = await import('../QuizChat');
const { useQuizFocusMetrics } = await import('../useQuizFocusMetrics');

const HOUR = 3_600_000;
const LOADED = { totalMs: 60_000, unfocusedMs: 10_000 };
const GAP = 34 * HOUR;

type Body = Record<string, unknown> & { _action: string };
let posts: Body[] = [];
/** How the next `recordModalOpen` answers; the test settles it. */
let settleOpen: { resolve: (v: unknown) => void; reject: (e: unknown) => void } | null = null;

const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as Body;
  posts.push(body);
  if (body._action === 'recordModalOpen') {
    return new Promise((resolve, reject) => {
      settleOpen = { resolve, reject };
    });
  }
  return Promise.resolve({ ok: true, json: async () => ({ success: true }) });
});

const openAnswer = (durations: { total_duration_ms: number; unfocused_duration_ms: number }) => ({
  ok: true,
  json: async () => ({ success: true, gapApplied: true, gapMs: GAP, durations }),
});

let latest: ReturnType<typeof useAttemptTime> | null = null;
function Harness(props: { active: boolean; isVisible: boolean }) {
  latest = useAttemptTime({
    attemptId: 'attempt-1',
    active: props.active,
    isVisible: props.isVisible,
    initialTotalMs: LOADED.totalMs,
    initialUnfocusedMs: LOADED.unfocusedMs,
  });
  return null;
}

let container: HTMLDivElement;
let root: Root;
const render = async (props: { active: boolean; isVisible: boolean }) => {
  await act(async () => root.render(<Harness {...props} />));
};
const advance = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};
const flushPromises = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
};
const posted = (action: string) => posts.filter(body => body._action === action);

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(new Date('2026-11-12T10:00:00Z'));
  posts = [];
  settleOpen = null;
  latest = null;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useAttemptTime after a resume with a gap', () => {
  const stored = {
    total_duration_ms: LOADED.totalMs + GAP,
    unfocused_duration_ms: LOADED.unfocusedMs + GAP,
  };

  it('counts the time spent after resuming on top of the stored gap', async () => {
    await render({ active: true, isVisible: true });
    expect(posted('recordModalOpen')).toHaveLength(1);
    settleOpen!.resolve(openAnswer(stored));
    await flushPromises();

    // About four and a half minutes on the page.
    await advance(270_000);
    const checkpoints = posted('updateMetrics');
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints.at(-1)).toMatchObject({
      totalDurationMs: stored.total_duration_ms + 270_000,
      unfocusedDurationMs: stored.unfocused_duration_ms,
    });

    // The attempt completes while open: the final count and the panel's
    // numbers carry the gap and the time since.
    await render({ active: false, isVisible: true });
    expect(posted('updateMetrics').at(-1)).toMatchObject({
      totalDurationMs: stored.total_duration_ms + 270_000,
      unfocusedDurationMs: stored.unfocused_duration_ms,
    });
    expect(latest!.finalMetrics).toMatchObject({
      totalMs: stored.total_duration_ms + 270_000,
      focusedMs: LOADED.totalMs - LOADED.unfocusedMs + 270_000,
    });
  });

  it('sends no checkpoint before the open is answered, and one as soon as it is', async () => {
    await render({ active: true, isVisible: true });
    await advance(10_000);
    // A checkpoint now would carry the pre-gap totals.
    expect(posted('updateMetrics')).toHaveLength(0);

    settleOpen!.resolve(openAnswer(stored));
    await flushPromises();
    expect(posted('updateMetrics')).toHaveLength(1);
    // The time on the page so far is inside the gap the server measured.
    expect(posted('updateMetrics')[0]).toMatchObject({
      totalDurationMs: stored.total_duration_ms,
      unfocusedDurationMs: stored.unfocused_duration_ms,
    });

    // The next one (30 s after opening) counts on from there.
    await advance(20_000);
    expect(posted('updateMetrics').at(-1)).toMatchObject({
      totalDurationMs: stored.total_duration_ms + 20_000,
    });
  });

  const blur = () => act(async () => void window.dispatchEvent(new Event('blur')));
  const focus = () => act(async () => void window.dispatchEvent(new Event('focus')));

  it('adds the time away from the tab after resuming to the stored unfocused time', async () => {
    await render({ active: true, isVisible: true });
    settleOpen!.resolve(openAnswer(stored));
    await flushPromises();
    await advance(60_000);
    await blur();
    await advance(30_000);
    await focus();
    await advance(30_000);

    await render({ active: false, isVisible: true });
    expect(posted('updateMetrics').at(-1)).toMatchObject({
      totalDurationMs: stored.total_duration_ms + 120_000,
      unfocusedDurationMs: stored.unfocused_duration_ms + 30_000,
    });
  });

  it('counts a tab already away when the open is answered from the stored value, once', async () => {
    await render({ active: true, isVisible: true });
    await blur();
    await advance(10_000);
    // The ten seconds away are inside the gap the server measured.
    settleOpen!.resolve(openAnswer(stored));
    await flushPromises();
    await advance(20_000);
    await focus();
    await advance(10_000);

    await render({ active: false, isVisible: true });
    expect(posted('updateMetrics').at(-1)).toMatchObject({
      totalDurationMs: stored.total_duration_ms + 30_000,
      unfocusedDurationMs: stored.unfocused_duration_ms + 20_000,
    });
  });

  it('records the close with the gap included', async () => {
    await render({ active: true, isVisible: true });
    settleOpen!.resolve(openAnswer(stored));
    await flushPromises();
    await advance(60_000);

    await render({ active: true, isVisible: false });
    expect(posted('recordModalClose').at(-1)).toMatchObject({
      totalDurationMs: stored.total_duration_ms + 60_000,
      unfocusedDurationMs: stored.unfocused_duration_ms,
    });
  });

  it('loses nothing on a quick reload: stored values at or below the clock change nothing', async () => {
    await render({ active: true, isVisible: true });
    await advance(10_000);
    // No gap applied; the stored total is what the last close wrote.
    settleOpen!.resolve({
      ok: true,
      json: async () => ({
        success: true,
        gapApplied: false,
        gapMs: 0,
        durations: { total_duration_ms: 62_000, unfocused_duration_ms: 10_000 },
      }),
    });
    await flushPromises();
    expect(posted('updateMetrics').at(-1)).toMatchObject({
      totalDurationMs: LOADED.totalMs + 10_000,
      unfocusedDurationMs: LOADED.unfocusedMs,
    });
    await advance(20_000);
    expect(posted('updateMetrics').at(-1)).toMatchObject({
      totalDurationMs: LOADED.totalMs + 30_000,
      unfocusedDurationMs: LOADED.unfocusedMs,
    });
  });

  it('still sends checkpoints when the open fails', async () => {
    await render({ active: true, isVisible: true });
    settleOpen!.reject(new Error('offline'));
    await flushPromises();
    await advance(5_000);
    expect(posted('updateMetrics').at(-1)).toMatchObject({
      totalDurationMs: LOADED.totalMs + 5_000,
      unfocusedDurationMs: LOADED.unfocusedMs,
    });
  });

  it('still sends checkpoints when the open answers without durations', async () => {
    await render({ active: true, isVisible: true });
    settleOpen!.resolve({ ok: false, json: async () => ({ error: 'Forbidden' }) });
    await flushPromises();
    await advance(5_000);
    expect(posted('updateMetrics').at(-1)).toMatchObject({
      totalDurationMs: LOADED.totalMs + 5_000,
    });
  });
});

describe('useQuizFocusMetrics raised from stored values', () => {
  let snapshot: (() => { totalMs: number; unfocusedMs: number }) | null = null;
  function Tracker(props: { total: number; unfocused: number }) {
    snapshot = useQuizFocusMetrics({
      isActive: true,
      attemptId: 'attempt-1',
      initialTotalMs: props.total,
      initialUnfocusedMs: props.unfocused,
    }).getMetricsSnapshot;
    return null;
  }

  it('ignores a refreshed value at or below its own count', async () => {
    await act(async () => root.render(<Tracker total={60_000} unfocused={0} />));
    await advance(20_000);
    // A refresh brings back what a checkpoint wrote ten seconds ago.
    await act(async () => root.render(<Tracker total={70_000} unfocused={0} />));
    expect(snapshot!().totalMs).toBe(80_000);
  });

  it('takes a refreshed value above its own count, and counts on from it', async () => {
    await act(async () => root.render(<Tracker total={60_000} unfocused={0} />));
    await advance(20_000);
    await act(async () => root.render(<Tracker total={500_000} unfocused={400_000} />));
    await advance(10_000);
    expect(snapshot!()).toEqual({ totalMs: 510_000, unfocusedMs: 400_000 });
  });
});
