/**
 * Which slides a preview adds or changes, for the rendered preview's
 * highlight (no diff view: the reviewer sees the deck as it would be, with
 * the touched slides marked). Pure; browser- and server-safe.
 */
import type { DeckJson, DeckSlide } from '@classmoji/services/slides';

function flatten(deck: DeckJson): Map<string, DeckSlide> {
  const out = new Map<string, DeckSlide>();
  for (const slide of deck.slides) {
    out.set(slide.id, slide);
    for (const child of slide.children ?? []) out.set(child.id, child);
  }
  return out;
}

function signature(slide: DeckSlide): string {
  return JSON.stringify({
    html: slide.children ? null : (slide.html ?? ''),
    notes: slide.notes ?? null,
    hidden: Boolean(slide.hidden),
    attrs: Object.entries(slide.attrs ?? {}).sort(),
  });
}

/** Ids in `preview` that are new, or whose html/notes/visibility/attributes differ. */
export function changedSlideIds(reference: DeckJson, preview: DeckJson): string[] {
  const before = flatten(reference);
  const out: string[] = [];
  for (const [id, slide] of flatten(preview)) {
    const prev = before.get(id);
    if (!prev || signature(prev) !== signature(slide)) out.push(id);
  }
  return out;
}

/** The class the preview view puts on a changed slide's section. */
export const PREVIEW_CHANGED_CLASS = 'cm-preview-changed';
