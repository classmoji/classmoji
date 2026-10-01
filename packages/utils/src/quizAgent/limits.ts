/**
 * The per-attempt message limit of a quiz on the chat runtime, shared by the
 * server that enforces it (quizChat.service) and the screens that state it
 * (the quiz form, the chat, the MCP quiz tools). Numbers only.
 */

/**
 * The most student messages (button clicks included) one attempt admits: a
 * safety net far above what any quiz takes, not a budget a student works
 * within. The turn that answers the last of them submits the attempt as it
 * ends, from the results recorded so far, every other question counted as
 * skipped. A message after it is refused for good (`turn_limit`).
 */
export const MAX_STUDENT_TURNS = 200;

/** The chat shows how many messages are left once this many or fewer remain. */
export const MESSAGES_LEFT_NOTICE_AT = 20;
