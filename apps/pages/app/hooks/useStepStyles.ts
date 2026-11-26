import { useEffect, useMemo, useState } from 'react';
import { stepLayout } from '@classmoji/page-schema/sections';

import { stepStylesheet } from '~/utils/stepStyles.ts';

/** The step CSS for a document (the reader's content). */
export function useStepStyles(content: unknown): string {
  return useMemo(() => stepStylesheet(stepLayout(content)), [content]);
}

/** The minimum the hook reads off an editor: its blocks, and a change subscription. */
interface StepEditor {
  document: unknown;
  onChange: (callback: () => void) => unknown;
}

/**
 * The step CSS for a live editor: recomputed on every change, and only
 * stored (so only re-rendered) when the CSS differs, which is almost never
 * while someone types inside a paragraph.
 */
export function useEditorStepStyles(editor: StepEditor): string {
  const [css, setCss] = useState(() => stepStylesheet(stepLayout(editor.document)));
  useEffect(() => {
    const update = () => {
      const next = stepStylesheet(stepLayout(editor.document));
      setCss(previous => (previous === next ? previous : next));
    };
    update();
    const unsubscribe = editor.onChange(update);
    return typeof unsubscribe === 'function' ? (unsubscribe as () => void) : undefined;
  }, [editor]);
  return css;
}
