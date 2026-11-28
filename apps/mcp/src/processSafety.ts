/**
 * Process-level safety nets (S5: "never a crashed process").
 *
 * A detached promise rejection would, under Node 24's default
 * unhandledRejection policy, terminate the process. These handlers keep the
 * resource server serving on a stray rejection and exit cleanly (after a
 * best-effort close) only on a truly uncaught exception, where process state
 * may be corrupt.
 *
 * Both also hand the error to the process's error reporter (`reportError`,
 * Sentry when the server started it; nothing otherwise): a rejection as
 * level 'error' (the server keeps serving), an uncaught exception as 'fatal'
 * before `onFatal`, which flushes the report before exiting.
 *
 * The handlers are exported and the event target is injectable so the behavior
 * can be unit-tested without touching the real process (§F2 test).
 */
import { reportError } from '@classmoji/utils/error-report';

/** Minimal logger surface both Pino (Fastify's default) and test fakes satisfy. */
interface SafetyLogger {
  error: (obj: unknown, msg?: string) => void;
  fatal: (obj: unknown, msg?: string) => void;
}

/** Log a stray detached rejection and KEEP SERVING (S5). */
export function logUnhandledRejection(logger: SafetyLogger, reason: unknown): void {
  logger.error(
    {
      err: reason instanceof Error ? reason : new Error(String(reason)),
      tag: 'unhandledRejection',
    },
    '[mcp] unhandled promise rejection — continuing to serve'
  );
}

/** Log an uncaught exception (the caller then exits after a best-effort close). */
export function logUncaughtException(logger: SafetyLogger, error: Error): void {
  logger.fatal({ err: error, tag: 'uncaughtException' }, '[mcp] uncaught exception — exiting');
}

interface SafetyNetOptions {
  /** Invoked (with code 1) after an uncaught exception is logged. */
  onFatal?: (code: number) => void;
  /** Event target — defaults to `process`; injectable for tests. */
  target?: NodeJS.EventEmitter;
}

// eslint-disable-next-line no-process-exit
const defaultOnFatal = (code: number): void => process.exit(code);

/**
 * Register the process safety nets. Call once at bootstrap.
 *   - unhandledRejection: log and keep serving (a detached rejection must not
 *     take the server down).
 *   - uncaughtException: log, then hand off to `onFatal` to exit(1) after a
 *     best-effort close, since state may be corrupt (standard practice).
 */
export function registerProcessSafetyNets(
  logger: SafetyLogger,
  { onFatal = defaultOnFatal, target = process }: SafetyNetOptions = {}
): void {
  target.on('unhandledRejection', (reason: unknown) => {
    logUnhandledRejection(logger, reason);
    reportError(reason, { surface: 'process.unhandled_rejection', level: 'error', handled: false });
  });
  target.on('uncaughtException', (error: Error) => {
    logUncaughtException(logger, error);
    reportError(error, { surface: 'process.uncaught_exception', level: 'fatal', handled: false });
    onFatal(1);
  });
}
