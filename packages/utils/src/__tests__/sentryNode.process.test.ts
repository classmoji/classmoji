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
    expect(report.after).toEqual({ uncaughtException: 1, unhandledRejection: 1 });
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

  it('CAVEAT: an unhandled rejection with no other listener no longer crashes the process', () => {
    // Node's default would exit 1 here. Every server registers its own
    // listener today (@classmoji/database, apps/mcp); this pins the caveat
    // documented in sentryNode.ts.
    const { code, report } = run('rejection-alone');
    expect(code).toBe(0);
    expect(report).toEqual({ alive: true, events: 1 });
  });
});
