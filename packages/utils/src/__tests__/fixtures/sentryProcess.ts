/**
 * A child process for sentryNode.process.test.ts: `node sentryProcess.ts <mode>`.
 *
 * Process-level behaviour (listeners, exit codes, console output, module
 * hooks) cannot be checked inside a vitest worker, which has listeners of its
 * own and may not be the main thread. Each mode prints exactly one JSON line
 * on stdout (its findings) unless it is about to crash on purpose; the test
 * reads stdout, stderr and the exit code.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';

const DSN = 'https://public@o0.ingest.sentry.io/0';
const mode = process.argv[2];
const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

// Watch for module hooks BEFORE the SDK loads: patch the CommonJS `module`
// object and sync the ESM namespace the SDK imports.
const require = createRequire(import.meta.url);
const nodeModule = require('node:module') as {
  register?: (...args: unknown[]) => unknown;
  registerHooks?: (...args: unknown[]) => unknown;
};
const hookCalls: string[] = [];
for (const name of ['register', 'registerHooks'] as const) {
  const original = nodeModule[name];
  if (typeof original !== 'function') continue;
  nodeModule[name] = (...args: unknown[]) => {
    hookCalls.push(name);
    return original.apply(nodeModule, args);
  };
}
syncBuiltinESMExports();

const listeners = () => ({
  uncaughtException: process.listenerCount('uncaughtException'),
  unhandledRejection: process.listenerCount('unhandledRejection'),
});

const events: unknown[] = [];
const transport = () => ({
  send: async (envelope: [unknown, Array<[{ type: string }, unknown]>]) => {
    for (const [header] of envelope[1]) if (header.type === 'event') events.push(header.type);
    return {};
  },
  flush: async () => true,
});

const before = listeners();
const { initServerSentry } = await import('../../sentryNode.ts');
const { flushErrorReports, hasErrorReporter, reportError } = await import('../../errorReport.ts');
const Sentry = await import('@sentry/node');

const on = () => initServerSentry('collab', { SENTRY_DSN: DSN }, { transport: transport as never });

switch (mode) {
  case 'off': {
    const enabled = initServerSentry('collab', {});
    print({
      enabled,
      again: initServerSentry('collab', { SENTRY_DSN: DSN }),
      before,
      after: listeners(),
      reporter: hasErrorReporter(),
      client: Sentry.getClient() !== undefined,
      hookCalls,
    });
    break;
  }

  case 'on': {
    const enabled = on();
    const integrations = (Sentry.getClient()?.getOptions().integrations ?? []).map(i => i.name);
    let otelInstrumentationInstalled = true;
    try {
      require.resolve('@opentelemetry/instrumentation');
    } catch {
      otelInstrumentationInstalled = false;
    }
    reportError(new Error('handled and reported'), { surface: 'test.choke_point' });
    await flushErrorReports(2000);
    print({
      enabled,
      again: on(),
      before,
      after: listeners(),
      reporter: hasErrorReporter(),
      hookCalls,
      orchestrion: (globalThis as { __SENTRY_ORCHESTRION__?: { runtime?: unknown } })
        .__SENTRY_ORCHESTRION__?.runtime ?? null,
      otelInstrumentationInstalled,
      integrations,
      events: events.length,
    });
    break;
  }

  // Control for the hook spy: the SDK's default (channel injection on) DOES register hooks.
  case 'control-injection': {
    Sentry.init({ dsn: DSN, transport: transport as never, defaultIntegrations: false });
    print({ hookCalls });
    break;
  }

  // Like @classmoji/database: report, flush, exit with a code of its own.
  case 'uncaught-with-listener': {
    on();
    process.on('uncaughtException', error => {
      reportError(error, { surface: 'process.uncaught_exception', level: 'fatal', handled: false });
      void flushErrorReports(2000).then(() => {
        print({ events: events.length });
        process.exit(3);
      });
    });
    setTimeout(() => {
      throw new Error('uncaught boom');
    }, 0);
    break;
  }

  // Like apps/mcp: log and keep serving.
  case 'rejection-keeps-serving': {
    on();
    process.on('unhandledRejection', () => {});
    void Promise.reject(new Error('detached boom'));
    setTimeout(() => {
      void flushErrorReports(2000).then(() => print({ alive: true, events: events.length }));
    }, 100);
    break;
  }

  // Like @classmoji/database: report, flush, exit 1. argv[3] picks the reason:
  // an Error (default), a plain object or a string.
  case 'rejection-with-exiting-listener': {
    on();
    const kind = process.argv[3] ?? 'error';
    const reason =
      kind === 'object'
        ? { marker: 'OBJECTMARKER' }
        : kind === 'string'
          ? 'a rejected string'
          : new Error('detached boom');
    process.on('unhandledRejection', reason => {
      reportError(reason, { surface: 'process.unhandled_rejection', level: 'fatal', handled: false });
      void flushErrorReports(2000).then(() => {
        print({ events: events.length });
        process.exit(1);
      });
    });
    void Promise.reject(reason);
    break;
  }

  // Sentry's listener alone: it exits 1 after flushing, as Node would without it.
  case 'uncaught-alone': {
    on();
    setTimeout(() => {
      throw new Error('uncaught boom');
    }, 0);
    break;
  }

  // Sentry's listener alone on a rejection: crashes as Node's default would
  // (exit 1, the error printed), after flushing the event.
  case 'rejection-alone': {
    on();
    // What was sent by the time the process exits.
    process.on('exit', () => print({ exiting: true, events: events.length }));
    void Promise.reject(new Error('detached boom'));
    setTimeout(() => print({ alive: true, events: events.length }), 2500);
    break;
  }

  // The dev-server order: Sentry first, the app's own listener added later
  // (when the build loads). From then on the app's listener decides.
  case 'rejection-listener-added-later': {
    on();
    process.on('unhandledRejection', () => {});
    void Promise.reject(new Error('detached boom'));
    setTimeout(() => {
      void flushErrorReports(2000).then(() => print({ alive: true, events: events.length }));
    }, 100);
    break;
  }

  default:
    throw new Error(`unknown mode ${mode}`);
}
