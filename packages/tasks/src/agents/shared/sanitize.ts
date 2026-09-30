/**
 * Error sanitizer for chat agents.
 *
 * The chat runtime writes an error thrown by any of its callbacks (storage
 * `load` / `loadContext` / `save`, `onAction`, `run`, the turn hooks, tool
 * executes) to the session's output stream as `{ type: 'error', errorText:
 * error.message }`, word for word, and logs `error.message` itself for
 * storage failures. A Prisma or provider error message can carry query
 * fragments, row values or request text, so no raw message may reach either.
 *
 * `sanitized()` wraps a callback: it catches, logs a private diagnostic (the
 * callback's label, the error's class name and code, the chat and run ids,
 * and a correlation id; never the error message and never student text), and
 * rethrows a `QuizTurnError` whose message is fixed copy chosen by kind.
 */

/** What the student is told, by failure kind. Fixed copy, no mechanics. */
export const FIXED_COPY = {
  reply_failed: "That reply couldn't be finished. Please send your message again.",
  turn_stopped: "That reply couldn't be finished. Send your message again.",
  refused: "This quiz can't continue right now.",
} as const;

export type FailureKind = keyof typeof FIXED_COPY;

/**
 * Copy for a refusal, by the refusal's code. Codes not listed fall back to
 * the copy for their kind: a temporary refusal may clear on its own, a
 * permanent one ends the attempt's chat.
 */
const REFUSAL_COPY: Record<string, string> = {
  quizzes_unavailable: "Quizzes aren't available in this class.",
  attempt_completed: 'This quiz is already complete.',
  attempt_expired: 'This attempt can no longer be continued.',
  attempt_not_found: 'This attempt can no longer be continued.',
  wrong_runtime: 'This attempt can no longer be continued.',
  not_a_member: 'This attempt can no longer be continued.',
  turn_limit: 'This attempt has reached its message limit.',
  invalid_message: "That message couldn't be sent. Please try again.",
  message_conflict: "That message couldn't be sent. Please try again.",
  invalid_input: "That message couldn't be sent. Please try again.",
  invalid_trigger: "That message couldn't be sent. Please try again.",
  already_started: 'This quiz has already started.',
};

const REFUSAL_COPY_BY_KIND = {
  temporary: "This quiz isn't available right now. Please try again later.",
  permanent: 'This attempt can no longer be continued.',
} as const;

/** The error every sanitized callback throws. Its message is always fixed copy. */
export class QuizTurnError extends Error {
  readonly kind: FailureKind;
  /** A refusal's code, when `kind` is `refused`. */
  readonly code: string | null;
  /** A refusal's permanence, when `kind` is `refused`. */
  readonly refusal: 'temporary' | 'permanent' | null;

  constructor(
    kind: FailureKind,
    opts: { code?: string | null; refusal?: 'temporary' | 'permanent' | null; copy?: string } = {}
  ) {
    super(opts.copy ?? FIXED_COPY[kind]);
    this.name = 'QuizTurnError';
    this.kind = kind;
    this.code = opts.code ?? null;
    this.refusal = opts.refusal ?? null;
  }
}

/** A refusal from the services (`QuizChatRefusal`), recognised by shape. */
export type RefusalLike = Error & { kind: 'temporary' | 'permanent'; code: string };

export function isRefusal(error: unknown): error is RefusalLike {
  if (!(error instanceof Error)) return false;
  const e = error as Partial<RefusalLike>;
  return (e.kind === 'temporary' || e.kind === 'permanent') && typeof e.code === 'string';
}

/** The sanitized error for a refusal: fixed copy by code, else by kind. */
export function refusalError(kind: 'temporary' | 'permanent', code: string): QuizTurnError {
  const copy = REFUSAL_COPY[code] ?? REFUSAL_COPY_BY_KIND[kind];
  return new QuizTurnError('refused', { code, refusal: kind, copy });
}

/** Ids a diagnostic line may carry. Values are checked before they are logged. */
export type DiagnosticIds = { chatId?: string | null; runId?: string | null };

export type DiagnosticLog = (line: string, fields: Record<string, unknown>) => void;

const defaultLog: DiagnosticLog = (line, fields) => console.warn(line, fields);

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_CODE = /^[A-Za-z0-9_.-]{1,40}$/;

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined;
}

function correlationId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * The loggable facts about an error: class name, a short code, an HTTP status.
 * Never `message`, `cause` text, `stack` or response bodies.
 */
export function describeError(error: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (error instanceof Error) {
    const name = error.constructor?.name || error.name;
    if (typeof name === 'string' && SAFE_CODE.test(name)) out.errorClass = name;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && SAFE_CODE.test(code)) out.errorCode = code;
    const status = (error as { statusCode?: unknown; status?: unknown }).statusCode ??
      (error as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isInteger(status)) out.status = status;
    if (error.name === 'AbortError') out.aborted = 1;
  } else {
    out.errorClass = typeof error;
  }
  return out;
}

/** Log a private diagnostic for an error: ids and error facts only. */
export function logDiagnostic(
  label: string,
  error: unknown,
  ids: DiagnosticIds = {},
  log: DiagnosticLog = defaultLog
): string {
  const corr = correlationId();
  const fields: Record<string, string | number> = { corr, ...describeError(error) };
  const chatId = safeId(ids.chatId);
  const runId = safeId(ids.runId);
  if (chatId) fields.chatId = chatId;
  if (runId) fields.runId = runId;
  log(`[quiz-agent] ${SAFE_CODE.test(label) ? label : 'callback'} failed`, fields);
  return corr;
}

/**
 * Convert any error into a `QuizTurnError`. An error that already is one
 * passes through; a service refusal keeps its code and kind; anything else
 * becomes `fallback` (default `reply_failed`) after a diagnostic line.
 */
export function toTurnError(
  label: string,
  error: unknown,
  ids: DiagnosticIds = {},
  opts: { fallback?: FailureKind; log?: DiagnosticLog } = {}
): QuizTurnError {
  if (error instanceof QuizTurnError) return error;
  if (isRefusal(error)) {
    logDiagnostic(label, error, ids, opts.log);
    return refusalError(error.kind, error.code);
  }
  logDiagnostic(label, error, ids, opts.log);
  return new QuizTurnError(opts.fallback ?? 'reply_failed');
}

/**
 * Errors the runtime itself must see unchanged: an out-of-memory error is how
 * it retries the turn on the larger machine, and an abort is how it tells a
 * cancelled run from a failed turn. Neither carries content of ours.
 */
export function isRuntimeControlError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const name = error.constructor?.name || error.name;
  return name === 'OutOfMemoryError' || error.name === 'OutOfMemoryError' || error.name === 'AbortError';
}

/** Pull `chatId` / `runId` out of a callback's arguments, where present. */
function idsFromArgs(args: unknown[]): DiagnosticIds {
  const ids: DiagnosticIds = {};
  for (const arg of args) {
    if (!arg || typeof arg !== 'object') continue;
    const a = arg as { chatId?: unknown; runId?: unknown; ctx?: { run?: { id?: unknown } } };
    if (!ids.chatId && typeof a.chatId === 'string') ids.chatId = a.chatId;
    if (!ids.runId && typeof a.runId === 'string') ids.runId = a.runId;
    if (!ids.runId && typeof a.ctx?.run?.id === 'string') ids.runId = a.ctx.run.id;
  }
  return ids;
}

/**
 * Wrap a callback so whatever it throws leaves as fixed copy.
 *
 * @param label short name for the diagnostic line (e.g. `loadContext`)
 * @param fn the callback
 */
export function sanitized<A extends unknown[], R>(
  label: string,
  fn: (...args: A) => R | Promise<R>,
  opts: { fallback?: FailureKind; log?: DiagnosticLog } = {}
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (isRuntimeControlError(error)) {
        logDiagnostic(label, error, idsFromArgs(args), opts.log);
        throw error;
      }
      throw toTurnError(label, error, idsFromArgs(args), opts);
    }
  };
}
