/**
 * The code sandboxes of a quiz chat, as the transcript renders them, worked
 * out from the messages alone (the chat has no progress data). Pure: no
 * React.
 *
 * Which sandbox is live is the shared rule's (`sandboxProgressOf` in
 * @classmoji/utils, the one the server's admission runs): never a rule of
 * the chat's own. Everything else here only finds what to draw:
 * - every sandbox's seed by id, from its last instance: a card's sandbox
 *   (`q{n}-1`, from the accepted `present_question` output) and each hint
 *   sandbox (`data-sandbox`) the shared rule would count, that is one in a
 *   reply that `replyShowsHint`, with the server's own id. The rule itself
 *   only looks at the open question; closed questions' sandboxes still render
 *   (frozen) by the same test.
 * - the standing submission naming each id (`standingSubmissionsOf`, across
 *   every question): an answered sandbox shows its submitted files.
 *
 * The messages are the transcript's shown messages with their visible parts
 * (`QuizTranscript`), so the rule's `{ message, part }` positions are the
 * positions the transcript renders at.
 */
import {
  parseSandboxId,
  replyShowsHint,
  sandboxId,
  sandboxProgressOf,
  standingSubmissionsOf,
  type CodeSubmissionData,
  type QuizUIMessage,
  type SandboxData,
  type SandboxProgress,
  type SandboxSpec,
  type SandboxTemplate,
  type StandingSubmission,
} from '@classmoji/utils/quiz-agent';

type QuizPart = QuizUIMessage['parts'][number];

/** A message as the transcript shows it: its role and its visible parts. */
export type ShownMessage = { role: QuizUIMessage['role']; parts: QuizPart[] };

/** One sandbox's seed, from its last instance. */
export interface SandboxSeed {
  id: string;
  question_number: number;
  /** The attempt a submission from it is: 1 for the card's, k for `q{n}-{k}`. */
  attempt: number;
  /** The attempt whose files it holds; null = the card's starter. */
  seeded_from: number | null;
  source: 'card' | 'hint';
  template: SandboxTemplate;
  files: Record<string, string>;
  active_file: string;
}

export interface SandboxView {
  /** The open question's sandboxes, by the shared rule; null when none is open. */
  progress: SandboxProgress | null;
  /** Every sandbox's seed by id. */
  seeds: ReadonlyMap<string, SandboxSeed>;
  /** The standing submission naming each sandbox id. */
  submitted: ReadonlyMap<string, StandingSubmission>;
  /** Every standing submission, in order. */
  standing: readonly StandingSubmission[];
}

/** The sandbox a present_question part's accepted card carries, if any. */
export function cardSandboxOf(part: QuizPart): SandboxSpec | null {
  if (part.type !== 'tool-present_question' || part.state !== 'output-available') return null;
  return part.output.card.sandbox ?? null;
}

/**
 * The hint sandboxes of an assistant message's visible parts that render:
 * those the shared rule would count (a reply that shows a hint, the server's
 * own id), with their index in the parts.
 */
export function hintSandboxesOf(
  parts: readonly QuizPart[]
): { index: number; data: SandboxData }[] {
  if (!replyShowsHint(parts)) return [];
  const out: { index: number; data: SandboxData }[] = [];
  parts.forEach((part, index) => {
    if (part.type !== 'data-sandbox') return;
    const { data } = part;
    if (data.id !== sandboxId(data.question_number, data.attempt)) return;
    out.push({ index, data });
  });
  return out;
}

/** The code submission a student message carries, if any. */
export function submissionOf(parts: readonly QuizPart[]): CodeSubmissionData | null {
  for (const part of parts) {
    if (part.type === 'data-code-submission') return part.data;
  }
  return null;
}

export function sandboxViewOf(messages: readonly ShownMessage[]): SandboxView {
  const seeds = new Map<string, SandboxSeed>();
  messages.forEach(message => {
    if (message.role !== 'assistant') return;
    message.parts.forEach(part => {
      const card = cardSandboxOf(part);
      if (card && part.type === 'tool-present_question' && part.state === 'output-available') {
        const n = part.output.question_number;
        const id = sandboxId(n, 1);
        seeds.set(id, {
          id,
          question_number: n,
          attempt: 1,
          seeded_from: null,
          source: 'card',
          template: card.template,
          files: card.files,
          active_file: card.active_file,
        });
      }
    });
    for (const { data } of hintSandboxesOf(message.parts)) {
      seeds.set(data.id, {
        id: data.id,
        question_number: data.question_number,
        attempt: data.attempt,
        seeded_from: data.seeded_from,
        source: 'hint',
        template: data.template,
        files: data.files,
        active_file: data.active_file,
      });
    }
  });

  const standing = standingSubmissionsOf(messages);
  const submitted = new Map<string, StandingSubmission>();
  for (const s of standing) submitted.set(s.sandbox_id, s);

  return { progress: sandboxProgressOf(messages), seeds, submitted, standing };
}

/** The live sandbox's id when its last instance is the part at `message`/`part`, else null. */
export const isLiveInstance = (
  view: SandboxView,
  id: string,
  message: number,
  part: number
): boolean => {
  const open = view.progress?.open;
  return Boolean(open && open.id === id && open.at.message === message && open.at.part === part);
};

/**
 * The attempt a submission is: the server's, once stored; for the browser's
 * own copy (no reply yet), the standing submissions for its question before
 * it, plus one, the way the server numbers it.
 */
export function submissionAttempt(
  view: SandboxView,
  message: number,
  data: CodeSubmissionData
): number {
  if (typeof data.attempt === 'number') return data.attempt;
  const question = data.question_number ?? parseSandboxId(data.sandbox_id)?.question_number;
  const before = view.standing.filter(
    s => s.question_number === question && s.message < message
  ).length;
  return before + 1;
}
