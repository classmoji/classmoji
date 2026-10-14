/**
 * Which code sandbox is open, worked out from the messages alone: the chat
 * has no progress data, and the server must reach the same answer from its
 * own rows. Both run `sandboxProgressOf` / `openSandboxOf`, the same way both
 * use `replyShowsHint`. No server imports: this reaches the client bundle.
 *
 * The rules:
 * - The open question n is the highest number a `present_question` output
 *   shows. It is closed once a result for n that is not a revision exists,
 *   or any evaluation does.
 * - Its candidates, deduped by id in order of first appearance: the card's
 *   sandbox (`q{n}-1`), then each `data-sandbox` for n in an assistant reply
 *   that `replyShowsHint`. Each takes its seed from its last instance, the
 *   one the chat renders live.
 * - A submission stands once the reply to it showed the student something
 *   (`replyStands`). A sandbox is answered when a standing submission names
 *   it; a submission whose reply failed, or has not arrived, leaves it open.
 * - The open sandbox is the latest candidate not answered, or none.
 * - The next attempt is the number of standing submissions for n, plus 1.
 */
import {
  parseSandboxId,
  sandboxId,
  SandboxDataSchema,
  SANDBOX_TEMPLATES,
  type SandboxData,
  type SandboxTemplate,
} from './sandbox.ts';
import { replyShowsHint } from './uiTypes.ts';

/**
 * A message as either side holds it: a UI message (`role` "user" or
 * "assistant") or a stored row (`role` "USER" or "ASSISTANT"); parts as
 * stored JSON. A stored partial reply must be read as `loadCanonicalMessages`
 * keeps it (`partialParts`), or as it is: the rules give the same answer
 * either way (`replyStands`).
 */
export type SandboxMessage = { role: string; parts?: readonly unknown[] | null };

/** One sandbox of the open question. */
export type SandboxCandidate = {
  id: string;
  question_number: number;
  /** The card's sandbox, or a hint sandbox from a Try again reply. */
  source: 'card' | 'hint';
  /** The attempt a submission from it is: 1 for the card's, k for `q{n}-{k}`. */
  attempt: number;
  /** The attempt whose files it was seeded with; null = the starter (the card's). */
  seeded_from: number | null;
  template: SandboxTemplate;
  /** Its seed: the files of its last instance. */
  files: Record<string, string>;
  active_file: string;
  /** Its last instance: the message's index in the list and the part's in the message. */
  at: { message: number; part: number };
  /** A standing submission names it. */
  answered: boolean;
};

/** A submission whose reply showed the student something. */
export type StandingSubmission = {
  sandbox_id: string;
  question_number: number;
  /** Its place among the standing submissions for its question, from 1. */
  attempt: number;
  files: Record<string, string>;
  /** The index of the student's message in the list. */
  message: number;
};

export type SandboxProgress = {
  /** The open question. */
  question_number: number;
  /** Its sandboxes, in order of first appearance. */
  candidates: SandboxCandidate[];
  /** The live sandbox: the latest candidate not answered, or null. */
  open: SandboxCandidate | null;
  /** The standing submissions for the open question, in order. */
  standing: StandingSubmission[];
  /** The attempt the next submission for the open question is. */
  next_attempt: number;
  /**
   * The sandbox a hint reply would carry now: seeded from the last standing
   * submission, with the card's template and opening file. Null when the card
   * has no sandbox or a sandbox is still open.
   */
  next_hint: SandboxData | null;
};

type Part = Record<string, unknown>;

const isObject = (v: unknown): v is Part =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const partsOf = (m: SandboxMessage): Part[] =>
  (Array.isArray(m.parts) ? m.parts : []).filter(isObject);

const roleOf = (m: SandboxMessage) => (typeof m.role === 'string' ? m.role.toLowerCase() : '');

const isStringRecord = (v: unknown): v is Record<string, string> =>
  isObject(v) && Object.values(v).every(x => typeof x === 'string');

/** An `offer_next_step` call the server accepted: the student was shown the buttons. */
const isAcceptedOffer = (p: Part) =>
  p.type === 'tool-offer_next_step' && p.state === 'output-available';

/**
 * Whether a reply to a submission showed the student something: an accepted
 * `offer_next_step` (the feedback and the buttons), or text with no notice
 * (`replyShowsHint`). The accepted call counts with or without a notice: the
 * live message of a turn that failed after it carries both, and the stored
 * row of that turn (`partialParts`) keeps the call and drops the notice, so
 * both sides reach the same answer. Text counts only without a notice, which
 * the stored row matches by dropping a failed turn's text.
 */
export const replyStands = (parts: readonly unknown[]): boolean =>
  parts.some(p => isObject(p) && isAcceptedOffer(p)) || replyShowsHint(parts);

/**
 * The reply to the message at `index`: the next message, when it is the
 * assistant's. A student message right after it means that reply never
 * arrived.
 */
function replyTo(messages: readonly SandboxMessage[], index: number): Part[] | null {
  const next = messages[index + 1];
  return next && roleOf(next) === 'assistant' ? partsOf(next) : null;
}

/** The submission a student message carries, read loosely (stored or optimistic). */
function submissionIn(
  m: SandboxMessage
): { sandbox_id: string; files: Record<string, string> } | null {
  if (roleOf(m) !== 'user') return null;
  for (const p of partsOf(m)) {
    if (p.type !== 'data-code-submission' || !isObject(p.data)) continue;
    const { sandbox_id, files } = p.data;
    if (typeof sandbox_id !== 'string') continue;
    return { sandbox_id, files: isStringRecord(files) ? files : {} };
  }
  return null;
}

/**
 * Every standing submission in the conversation, in order, each numbered
 * among its own question's (the question its sandbox id names). The chat
 * reads it for the "Attempt k submitted" sandboxes of every question.
 */
export function standingSubmissionsOf(messages: readonly SandboxMessage[]): StandingSubmission[] {
  const out: StandingSubmission[] = [];
  const perQuestion = new Map<number, number>();
  messages.forEach((m, i) => {
    const submission = submissionIn(m);
    if (!submission) return;
    const named = parseSandboxId(submission.sandbox_id);
    if (!named) return;
    const reply = replyTo(messages, i);
    if (!reply || !replyStands(reply)) return;
    const attempt = (perQuestion.get(named.question_number) ?? 0) + 1;
    perQuestion.set(named.question_number, attempt);
    out.push({ ...submission, question_number: named.question_number, attempt, message: i });
  });
  return out;
}

/** The highest question number a present_question output shows, or 0. */
function presentedQuestion(messages: readonly SandboxMessage[]): number {
  let n = 0;
  for (const m of messages) {
    for (const p of partsOf(m)) {
      if (p.type !== 'tool-present_question' || p.state !== 'output-available') continue;
      const number = isObject(p.output) ? p.output.question_number : undefined;
      if (typeof number === 'number' && Number.isInteger(number) && number > n) n = number;
    }
  }
  return n;
}

/** A result for n that is not a revision, or any evaluation, closes question n. */
function isClosed(messages: readonly SandboxMessage[], n: number): boolean {
  return messages.some(m =>
    partsOf(m).some(
      p =>
        (p.type === 'data-question-result' &&
          isObject(p.data) &&
          p.data.question_num === n &&
          p.data.revised !== true) ||
        p.type === 'data-evaluation' ||
        (p.type === 'tool-submit_quiz_evaluation' && p.state === 'output-available')
    )
  );
}

const TEMPLATES: readonly string[] = SANDBOX_TEMPLATES;

/** The card's sandbox in a present_question output for question n, read loosely. */
function cardSandboxIn(p: Part, n: number) {
  if (p.type !== 'tool-present_question' || p.state !== 'output-available') return null;
  if (!isObject(p.output) || p.output.question_number !== n) return null;
  const card = p.output.card;
  const sandbox = isObject(card) ? card.sandbox : undefined;
  if (!isObject(sandbox)) return null;
  const { template, files, active_file } = sandbox;
  if (typeof template !== 'string' || !TEMPLATES.includes(template)) return null;
  if (!isStringRecord(files) || typeof active_file !== 'string') return null;
  return { template: template as SandboxTemplate, files, active_file };
}

/** A hint sandbox for question n, its id the server's own derivation. */
function hintSandboxIn(p: Part, n: number): SandboxData | null {
  if (p.type !== 'data-sandbox') return null;
  const parsed = SandboxDataSchema.safeParse(p.data);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (data.question_number !== n || data.id !== sandboxId(n, data.attempt)) return null;
  return data;
}

/**
 * The open question's sandboxes and submissions, or null when no question is
 * open (none presented yet, or the last one closed). See the header for the
 * rules.
 */
export function sandboxProgressOf(messages: readonly SandboxMessage[]): SandboxProgress | null {
  const n = presentedQuestion(messages);
  if (n === 0 || isClosed(messages, n)) return null;

  // First appearance fixes the order (a Map keeps its first insertion's
  // place); each later instance replaces the seed and the location.
  const seen = new Map<string, Omit<SandboxCandidate, 'answered'>>();
  messages.forEach((m, mi) => {
    const assistant = roleOf(m) === 'assistant';
    const parts = partsOf(m);
    const showsHint = assistant && replyShowsHint(parts);
    parts.forEach((p, pi) => {
      const card = cardSandboxIn(p, n);
      if (card) {
        const id = sandboxId(n, 1);
        seen.set(id, {
          id,
          question_number: n,
          source: 'card',
          attempt: 1,
          seeded_from: null,
          ...card,
          at: { message: mi, part: pi },
        });
        return;
      }
      if (!showsHint) return;
      const hint = hintSandboxIn(p, n);
      if (hint) {
        seen.set(hint.id, {
          id: hint.id,
          question_number: n,
          source: 'hint',
          attempt: hint.attempt,
          seeded_from: hint.seeded_from,
          template: hint.template,
          files: hint.files,
          active_file: hint.active_file,
          at: { message: mi, part: pi },
        });
      }
    });
  });

  const allStanding = standingSubmissionsOf(messages);
  const answeredIds = new Set(allStanding.map(s => s.sandbox_id));
  const standing = allStanding.filter(s => s.question_number === n);
  const candidates = [...seen.values()].map(c => ({ ...c, answered: answeredIds.has(c.id) }));
  const open = [...candidates].reverse().find(c => !c.answered) ?? null;
  const next_attempt = standing.length + 1;

  const card = candidates.find(c => c.source === 'card');
  const last = standing.at(-1);
  const next_hint: SandboxData | null =
    card && !open && next_attempt >= 2
      ? {
          id: sandboxId(n, next_attempt),
          question_number: n,
          attempt: next_attempt,
          seeded_from: last ? last.attempt : null,
          template: card.template,
          files: last ? last.files : card.files,
          active_file: card.active_file,
        }
      : null;

  return { question_number: n, candidates, open, standing, next_attempt, next_hint };
}

/** The live sandbox, or null: `sandboxProgressOf(messages)?.open`. */
export const openSandboxOf = (messages: readonly SandboxMessage[]): SandboxCandidate | null =>
  sandboxProgressOf(messages)?.open ?? null;
