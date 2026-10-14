/**
 * useSandboxCapture: reads what a running code sandbox did, for a submission.
 * Use it inside the sandbox's SandpackProvider (SandpackEmbed's `children`).
 *
 * The rules come from the quiz mockup, proven against live Sandpack
 * (plans/2026-10-12-quiz-sandbox/mockup.html):
 * - `ready` turns true on the bundler's first `done` and stays true while the
 *   preview stays mounted. Sandpack reports `status: 'running'` before it has
 *   booted, so the status alone can't say the code ran.
 * - Sandpack drops the first run's console on about half of cold starts, so
 *   the sandbox runs once more about 800 ms after its first `done`, for the
 *   console the student sees. Capture never relies on that run.
 * - `capture` always runs the code again: it cancels a pending display re-run
 *   (which would restart the preview mid-capture and wipe its console),
 *   refreshes, waits for `done` (8 s, then reports `timedOut`), then waits
 *   about 600 ms for console lines that trail `done`, and reads the files,
 *   the console and the error (cleaned: `sandboxCapture.ts`). A run that
 *   starts during that tail (the editor's delayed recompile, 500 ms after the
 *   last keystroke, when Submit came right after typing) restarts the
 *   preview and its console, so the capture waits for that run's `done` too
 *   (the same 8 s bound) and takes the tail again.
 * - `loadFailed`: no `done` within 30 s of the bundler being asked to start,
 *   or Sandpack's own bundler timeout. A school network that blocks the
 *   bundler's host looks like this. A later `done` clears it. The timer arms
 *   on Sandpack's `running`, not on the preview mounting: a lazy provider
 *   starts its bundler only once the sandbox nears the viewport.
 *
 * `enabled` is whether a preview is mounted: without one no bundler runs, so
 * the re-run and the load timer are not armed, and unmounting it resets
 * `ready` (a remounted preview is a new bundler whose first `done` counts).
 *
 * A preview that unmounts after the provider had a bundler (live → frozen)
 * leaves Sandpack `idle`, and a preview mounted while `idle` only registers
 * its iframe: no bundler starts. So when the preview mounts again (Run, or a
 * failed reply reopening the sandbox) and Sandpack is `idle` or `timeout`,
 * the hook starts it (`runSandpack`). Not on a first mount: there the
 * provider's lazy start is still pending, and under StrictMode Sandpack
 * already reads `idle` (the preview's double effect unregisters its iframe
 * once), so a second start would race it with two clients on one iframe.
 *
 * The provider only follows the first bundler it ever started (it attaches
 * its message handler once), so after such a restart `sandpack.error` never
 * changes again. The capture keeps the error itself, by the provider's own
 * rule (`errorAfterMessage`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSandpack, useSandpackConsole } from '@codesandbox/sandpack-react';
import {
  DEFAULT_CAPTURE_LIMITS,
  capturedErrorsOf,
  consoleLinesOf,
  errorAfterMessage,
  filesAt,
  type CaptureLimits,
  type CapturedConsoleLine,
  type CapturedError,
  type SandpackConsoleEntry,
  type SandpackErrorLike,
  type SandpackMessageLike,
} from './sandboxCapture.ts';

export interface SandboxCapture {
  /** The code of each path asked for. */
  files: Record<string, string>;
  console: CapturedConsoleLine[];
  errors: CapturedError[];
  /** The run did not finish within the wait: the console may be partial. */
  timedOut: boolean;
}

export interface UseSandboxCaptureOptions {
  /** A preview is mounted (a bundler can run). */
  enabled: boolean;
  limits?: CaptureLimits;
  /** How long a capture waits for the run to finish. Default 8 s. */
  runTimeoutMs?: number;
  /** How long it then waits for trailing console lines. Default 600 ms. */
  tailMs?: number;
  /** The display re-run's delay after the first `done`. Default 800 ms. */
  rerunDelayMs?: number;
  /** How long the bundler may take to finish its first run. Default 30 s. */
  loadTimeoutMs?: number;
}

/**
 * How many runs that start during a capture's tail it waits for. The editor
 * is read-only while a capture runs, so at most one recompile is pending.
 */
const MAX_TRAILING_RUNS = 1;

export default function useSandboxCapture({
  enabled,
  limits = DEFAULT_CAPTURE_LIMITS,
  runTimeoutMs = 8_000,
  tailMs = 600,
  rerunDelayMs = 800,
  loadTimeoutMs = 30_000,
}: UseSandboxCaptureOptions) {
  const { sandpack, listen, dispatch } = useSandpack();
  const { logs } = useSandpackConsole({
    resetOnPreviewRestart: true,
    showSyntaxError: true,
    maxMessageCount: 200,
  });

  // What the sandbox holds now, for a capture that reads it after its waits.
  const latest = useRef({
    files: sandpack.files as Record<string, { code: string } | undefined>,
    logs: logs as ReadonlyArray<SandpackConsoleEntry>,
  });
  latest.current = { files: sandpack.files, logs };
  // The bundler clients and the files to hand them, for a capture that must
  // run what the editor holds (see `capture`).
  const runtime = useRef({ clients: sandpack.clients, environment: sandpack.environment });
  runtime.current = { clients: sandpack.clients, environment: sandpack.environment };
  const listenRef = useRef(listen);
  listenRef.current = listen;
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const statusRef = useRef(sandpack.status);
  statusRef.current = sandpack.status;
  const runSandpackRef = useRef(sandpack.runSandpack);
  runSandpackRef.current = sandpack.runSandpack;

  const [ready, setReady] = useState(false);
  const [loadTimedOut, setLoadTimedOut] = useState(false);
  const readyRef = useRef(false);
  // Sandpack has been asked to start a bundler for the mounted preview
  // (`running`): this mount's load timer may arm. `booted`: that happened
  // for some mount, so an `idle` provider is one whose bundler went away.
  const [started, setStarted] = useState(false);
  const booted = useRef(false);
  // The error Sandpack would hold (see the header): kept from every bundler.
  const error = useRef<SandpackErrorLike | null>(null);

  const running = sandpack.status === 'running';
  useEffect(() => {
    if (!enabled || !running) return;
    booted.current = true;
    setStarted(true);
  }, [enabled, running]);

  // The preview unmounted: its bundler is gone, and the next one must show
  // its own first `done` before Submit counts on it.
  useEffect(() => {
    if (enabled) return;
    readyRef.current = false;
    setReady(false);
    setLoadTimedOut(false);
    setStarted(false);
    error.current = null;
  }, [enabled]);

  // The preview mounted again after its bundler went away: start one (see
  // the header). Keyed on `enabled` alone and deferred a tick, reading the
  // status then: the new preview's own effects (StrictMode's register,
  // unregister, register) have run and settled it, and a status change
  // while mounted never restarts anything. A fresh mount has not `booted`.
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setTimeout(() => {
      const status = statusRef.current;
      if (status === 'timeout' || (status === 'idle' && booted.current)) {
        void runSandpackRef.current();
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [enabled]);

  useEffect(
    () =>
      listenRef.current(message => {
        const next = errorAfterMessage(message as unknown as SandpackMessageLike);
        if (next !== undefined) error.current = next;
      }),
    []
  );

  // The display re-run after the first `done` (see the header), and `ready`.
  const rerun = useRef<{ fired: boolean; timer: ReturnType<typeof setTimeout> | null }>({
    fired: false,
    timer: null,
  });
  useEffect(() => {
    if (!enabled) return undefined;
    // A preview mounting starts a new bundler, whose first run needs its own re-run.
    const r = rerun.current;
    r.fired = false;
    const unsubscribe = listenRef.current(message => {
      if (message.type !== 'done') return;
      readyRef.current = true;
      setReady(true);
      setLoadTimedOut(false);
      if (r.fired) return;
      r.fired = true;
      r.timer = setTimeout(() => {
        r.timer = null;
        dispatchRef.current({ type: 'refresh' });
      }, rerunDelayMs);
    });
    return () => {
      unsubscribe();
      if (r.timer) clearTimeout(r.timer);
      r.timer = null;
    };
  }, [enabled, rerunDelayMs]);

  // No first `done` in time after the bundler was asked to start: it didn't load.
  useEffect(() => {
    if (!enabled || !started || readyRef.current) return undefined;
    const timer = setTimeout(() => {
      if (!readyRef.current) setLoadTimedOut(true);
    }, loadTimeoutMs);
    return () => clearTimeout(timer);
  }, [enabled, started, loadTimeoutMs]);

  const capture = useCallback(
    async (paths: readonly string[]): Promise<SandboxCapture> => {
      const r = rerun.current;
      r.fired = true;
      if (r.timer) clearTimeout(r.timer);
      r.timer = null;

      // `refresh` reloads the preview and replays the files the client last
      // received, and Sandpack only sends an edit to a client whose status is
      // `done`: an edit made while a run was still going (the display re-run,
      // or a recompile) never reaches the bundler, and a bare refresh would
      // re-run the old code under the new files. So every client's stored
      // setup takes the current files first: the reload's `initialized`
      // (seen by the client, not by `listen`) recompiles from that setup, so
      // the refresh runs exactly what the editor holds, once.
      const { clients, environment } = runtime.current;
      const current = latest.current.files as Record<string, { code: string }>;
      for (const client of Object.values(clients)) {
        client.sandboxSetup = { ...client.sandboxSetup, files: current, template: environment };
      }

      const timedOut = await new Promise<boolean>(resolve => {
        // `run`: waiting for a run's `done`; `tail`: for the lines after it.
        let phase: 'run' | 'tail' = 'run';
        // Only a `done` after a `start` seen here is this run's: a `done`
        // already in flight belongs to an earlier one.
        let runStarted = false;
        let late = false;
        let trailingRuns = 0;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let unsubscribe: (() => void) | null = null;
        const finish = () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          unsubscribe?.();
          resolve(late);
        };
        const wait = (next: 'run' | 'tail') => {
          phase = next;
          if (timer) clearTimeout(timer);
          timer =
            next === 'tail'
              ? setTimeout(finish, tailMs)
              : setTimeout(() => {
                  // The run didn't finish: read what there is after the tail,
                  // without waiting for any later run.
                  late = true;
                  trailingRuns = MAX_TRAILING_RUNS;
                  wait('tail');
                }, runTimeoutMs);
        };
        unsubscribe = listenRef.current(message => {
          if (message.type === 'start') {
            if (phase === 'run') runStarted = true;
            else if (trailingRuns < MAX_TRAILING_RUNS) {
              // A run restarted the preview during the tail: its console is
              // the one to read, once it is done.
              trailingRuns += 1;
              runStarted = true;
              wait('run');
            }
          } else if (message.type === 'done' && phase === 'run' && runStarted) {
            wait('tail');
          }
        });
        wait('run');
        dispatchRef.current({ type: 'refresh' });
      });

      const { files, logs: entries } = latest.current;
      return {
        files: filesAt(files, paths),
        console: consoleLinesOf(entries, limits),
        errors: capturedErrorsOf(error.current, limits),
        timedOut,
      };
    },
    [limits, runTimeoutMs, tailMs]
  );

  const updateFileRef = useRef(sandpack.updateFile);
  updateFileRef.current = sandpack.updateFile;
  /** Replace files (each path → code) in the editor, e.g. a reset to the starter. */
  const updateFiles = useCallback(
    (files: Record<string, string>) => updateFileRef.current(files),
    []
  );

  return {
    capture,
    ready,
    loadFailed: enabled && !ready && (loadTimedOut || sandpack.status === 'timeout'),
    /** The files as Sandpack holds them now (path → `{ code }`), edits included. */
    files: sandpack.files,
    updateFiles,
  };
}
