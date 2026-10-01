/**
 * The per-attempt message limit of a quiz on the chat runtime, shared by the
 * server that enforces it (quizChat.service) and the screens that state it
 * (the quiz form, the chat, the MCP quiz tools). Numbers only.
 */

/**
 * The most student messages (button clicks included) one attempt admits: a
 * safety net far above what any quiz takes, not a budget a student works
 * within. The next one completes the attempt from the results recorded so
 * far, every other question counted as skipped, and is refused for good
 * (`turn_limit`).
 */
export const MAX_STUDENT_TURNS = 200;

/** The chat shows how many messages are left once this many or fewer remain. */
export const MESSAGES_LEFT_NOTICE_AT = 20;
