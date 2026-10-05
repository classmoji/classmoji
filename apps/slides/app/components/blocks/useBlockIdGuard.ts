import { useEffect } from 'react';

import { ensureBlockIds, topLevelBlocks } from './slideBlocks';

/** Input that brings in markup from elsewhere (it can carry copied block ids). */
const INSERTS_MARKUP = new Set(['insertFromPaste', 'insertFromDrop', 'insertFromPasteAsQuotation']);

function slideOf(target: EventTarget | null): Element | null {
  const el = target instanceof Element ? target : ((target as Node | null)?.parentElement ?? null);
  const section = el?.closest('section') ?? null;
  return section && section.closest('.reveal .slides') ? section : null;
}

/**
 * While editing: a paste or drop that brings a copy of a block onto a slide
 * gives the copy its own `data-cm-block-id` (the original keeps its own), so
 * block edits by id (agents' block_update) reach one block. Only the slide
 * pasted into is touched; blocks without an id are left to the server.
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
      const current = pending;
      pending = null;
      if (!current || !INSERTS_MARKUP.has((event as InputEvent).inputType)) return;
      const section = slideOf(event.target);
      if (section !== current.section) return;
      const fresh = topLevelBlocks(section).filter(block => !current.before.has(block));
      if (fresh.length > 0) ensureBlockIds(section, new Set(fresh));
    };

    document.addEventListener('beforeinput', onBeforeInput, true);
    document.addEventListener('input', onInput, true);
    return () => {
      document.removeEventListener('beforeinput', onBeforeInput, true);
      document.removeEventListener('input', onInput, true);
    };
  }, []);
}
