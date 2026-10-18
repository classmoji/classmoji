/**
 * "Knows what you have open": the hooks route components call, and the chip
 * label. Called inside a route's default component, so every role prefix
 * that re-exports it publishes the same thing.
 *
 *   useAskMojiViewing(v)  publishes `v` while the component is mounted (the
 *                         latest publisher wins; a cleanup clears only its
 *                         own value). `title` is for the chip only; the
 *                         message carries kind, id and slide, which the
 *                         server resolves and checks.
 *   useHideAskMoji(hide)  hides the sidebar button and the panel while
 *                         mounted with `hide` true (a live quiz attempt).
 */
import { useEffect, useId } from 'react';
import useStore from '~/store';
import type { AskMojiViewingState } from '~/types';

export type AskMojiViewingInput = Omit<AskMojiViewingState, 'owner'>;

export function useAskMojiViewing(viewing: AskMojiViewingInput | null | undefined) {
  const owner = useId();
  const setViewing = useStore(s => s.setAskMojiViewing);
  const kind = viewing?.kind;
  const id = viewing?.id;
  const slide = viewing?.slide;
  const title = viewing?.title;

  useEffect(() => {
    if (!kind) return undefined;
    setViewing({
      kind,
      ...(id ? { id } : {}),
      ...(typeof slide === 'number' ? { slide } : {}),
      ...(title ? { title } : {}),
      owner,
    });
    return () => {
      if (useStore.getState().askMojiViewing?.owner === owner) setViewing(null);
    };
  }, [kind, id, slide, title, owner, setViewing]);
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
