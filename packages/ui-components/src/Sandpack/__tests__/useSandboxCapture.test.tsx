// @vitest-environment jsdom
/**
 * useSandboxCapture against a fake Sandpack (`useSandpack`, `useSandpackConsole`):
 * the test owns the provider's status, files, clients and console, and
 * broadcasts bundler messages to every listener the hook registered.
 *
 * - A capture hands every client the current files before its refresh, and
 *   finishes only on a `done` after a `start` it saw, then a tail; a run that
 *   starts during the tail is waited for too.
 * - No `done` in time: the capture reports `timedOut`; the first `done` not
 *   coming within the load timeout (counted from Sandpack's `running`) is
 *   `loadFailed`.
 * - The preview unmounting resets `ready`; mounting again after the bundler
 *   went away (`idle`, `timeout`) starts Sandpack once, StrictMode included,
 *   and never on a first mount.
 * - The error is kept from the messages, so a restarted bundler's error
 *   (which `sandpack.error` never sees) still reaches the capture.
 */

import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Message = { type: string; [key: string]: unknown };
type Client = { sandboxSetup: { files: Record<string, { code: string }>; template: string } };

const fake = vi.hoisted(() => {
  const state = {
    status: 'running' as string,
    files: {} as Record<string, { code: string }>,
    clients: {} as Record<string, Client>,
    logs: [] as Array<{ method: string; data: unknown[] }>,
    error: null as unknown,
    listeners: new Set<(message: Message) => void>(),
    /** Each dispatch, with the files client `a` held at that moment. */
    dispatched: [] as Array<{ type: string; filesAtDispatch: Record<string, { code: string }> }>,
    runSandpack: null as unknown as ReturnType<typeof vi.fn>,
  };
  return state;
});

vi.mock('@codesandbox/sandpack-react', () => ({
  useSandpack: () => ({
    sandpack: {
      status: fake.status,
      files: fake.files,
      clients: fake.clients,
      environment: 'static',
      error: fake.error,
      runSandpack: fake.runSandpack,
      updateFile: vi.fn(),
    },
    listen: (listener: (message: Message) => void) => {
      fake.listeners.add(listener);
      return () => fake.listeners.delete(listener);
    },
    dispatch: (message: { type: string }) => {
      fake.dispatched.push({
        type: message.type,
        filesAtDispatch: fake.clients.a?.sandboxSetup.files,
      });
    },
  }),
  useSandpackConsole: () => ({ logs: fake.logs }),
}));

import useSandboxCapture, { type SandboxCapture } from '../useSandboxCapture.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TIMES = { runTimeoutMs: 1_000, tailMs: 100, rerunDelayMs: 50, loadTimeoutMs: 3_000 };

let hook: ReturnType<typeof useSandboxCapture>;
function Harness({ enabled }: { enabled: boolean }) {
  hook = useSandboxCapture({ enabled, ...TIMES });
  return null;
}

let container: HTMLDivElement;
let root: Root;
let strict = false;

const render = (enabled: boolean) =>
  act(() => {
    const harness = <Harness enabled={enabled} />;
    root.render(strict ? <StrictMode>{harness}</StrictMode> : harness);
  });

/** Broadcast a bundler message, then re-render (Sandpack's state may have moved with it). */
const emit = async (message: Message, enabled = true) => {
  await act(async () => {
    for (const listener of [...fake.listeners]) listener(message);
  });
  await render(enabled);
};

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const refreshes = () => fake.dispatched.filter(d => d.type === 'refresh').length;

/** Starts a capture; `.result` is set once it resolves. */
function startCapture(paths = ['/index.js']) {
  const pending: { result: SandboxCapture | null } = { result: null };
  void act(() => {
    void hook.capture(paths).then(r => {
      pending.result = r;
    });
  });
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers();
  fake.status = 'running';
  fake.files = { '/index.js': { code: 'console.log(1)' } };
  fake.clients = {
    a: { sandboxSetup: { files: { '/index.js': { code: 'old' } }, template: 'static' } },
  };
  fake.logs = [];
  fake.error = null;
  fake.listeners.clear();
  fake.dispatched = [];
  fake.runSandpack = vi.fn(async () => {
    fake.status = 'running';
  });
  strict = false;
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.useRealTimers();
});

describe('ready and the display re-run', () => {
  it('turns ready on the first done and re-runs once for the console', async () => {
    await render(true);
    expect(hook.ready).toBe(false);
    await emit({ type: 'start' });
    await emit({ type: 'done' });
    expect(hook.ready).toBe(true);
    await advance(TIMES.rerunDelayMs);
    expect(refreshes()).toBe(1);
    await emit({ type: 'done' });
    await advance(TIMES.rerunDelayMs);
    expect(refreshes()).toBe(1);
  });
});

describe('capture', () => {
  it('hands every client the current files before the refresh', async () => {
    fake.clients.b = { sandboxSetup: { files: {}, template: 'static' } };
    await render(true);
    await emit({ type: 'done' });
    startCapture();
    expect(fake.dispatched.at(-1)).toEqual({
      type: 'refresh',
      filesAtDispatch: { '/index.js': { code: 'console.log(1)' } },
    });
    expect(fake.clients.b.sandboxSetup).toEqual({ files: fake.files, template: 'static' });
  });

  it('cancels a pending display re-run', async () => {
    await render(true);
    await emit({ type: 'done' });
    startCapture();
    expect(refreshes()).toBe(1);
    await advance(TIMES.rerunDelayMs * 2);
    expect(refreshes()).toBe(1);
  });

  it('finishes only on a done after a start it saw, then the tail', async () => {
    await render(true);
    await emit({ type: 'done' });
    const pending = startCapture();
    // A done already in flight belongs to an earlier run.
    await emit({ type: 'done' });
    await advance(TIMES.tailMs * 3);
    expect(pending.result).toBeNull();

    await emit({ type: 'start' });
    fake.logs = [{ method: 'log', data: ['hello'] }];
    await emit({ type: 'done' });
    await advance(TIMES.tailMs - 1);
    expect(pending.result).toBeNull();
    // A line that trails done still lands.
    fake.logs = [...fake.logs, { method: 'warn', data: ['late'] }];
    await render(true);
    await advance(1);
    expect(pending.result).toEqual({
      files: { '/index.js': 'console.log(1)' },
      console: [
        { method: 'log', text: 'hello' },
        { method: 'warn', text: 'late' },
      ],
      errors: [],
      timedOut: false,
    });
  });

  it('reports timedOut when the run does not finish, after the tail', async () => {
    await render(true);
    await emit({ type: 'done' });
    const pending = startCapture();
    await emit({ type: 'start' });
    await advance(TIMES.runTimeoutMs);
    expect(pending.result).toBeNull();
    await advance(TIMES.tailMs);
    expect(pending.result?.timedOut).toBe(true);
  });

  it('waits for a run that starts during the tail, then takes the tail again', async () => {
    await render(true);
    await emit({ type: 'done' });
    const pending = startCapture();
    await emit({ type: 'start' });
    await emit({ type: 'done' });
    await advance(TIMES.tailMs / 2);
    // The delayed recompile lands: the preview restarts, its console resets.
    await emit({ type: 'start' });
    fake.logs = [];
    await render(true);
    await advance(TIMES.tailMs);
    expect(pending.result).toBeNull();

    fake.logs = [{ method: 'log', data: ['second run'] }];
    await emit({ type: 'done' });
    await advance(TIMES.tailMs - 1);
    expect(pending.result).toBeNull();
    await advance(1);
    expect(pending.result).toMatchObject({
      console: [{ method: 'log', text: 'second run' }],
      timedOut: false,
    });
  });

  it('bounds the wait for a run that starts during the tail', async () => {
    await render(true);
    await emit({ type: 'done' });
    const pending = startCapture();
    await emit({ type: 'start' });
    await emit({ type: 'done' });
    await emit({ type: 'start' });
    await advance(TIMES.runTimeoutMs + TIMES.tailMs);
    expect(pending.result?.timedOut).toBe(true);
  });

  it('keeps the error from the messages, the way Sandpack does', async () => {
    await render(true);
    await emit({ type: 'done' });
    const pending = startCapture();
    await emit({ type: 'start' });
    await emit({
      type: 'action',
      action: 'show-error',
      title: 'TypeError',
      message: "Cannot read properties of undefined (reading 'x')",
      payload: {
        frames: [
          { fileName: 'bundle.js' },
          { _originalFileName: '/index.js', _originalLineNumber: 3, _originalColumnNumber: 7 },
        ],
      },
    });
    // A clean `done` would clear it (Sandpack's rule); this run's build failed.
    await emit({ type: 'done', compilatonError: true });
    await advance(TIMES.tailMs);
    expect(pending.result?.errors).toEqual([
      {
        kind: 'runtime',
        title: 'TypeError',
        message: "Cannot read properties of undefined (reading 'x')",
        path: '/index.js',
        line: 3,
        column: 7,
      },
    ]);
  });

  it('drops the error when the next run starts', async () => {
    await render(true);
    await emit({
      type: 'action',
      action: 'notification',
      notificationType: 'error',
      title: 'Boom',
    });
    await emit({ type: 'done' });
    const pending = startCapture();
    await emit({ type: 'start' });
    await emit({ type: 'done' });
    await advance(TIMES.tailMs);
    expect(pending.result?.errors).toEqual([]);
  });
});

describe('loadFailed', () => {
  it('turns on when the first done does not come in time, and a later done clears it', async () => {
    await render(true);
    await advance(TIMES.loadTimeoutMs - 1);
    expect(hook.loadFailed).toBe(false);
    await advance(1);
    expect(hook.loadFailed).toBe(true);
    await emit({ type: 'done' });
    expect(hook.loadFailed).toBe(false);
  });

  it('does not count while Sandpack has not been asked to start (a lazy sandbox off-screen)', async () => {
    fake.status = 'initial';
    await render(true);
    await advance(TIMES.loadTimeoutMs * 2);
    expect(hook.loadFailed).toBe(false);
    fake.status = 'running';
    await render(true);
    await advance(TIMES.loadTimeoutMs);
    expect(hook.loadFailed).toBe(true);
  });

  it("follows Sandpack's own bundler timeout", async () => {
    await render(true);
    fake.status = 'timeout';
    await render(true);
    expect(hook.loadFailed).toBe(true);
  });

  it('is off while no preview is mounted', async () => {
    await render(false);
    await advance(TIMES.loadTimeoutMs * 2);
    expect(hook.loadFailed).toBe(false);
  });
});

describe('the preview unmounting and mounting again', () => {
  /** A sandbox that ran, then froze: the last preview unregistered, Sandpack is idle. */
  async function bootThenFreeze() {
    await render(true);
    await emit({ type: 'start' });
    await emit({ type: 'done' });
    expect(hook.ready).toBe(true);
    fake.status = 'idle';
    await render(false);
  }

  for (const mode of ['plain', 'StrictMode'] as const) {
    it(`resets ready and starts Sandpack once on the next mount (${mode})`, async () => {
      strict = mode === 'StrictMode';
      await bootThenFreeze();
      expect(hook.ready).toBe(false);
      expect(fake.runSandpack).not.toHaveBeenCalled();

      await render(true);
      await advance(0);
      expect(fake.runSandpack).toHaveBeenCalledTimes(1);
      await render(true);
      // Submit waits for the new bundler's own first done.
      expect(hook.ready).toBe(false);
      await emit({ type: 'start' });
      await emit({ type: 'done' });
      expect(hook.ready).toBe(true);
      // And it gets its own display re-run.
      const before = refreshes();
      await advance(TIMES.rerunDelayMs);
      expect(refreshes()).toBe(before + 1);
    });

    it(`never starts Sandpack on a first mount, even once it reads idle (${mode})`, async () => {
      strict = mode === 'StrictMode';
      // Under StrictMode the preview's double effect leaves a never-booted
      // provider idle while its lazy start is still pending.
      fake.status = 'initial';
      await render(true);
      fake.status = 'idle';
      await render(true);
      await advance(TIMES.loadTimeoutMs);
      expect(fake.runSandpack).not.toHaveBeenCalled();
    });
  }

  it('starts Sandpack again after its own bundler timeout', async () => {
    await render(true);
    fake.status = 'timeout';
    await render(true);
    await render(false);
    await render(true);
    await advance(0);
    expect(fake.runSandpack).toHaveBeenCalledTimes(1);
  });

  it('leaves a provider that is still running to Sandpack (it creates the client itself)', async () => {
    await render(true);
    await emit({ type: 'done' });
    await render(false);
    await render(true);
    await advance(0);
    expect(fake.runSandpack).not.toHaveBeenCalled();
  });

  it('counts the load timeout again for the restarted bundler', async () => {
    await bootThenFreeze();
    await render(true);
    await advance(0);
    await render(true);
    await advance(TIMES.loadTimeoutMs);
    expect(hook.loadFailed).toBe(true);
  });

  it('keeps the error of a restarted bundler, which sandpack.error never sees', async () => {
    await bootThenFreeze();
    await render(true);
    await advance(0);
    await render(true);
    await emit({ type: 'start' });
    await emit({ type: 'done' });
    const pending = startCapture();
    await emit({ type: 'start' });
    await emit({
      type: 'action',
      action: 'show-error',
      title: 'SyntaxError',
      path: '/index.js',
      message: '/index.js: Unexpected token (2:4)',
      line: 2,
      column: 4,
    });
    await emit({ type: 'done', compilatonError: true });
    await advance(TIMES.tailMs);
    expect(fake.error).toBeNull();
    expect(pending.result?.errors).toEqual([
      {
        kind: 'compile',
        title: 'SyntaxError',
        message: 'Unexpected token',
        path: '/index.js',
        line: 2,
        column: 4,
      },
    ]);
  });
});
