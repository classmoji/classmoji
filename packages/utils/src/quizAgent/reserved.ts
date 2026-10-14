/**
 * Text only the server may write into a quiz agent's context. The services
 * refuse a student message framed as the server's (quizChat.service
 * `admitStudentMessage`), the task refuses a sandbox starter that is
 * (packages/tasks, agents/quiz/tools), and a code submission is checked on its
 * rendering (`reservedCheckText` in sandbox.ts). One copy of the rule for all
 * three. No server imports: this reaches the client bundle.
 */

/**
 * The framing only the server writes into the model's context (see the quiz
 * agent's `serverNotice.ts`): a line that opens with SYSTEM NOTICE, SERVER
 * NOTICE or CURRENT STATUS (any case, words apart by spaces or tabs) and goes
 * on with ":" or "(" or nothing, and the marker's opening "[[server-notice"
 * anywhere. The words inside a sentence ("the operating system notices…",
 * `setCurrentStatus(`) are ordinary text. The per-attempt marker, not this
 * check, is what tells the model which text is the server's.
 */
const SERVER_HEADING = /^\s*(?:(?:system|server)\s+notice|current\s+status)\s*(?:[:(]|$)/i;
const SERVER_MARKER_OPENING = /\[\[\s*server[\s_-]*notice/i;

/**
 * Line breaks a reader (or the model) may take as the start of a new line.
 * The sandbox renderer splits student text on this same set, so every line
 * the check reads opens with the renderer's prefix.
 */
export const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;

/** Invisible characters: format characters, joiners, variation selectors and fillers. */
// The class lists combining marks (U+034F, the variation selectors) on purpose.
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u3164\uFE00-\uFE0F\uFFA0]/gu;

const framesAsServer = (text: string): boolean =>
  SERVER_MARKER_OPENING.test(text) ||
  text.split(LINE_BREAK).some(line => SERVER_HEADING.test(line));

/**
 * Whether a student's message imitates the server's framing. The text is read
 * in NFKC form, twice: with invisible characters removed (one inside a word)
 * and with each replaced by a space (one standing in for the space between
 * the words).
 */
export const containsReservedText = (text: string): boolean => {
  const normalized = text.normalize('NFKC');
  return (
    framesAsServer(normalized.replace(INVISIBLE, '')) ||
    framesAsServer(normalized.replace(INVISIBLE, ' '))
  );
};
