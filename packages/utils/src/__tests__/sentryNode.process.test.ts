/**
 * `initServerSentry` at process level, each case in its own child process
 * (./fixtures/sentryProcess.ts): a vitest worker has crash listeners of its
 * own and may not be the main thread, so listener counts, exit codes and
 * console output can only be observed in a fresh `node`.
 *
 * Proves: (a) no module hooks and no OpenTelemetry instrumentation; (b) exit
 * behaviour is unchanged when the app has its own crash listener; (c) no
 * console output while nothing fails; and that without a DSN nothing at all
 * is registered.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FIXTURE = fileURLToPath(new URL('./fixtures/sentryProcess.ts', import.meta.url));

const run = (mode: string, ...args: string[]) => {
  const result = spawnSync(process.execPath, [FIXTURE, mode, ...args], {
    encoding: 'utf8',
    timeout: 20_000,
    // Nothing from the parent that could turn Sentry or tracing on.
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  });
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    report: lines.length ? JSON.parse(lines[lines.length - 1]) : null,
    lines: lines.length,
  };
};

describe('initServerSentry in a real process', () => {
  it('without a DSN registers nothing: no listeners, no reporter, no client', () => {
    const { code, stderr, report, lines } = run('off');
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(lines).toBe(1);
    expect(report).toEqual({
      enabled: false,
      // Idempotent: the first answer stands.
      again: false,
      before: { uncaughtException: 0, unhandledRejection: 0 },
      after: { uncaughtException: 0, unhandledRejection: 0 },
      reporter: false,
      client: false,
      hookCalls: [],
    });
  });

  it('with a DSN: no module hooks, no OpenTelemetry, no console output', () => {
    const { code, stderr, report, lines } = run('on');
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(lines).toBe(1);
    expect(report.enabled).toBe(true);
    expect(report.again).toBe(true);
    expect(report.reporter).toBe(true);
    expect(report.hookCalls).toEqual([]);
    expect(report.orchestrion).toBeNull();
    expect(report.otelInstrumentationInstalled).toBe(false);
    // Sentry's two: its capture, and the crash-when-alone that keeps Node's default.
    expect(report.after).toEqual({ uncaughtException: 1, unhandledRejection: 2 });
    expect(report.events).toBe(1);
    for (const gone of ['Console', 'ProcessSession', 'LocalVariablesAsync']) {
      expect(report.integrations).not.toContain(gone);
    }
    for (const kept of ['Http', 'NodeFetch', 'OnUncaughtException', 'OnUnhandledRejection']) {
      expect(report.integrations).toContain(kept);
    }
    // Tracing-only integrations are never added.
    for (const tracing of ['Prisma', 'Postgres', 'Anthropic_AI', 'Mcp_Server']) {
      expect(report.integrations).not.toContain(tracing);
    }
  });

  it('control: the hook spy does see the SDK default register module hooks', () => {
    const { report } = run('control-injection');
    expect(report.hookCalls.length).toBeGreaterThan(0);
  });

  it('uncaught exception with the app’s own listener: that listener decides the exit', () => {
    const { code, stderr, report } = run('uncaught-with-listener');
    expect(code).toBe(3);
    expect(stderr).toBe('');
    // Sentry's integration and the listener's reportError: sent once.
    expect(report).toEqual({ events: 1 });
  });

  it('unhandled rejection with a keep-serving listener (mcp): keeps serving, silently', () => {
    const { code, stderr, report } = run('rejection-keeps-serving');
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(report).toEqual({ alive: true, events: 1 });
  });

  it('unhandled rejection with an exiting listener (database): exits 1, sent once', () => {
    const { code, stderr, report } = run('rejection-with-exiting-listener');
    expect(code).toBe(1);
    expect(stderr).toBe('');
    expect(report).toEqual({ events: 1 });
  });

  it('a rejected plain object is sent once too', () => {
    const { code, stderr, report } = run('rejection-with-exiting-listener', 'object');
    expect(code).toBe(1);
    expect(stderr).toBe('');
    expect(report).toEqual({ events: 1 });
  });

  it('a rejected string is sent once per layer (primitives cannot be marked)', () => {
    // Sentry's integration and the listener's reportError: two events. A
    // known, accepted limit; pinned so a change is noticed.
    const { code, report } = run('rejection-with-exiting-listener', 'string');
    expect(code).toBe(1);
    expect(report).toEqual({ events: 2 });
  });

  it('uncaught exception with no other listener: exits 1 and prints it, as Node would', () => {
    const { code, stderr } = run('uncaught-alone');
    expect(code).toBe(1);
    expect(stderr).toContain('uncaught boom');
  });

  it('an unhandled rejection with no other listener crashes as Node would, after sending it', () => {
    // Node's default without listeners: exit 1, the error printed. Sentry's
    // listener (mode 'none') alone would have kept the process alive.
    const { code, stderr, report, lines } = run('rejection-alone');
    expect(code).toBe(1);
    expect(stderr).toContain('detached boom');
    // Never alive again, and the event was sent (once) before it exited.
    expect(lines).toBe(1);
    expect(report).toEqual({ exiting: true, events: 1 });
  });

  it.each(['string', 'object'])(
    'a rejected %s with no other listener crashes as Node would, sent once',
    kind => {
      // Sentry's listener sends the reason; the Error the crash wraps it in
      // carries the SDK's "already captured" mark, so it is not sent again.
      const { code, stderr, report, lines } = run('rejection-alone', kind);
      expect(code).toBe(1);
      expect(stderr).toContain('ERR_UNHANDLED_REJECTION');
      expect(lines).toBe(1);
      expect(report).toEqual({ exiting: true, events: 1 });
    }
  );

  it('once the app adds its own listener (as the dev servers do later), it decides', () => {
    const { code, stderr, report } = run('rejection-listener-added-later');
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(report).toEqual({ alive: true, events: 1 });
  });
});
