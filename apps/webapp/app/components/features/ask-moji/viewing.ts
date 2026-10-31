/**
 * "Knows what you have open": the hooks route components call, and the chip
 * label. Called inside a route's default component, so every role prefix
 * that re-exports it publishes the same thing.
 *
 *   useAskMojiViewing(v)  publishes `v` while the component is mounted. The
 *                         publishers form a stack: the one rendered last is
 *                         on top (a drawer over its page), and unmounting one
 *                         uncovers the one below instead of clearing. `title`
 *                         is for the chip only; the message carries kind, id
 *                         and slide, which the server resolves and checks.
 *   useHideAskMoji(hide)  hides the sidebar button and the panel while
 *                         mounted with `hide` true (a live quiz attempt).
 */
import { useEffect, useId, useState } from 'react';
import useStore from '~/store';
import type { AskMojiViewingState } from '~/types';

export type AskMojiViewingInput = Omit<AskMojiViewingState, 'owner' | 'seq'>;

/**
 * Render order, taken once per publisher. Effects run child first, so a page
 * and the drawer inside it mounting together would put the page on top if the
 * stack went by effect order; render order puts the drawer there.
 */
let renderSeq = 0;

export function useAskMojiViewing(viewing: AskMojiViewingInput | null | undefined) {
  const owner = useId();
  const [seq] = useState(() => ++renderSeq);
  const publish = useStore(s => s.publishAskMojiViewing);
  const withdraw = useStore(s => s.withdrawAskMojiViewing);
  const kind = viewing?.kind;
  const id = viewing?.id;
  const slide = viewing?.slide;
  const title = viewing?.title;

  useEffect(() => {
    if (!kind) return undefined;
    publish({
      kind,
      ...(id ? { id } : {}),
      ...(typeof slide === 'number' ? { slide } : {}),
      ...(title ? { title } : {}),
      owner,
      seq,
    });
    return () => withdraw(owner);
  }, [kind, id, slide, title, owner, seq, publish, withdraw]);
}

export function useHideAskMoji(hide = true) {
  const add = useStore(s => s.addAskMojiHide);
  const remove = useStore(s => s.removeAskMojiHide);
  useEffect(() => {
    if (!hide) return undefined;
    add();
    return () => remove();
  }, [hide, add, remove]);
}

/**
 * A quiz attempt drawer: Ask Moji is hidden while the viewer takes their own
 * live attempt (no server refusal; the server refuses `viewing: quiz` for an
 * attempt the user has open anyway). A completed attempt shows the quiz as
 * what is open. Staff reading a student's live attempt get neither.
 */
export function useAskMojiAttempt({
  quizId,
  quizName,
  readOnly,
  viewerOwnsAttempt,
}: {
  quizId: string | null | undefined;
  quizName?: string | null;
  readOnly: boolean;
  viewerOwnsAttempt: boolean;
}) {
  useHideAskMoji(!readOnly && viewerOwnsAttempt);
  useAskMojiViewing(
    readOnly && quizId
      ? { kind: 'quiz', id: quizId, ...(quizName ? { title: quizName } : {}) }
      : null
  );
}

const KIND_LABELS: Record<AskMojiViewingState['kind'], string> = {
  page: 'this page',
  deck: 'these slides',
  module: 'this module',
  assignment: 'this assignment',
  quiz: 'this quiz',
  calendar: 'the calendar',
};

/** The chip's text: the title the route knows, else a label for the kind; a deck adds its slide. */
export function viewingLabel(v: {
  kind: AskMojiViewingState['kind'];
  title?: string | null;
  slide?: number | null;
}): string {
  const base = v.title?.trim() || KIND_LABELS[v.kind] || 'this';
  return v.kind === 'deck' && typeof v.slide === 'number' ? `${base}, slide ${v.slide + 1}` : base;
}
