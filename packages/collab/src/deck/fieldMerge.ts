/**
 * A per-field 3-way merge of ONE slide both sides changed: html, notes and
 * visibility each take the side that changed them, attributes merge per key.
 * Where both sides changed the same field, `prefer` wins that field.
 */
import type { DeckSlide } from '@classmoji/services/slides';

type Side = 'ours' | 'theirs';

function pick<T>(base: T, ours: T, theirs: T, prefer: Side, same: (a: T, b: T) => boolean): T {
  if (same(ours, theirs)) return ours;
  if (same(ours, base)) return theirs;
  if (same(theirs, base)) return ours;
  return prefer === 'ours' ? ours : theirs;
}

const eq = <T>(a: T, b: T) => a === b;

export function mergeSlideFields(
  base: DeckSlide | undefined,
  ours: DeckSlide,
  theirs: DeckSlide,
  prefer: Side = 'theirs'
): DeckSlide {
  const b: Partial<DeckSlide> = base ?? {};
  const out: DeckSlide = { ...(prefer === 'ours' ? ours : theirs) };
  if (ours.children === undefined && theirs.children === undefined) {
    out.html = pick(b.html, ours.html, theirs.html, prefer, eq);
  }
  const notes = pick(b.notes, ours.notes, theirs.notes, prefer, eq);
  if (notes === undefined) delete out.notes;
  else out.notes = notes;
  const hidden = pick(Boolean(b.hidden), Boolean(ours.hidden), Boolean(theirs.hidden), prefer, eq);
  if (hidden) out.hidden = true;
  else delete out.hidden;

  const keys = new Set([
    ...Object.keys(b.attrs ?? {}),
    ...Object.keys(ours.attrs ?? {}),
    ...Object.keys(theirs.attrs ?? {}),
  ]);
  const attrs: Record<string, string> = {};
  // Ours' key order first, then any new keys from theirs.
  const ordered = [
    ...Object.keys(ours.attrs ?? {}),
    ...[...keys].filter(k => !(k in (ours.attrs ?? {}))),
  ];
  for (const key of ordered) {
    const value = pick(b.attrs?.[key], ours.attrs?.[key], theirs.attrs?.[key], prefer, eq);
    if (value !== undefined) attrs[key] = value;
  }
  if (Object.keys(attrs).length > 0) out.attrs = attrs;
  else delete out.attrs;
  return out;
}
