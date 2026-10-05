import { useEffect } from 'react';

import { ensureBlockIds, topLevelBlocks } from './slideBlocks';

/** Input that brings in markup from elsewhere (it can carry copied block ids). */
const INSERTS_MARKUP = new Set(['insertFromPaste', 'insertFromDrop', 'insertFromPasteAsQuotation']);

function slideOf(target: EventTarget | null): Element | null {
  const el =
    target instanceof Element ? target : ((target as Node | null)?.parentElement ?? null);
  const section = el?.closest('section') ?? null;
  return section && section.closest('.reveal .slides') ? section : null;
}

/**
 * While editing: every block on a slide being edited has its own
 * `data-cm-block-id`. A paste or drop that brings in a copy of a block gets
 * a fresh id for the copy (the original keeps its own); a block without an
 * id gets one the next time its slide is edited, so block edits by id
 * (agents' block_update) can reach it. Only the slide being edited is
 * touched.
 */
export function useBlockIdGuard(): void {
  useEffect(() => {
    let pending: { section: Element; before: Set<Element> } | null = null;

    const onBeforeInput = (event: Event) => {
      const { inputType } = event as InputEvent;
      if (!INSERTS_MARKUP.has(inputType)) return;
      const section = slideOf(event.target);
      pending = section ? { section, before: new Set(topLevelBlocks(section)) } : null;
    };

    const onInput = (event: Event) => {
      const section = slideOf(event.target);
      if (!section) return;
      let fresh: Set<Element> = new Set();
      if (pending && pending.section === section) {
        const before = pending.before;
        fresh = new Set(topLevelBlocks(section).filter(block => !before.has(block)));
      }
      pending = null;
      ensureBlockIds(section, fresh);
    };

    document.addEventListener('beforeinput', onBeforeInput, true);
    document.addEventListener('input', onInput, true);
    return () => {
      document.removeEventListener('beforeinput', onBeforeInput, true);
      document.removeEventListener('input', onInput, true);
    };
  }, []);
}
