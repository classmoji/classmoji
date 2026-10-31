/**
 * The per-attempt message limit of a quiz on the chat runtime, shared by the
 * server that enforces it (quizChat.service) and the screens that state it
 * (the quiz form, the chat, the MCP quiz tools), and the size caps of a
 * student message and of a code sandbox. Numbers only.
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
 * The longest typed student message, in characters. The task's admission
 * (`classifyIncoming`) and the services (`MAX_STUDENT_MESSAGE_CHARS`) each
 * state it today; this is the one copy both are to read.
 */
export const MAX_MESSAGE_CHARS = 10_000;

/**
 * Code sandbox questions (`sandbox.ts`). The starter files the agent attaches
 * to a question (`SandboxSpecSchema`): at most this many files, each and in
 * all at most this many characters. Checked when the card is presented.
 */
export const MAX_SANDBOX_FILES = 5;
export const MAX_SANDBOX_FILE_CHARS = 6_000;
export const MAX_SANDBOX_TOTAL_CHARS = 15_000;

/**
 * A student's code submission (`CodeSubmissionInputSchema`): the files, each
 * and in all, and the console lines it reports. Room for the student to grow
 * the starter; far under what one chat input record may carry.
 */
export const MAX_SUBMISSION_FILE_CHARS = 10_000;
export const MAX_SUBMISSION_TOTAL_CHARS = 30_000;
export const MAX_CONSOLE_LINES = 50;
export const MAX_CONSOLE_LINE_CHARS = 300;
