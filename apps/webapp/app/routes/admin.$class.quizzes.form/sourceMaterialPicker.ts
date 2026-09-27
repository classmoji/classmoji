/**
 * The quiz form's source-material picker: one ordered list across pages and
 * slide decks, held by an antd Select as `page:<id>` / `slide:<id>` values.
 *
 * The edit round trip runs through here: the loader turns the quiz's linked
 * documents into picker values (in material order) and the options to name
 * them, and the submit turns the selected values back into `{ kind, id }` in
 * selection order, which is material order.
 */

export type SourceMaterialKind = 'page' | 'slide';

/** One entry of the source-material picker: `page:<id>` or `slide:<id>`. */
export type SourceMaterialValue = `${SourceMaterialKind}:${string}`;

export interface PickerDoc {
  id: string;
  title: string;
  is_draft: boolean;
}

/** A document linked to the quiz, as `quiz.source_material` lists it. */
export interface LinkedDoc extends PickerDoc {
  kind: SourceMaterialKind;
}

/** The picker's value for a document. */
export const toPickerValue = (kind: SourceMaterialKind, id: string): SourceMaterialValue =>
  `${kind}:${id}`;

/** A picker value back as `{ kind, id }`. Splits on the FIRST colon only. */
export const fromPickerValue = (value: string) => {
  const at = value.indexOf(':');
  return { kind: value.slice(0, at) as SourceMaterialKind, id: value.slice(at + 1) };
};

/** A picker label: the title, and a plain-text marker on a draft. */
export const pickerLabel = (doc: PickerDoc) => (doc.is_draft ? `${doc.title} — draft` : doc.title);

/** The quiz's linked documents as picker values, in material order. */
export const toPickerValues = (linked: ReadonlyArray<LinkedDoc>): SourceMaterialValue[] =>
  linked.map(doc => toPickerValue(doc.kind, doc.id));

/**
 * The picker's options: what the classroom offers (pages and reveal.js decks),
 * plus any LINKED document it does not offer (a FILE or LINK slide linked
 * through the MCP tool, say), so the Select can still name every value it
 * holds rather than show a bare id. Only the fields the picker reads are kept.
 */
export const pickerOptions = (
  offered: { pages: ReadonlyArray<PickerDoc>; decks: ReadonlyArray<PickerDoc> },
  linked: ReadonlyArray<LinkedDoc>
): { pages: PickerDoc[]; decks: PickerDoc[] } => {
  const listed = new Set([
    ...offered.pages.map(doc => toPickerValue('page', doc.id)),
    ...offered.decks.map(doc => toPickerValue('slide', doc.id)),
  ]);
  const linkedOutsideOptions = linked.filter(doc => !listed.has(toPickerValue(doc.kind, doc.id)));
  const fields = ({ id, title, is_draft }: PickerDoc): PickerDoc => ({ id, title, is_draft });
  return {
    pages: [...offered.pages, ...linkedOutsideOptions.filter(doc => doc.kind === 'page')].map(
      fields
    ),
    decks: [...offered.decks, ...linkedOutsideOptions.filter(doc => doc.kind === 'slide')].map(
      fields
    ),
  };
};
