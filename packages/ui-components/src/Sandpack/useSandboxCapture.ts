/**
 * useSandboxCapture: reads what a running code sandbox did, for a submission.
 * Use it inside the sandbox's SandpackProvider (SandpackEmbed's `children`).
 *
 * The rules come from the quiz mockup, proven against live Sandpack
 * (plans/2026-10-12-quiz-sandbox/mockup.html):
 * - `ready` turns true on the bundler's first `done` and stays true. Sandpack
 *   reports `status: 'running'` before it has booted, so the status alone
 *   can't say the code ran.
 * - Sandpack drops the first run's console on about half of cold starts, so
 *   the sandbox runs once more about 800 ms after its first `done`, for the
 *   console the student sees. Capture never relies on that run.
 * - `capture` always runs the code again: it cancels a pending display re-run
 *   (which would restart the preview mid-capture and wipe its console),
 *   refreshes, waits for `done` (8 s, then reports `timedOut`), then waits
 *   about 600 ms for console lines that trail `done`, and reads the files,
 *   the console and the error (cleaned: `sandboxCapture.ts`).
 * - `loadFailed`: no `done` within 30 s of the preview mounting, or Sandpack's
 *   own bundler timeout. A school network that blocks the bundler's host
 *   looks like this. A later `done` clears it.
 *
 * `enabled` is whether a preview is mounted: without one no bundler runs, so
 * the re-run and the load timer are not armed.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSandpack, useSandpackConsole } from '@codesandbox/sandpack-react';
import {
  DEFAULT_CAPTURE_LIMITS,
  capturedErrorsOf,
  consoleLinesOf,
  filesAt,
  type CaptureLimits,
  type CapturedConsoleLine,
  type CapturedError,
  type SandpackConsoleEntry,
  type SandpackErrorLike,
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

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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
    error: sandpack.error as SandpackErrorLike | null,
    logs: logs as ReadonlyArray<SandpackConsoleEntry>,
  });
  latest.current = {
    files: sandpack.files,
    error: sandpack.error,
    logs,
  };
  // The bundler clients and the files to hand them, for a capture that must
  // run what the editor holds (see `capture`).
  const runtime = useRef({ clients: sandpack.clients, environment: sandpack.environment });
  runtime.current = { clients: sandpack.clients, environment: sandpack.environment };
  const listenRef = useRef(listen);
  listenRef.current = listen;
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const [ready, setReady] = useState(false);
  const [loadTimedOut, setLoadTimedOut] = useState(false);
  const readyRef = useRef(false);

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

  // No first `done` in time: the bundler didn't load.
  useEffect(() => {
    if (!enabled || readyRef.current) return undefined;
    const timer = setTimeout(() => {
      if (!readyRef.current) setLoadTimedOut(true);
    }, loadTimeoutMs);
    return () => clearTimeout(timer);
  }, [enabled, loadTimeoutMs]);

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

      const outcome = await new Promise<'done' | 'timeout'>(resolve => {
        let settled = false;
        let unsubscribe: (() => void) | null = null;
        // Only a `done` after a `start` seen here is this run's: a `done`
        // already in flight belongs to an earlier one.
        let started = false;
        const finish = (how: 'done' | 'timeout') => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe?.();
          resolve(how);
        };
        const timer = setTimeout(() => finish('timeout'), runTimeoutMs);
        unsubscribe = listenRef.current(message => {
          if (message.type === 'start') started = true;
          else if (message.type === 'done' && started) finish('done');
        });
        dispatchRef.current({ type: 'refresh' });
      });
      await sleep(tailMs);

      const { files, error, logs: entries } = latest.current;
      return {
        files: filesAt(files, paths),
        console: consoleLinesOf(entries, limits),
        errors: capturedErrorsOf(error, limits),
        timedOut: outcome === 'timeout',
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
