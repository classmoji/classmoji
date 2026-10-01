/**
 * The per-attempt message limit of a quiz on the chat runtime, shared by the
 * server that enforces it (quizChat.service), the screens that state it
 * (the quiz form, the chat, the MCP quiz tools) and the quiz agent's run
 * (packages/tasks). Numbers only.
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

/**
 * The most turns one run of the quiz agent takes (the chat agent's
 * `maxTurns`). The SDK reads the next message before it checks this limit
 * and ends the run without answering it, so one attempt must never reach it.
 * Each message or action the run reads takes a turn, a refused one included.
 * An attempt's admitted path takes 202 at 200: the begin turn,
 * `MAX_STUDENT_TURNS` admitted messages and the one refused at the limit,
 * which closes the session. A message refused for now (sent too soon, say)
 * or delivered again also takes a turn and is not counted against the
 * limit; this leaves room for about 800 of those in one run.
 */
export const QUIZ_RUN_MAX_TURNS = 1_000;
