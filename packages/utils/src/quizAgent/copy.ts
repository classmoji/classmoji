/**
 * The fixed lines a quiz chat agent may send the student on the chat
 * runtime's `error` chunk. The task's sanitizer (packages/tasks,
 * `agents/shared/sanitize.ts`) writes only these; the chat (QuizChat) shows an
 * error only when its text is one of them. Both read this one module, so the
 * two can never drift apart.
 *
 * Copy only: no mechanics, no timing.
 */

/** By failure kind. */
export const QUIZ_FAILURE_COPY = {
  reply_failed: "That reply couldn't be finished. Please send your message again.",
  turn_stopped: "That reply couldn't be finished. Send your message again.",
  refused: "This quiz can't continue right now.",
} as const;

/** By refusal code. A code not listed uses the copy for its kind below. */
export const QUIZ_REFUSAL_COPY: Readonly<Record<string, string>> = {
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
  classroom_locked: 'This class is in read-only mode. The owner has locked it.',
  classroom_unpublished: 'This class has been unpublished by the owner.',
  quiz_unavailable: "This quiz isn't available right now.",
  session_ended: 'Your session has ended.',
  reserved_text: "That message couldn't be sent. Please rephrase it.",
};

/** By refusal kind, for a code not listed above. */
export const QUIZ_REFUSAL_COPY_BY_KIND = {
  temporary: "This quiz isn't available right now. Please try again later.",
  permanent: 'This attempt can no longer be continued.',
} as const;

/** Every line above, each once. */
export const QUIZ_AGENT_ERROR_COPY: readonly string[] = [
  ...new Set([
    ...Object.values(QUIZ_FAILURE_COPY),
    ...Object.values(QUIZ_REFUSAL_COPY),
    ...Object.values(QUIZ_REFUSAL_COPY_BY_KIND),
  ]),
];
