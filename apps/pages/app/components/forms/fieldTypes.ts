import {
  FIELD_TYPE_REGISTRY,
  FIELD_TYPES,
  type FormField,
  type FormFieldType,
  type FormOption,
} from '@classmoji/services/form-contract';

/**
 * The builder's view of the field-type registry: display names, palette order,
 * and what a freshly added field of each type looks like.
 *
 * DERIVED, never duplicated. `classroomOnly`, `kind` and the set of types all
 * come from `FIELD_TYPE_REGISTRY` — the contract is the single declaration
 * site, and a type added there shows up in the palette without an edit here
 * (only its label and starter shape are local, and both have fallbacks). That
 * is what keeps the 🔒 set in the palette identical to the set the server
 * rejects on a PUBLIC form; a hand-maintained list would eventually disagree
 * with the validator, and the UI would be lying about what will save.
 *
 * Imported by BOTH the builder and (next milestone) the fill renderer, hence
 * `app/components/forms/` rather than a route folder. Browser-safe: the
 * contract is reached through the `@classmoji/services/form-contract` subpath,
 * which pulls in zod and nothing else — the package root barrel would drag
 * Prisma into the client bundle.
 */

export interface FieldTypeMeta {
  type: FormFieldType;
  label: string;
  /** One line under the type name in the palette; also the card's subtitle. */
  hint: string;
  /** From the registry: rejected on PUBLIC forms, so shown locked there. */
  classroomOnly: boolean;
  /** From the registry: display blocks collect no answer. */
  isDisplay: boolean;
  /** From the registry: may a repeat group contain this type? */
  nestable: boolean;
}

/** Client-side id minting. Same source the contract uses when ids are absent. */
export const newId = (): string => globalThis.crypto.randomUUID();

const option = (label: string, description?: string): FormOption => ({
  id: newId(),
  label,
  ...(description ? { description } : {}),
});

/** Human labels + palette order. Order is authored; membership is derived. */
const META: Record<FormFieldType, { label: string; hint: string }> = {
  short_text: { label: 'Short text', hint: 'One line — a name, a username' },
  long_text: { label: 'Long text', hint: 'A paragraph answer' },
  email: { label: 'Email', hint: 'Validated address, optional domain' },
  number: { label: 'Number', hint: 'Numeric, with optional bounds' },
  dropdown: { label: 'Dropdown', hint: 'Pick one of a list' },
  multiselect: { label: 'Multi-select', hint: 'Pick any number' },
  switch: { label: 'Switch', hint: 'Yes / no — required means "must agree"' },
  opinion_scale: { label: 'Opinion scale', hint: 'A numbered scale with end labels' },
  matrix: { label: 'Matrix', hint: 'Rows × columns, one pick per row' },
  ranked_choice: { label: 'Ranked choice', hint: 'Order options, each used once' },
  roster_select: { label: 'Roster select', hint: 'Options are the live class roster' },
  repeat_group: { label: 'Team review', hint: 'Repeats once per teammate' },
  heading: { label: 'Heading', hint: 'A section title' },
  paragraph: { label: 'Paragraph', hint: 'Explanatory prose' },
  banner: { label: 'Banner', hint: 'A highlighted notice' },
};

/**
 * Palette order: everyday inputs, then the classroom-aware ones, then display.
 *
 * A `Record`, not an array, so it is EXHAUSTIVE. As a `FormFieldType[]` a new
 * registry entry simply sorted to the end of the palette with no label and no
 * hint — a blank button an instructor could press. As a Record, the type does
 * not compile until someone decides where it belongs.
 */
const PALETTE_ORDER: Record<FormFieldType, number> = {
  short_text: 0,
  long_text: 1,
  email: 2,
  number: 3,
  dropdown: 4,
  multiselect: 5,
  switch: 6,
  opinion_scale: 7,
  matrix: 8,
  ranked_choice: 9,
  roster_select: 10,
  repeat_group: 11,
  heading: 12,
  paragraph: 13,
  banner: 14,
};

/** Every registry type, as palette entries, in authored order. */
export const FIELD_TYPE_META: FieldTypeMeta[] = [...FIELD_TYPES]
  .sort((a, b) => PALETTE_ORDER[a] - PALETTE_ORDER[b])
  .map(type => ({
    type,
    label: META[type].label,
    hint: META[type].hint,
    classroomOnly: FIELD_TYPE_REGISTRY[type].classroomOnly,
    isDisplay: FIELD_TYPE_REGISTRY[type].kind === 'display',
    nestable: FIELD_TYPE_REGISTRY[type].nestable,
  }));

/**
 * The palette a repeat group's INNER list offers — everything the contract will
 * accept inside one.
 *
 * Derived from the registry's own `nestable` flag rather than written out as
 * "everything except repeat_group". The contract already refuses a nested group
 * (`fieldDispatch` validates the inner list against the nestable set), so a
 * hand-maintained exclusion here would be a second copy of that rule, free to
 * drift, and the UI would eventually offer a field the save refuses.
 */
export const NESTABLE_FIELD_TYPE_META: FieldTypeMeta[] = FIELD_TYPE_META.filter(
  meta => meta.nestable
);

export const metaFor = (type: string): FieldTypeMeta | undefined =>
  FIELD_TYPE_META.find(entry => entry.type === type);

export const isDisplayField = (type: string): boolean =>
  (FIELD_TYPE_REGISTRY as Record<string, { kind?: string }>)[type]?.kind === 'display';

/**
 * THE OTHER HALF OF THE REGISTRY'S PROMISE.
 *
 * `formContract.FIELD_TYPE_REGISTRY` is the single place a field type is
 * declared, and the VALIDATION layer really is derived from it — the definition
 * union, the nestable set, the access rule, and `buildResponseSchema` all read
 * the registry, so a new entry reaches all four for free.
 *
 * The PRESENTATION layer cannot be derived that way: a renderer, a preview, a
 * config panel and a CSV formatter are code, not data, and each has to be
 * written. What they must not do is fail QUIETLY. Before this existed, adding a
 * `date` type to the registry produced a form that saved and validated
 * perfectly and then rendered a plain text box, previewed as a grey placeholder,
 * offered no configuration, and exported the raw ISO string — five silent
 * degradations and no error anywhere.
 *
 * So every presentation dispatch ends in this call. The `never` parameter is
 * what does the work: TypeScript accepts the argument only when the switch above
 * has covered every member of `FormFieldType`, which makes ADDING A TYPE TO THE
 * REGISTRY A COMPILE ERROR IN EVERY FILE THAT DRAWS ONE. The runtime throw
 * covers what the compiler cannot see — a stored revision naming a type this
 * build does not know — where refusing to render beats rendering it wrong.
 *
 * (This replaces the registry's old `rendererKey`, which named a component for
 * all fifteen types and was read by nothing. A documented mechanism that does
 * not run is worse than none, because it reads as a guarantee.)
 */
export function unhandledFieldType(type: never, where: string): never {
  throw new Error(
    `[forms] ${where} has no case for field type ${JSON.stringify(type)}. ` +
      'Every type in FIELD_TYPE_REGISTRY needs one — see unhandledFieldType in fieldTypes.ts.'
  );
}

/**
 * A new field of the given type, already carrying ids.
 *
 * Ids are minted HERE rather than left to the server's parse, so a field keeps
 * one identity from the moment it is dropped into the list: drag-and-drop keys,
 * the expanded-card state, and the preview all key on it, and answers collected
 * against a published revision key on it forever. The contract keeps ids it is
 * given, so this survives the round trip.
 *
 * Every shape below is the MINIMUM its definition schema accepts — the schemas
 * are `.strict()`, so an extra key here is a save failure, not a silent drop.
 */
export function makeField(type: FormFieldType): FormField {
  const base = { id: newId(), type } as const;

  switch (type) {
    case 'short_text':
      return { ...base, label: 'Your answer', required: false } as FormField;
    case 'long_text':
      return { ...base, label: 'Tell us more', required: false } as FormField;
    case 'email':
      return { ...base, label: 'Email address', required: true } as FormField;
    case 'number':
      return { ...base, label: 'A number', required: false } as FormField;
    case 'dropdown':
    case 'multiselect':
      return {
        ...base,
        label: type === 'dropdown' ? 'Choose one' : 'Choose any',
        required: false,
        options: [option('Option 1'), option('Option 2')],
      } as FormField;
    case 'switch':
      return { ...base, label: 'Yes or no?', required: false } as FormField;
    case 'opinion_scale':
      return {
        ...base,
        label: 'How would you rate it?',
        required: false,
        scale: { min: 1, max: 5 },
      } as FormField;
    case 'matrix':
      return {
        ...base,
        label: 'Rate each behaviour',
        required: false,
        matrix: {
          rows: [option('First behaviour'), option('Second behaviour')],
          columns: [option('Never'), option('Sometimes'), option('Always')],
          required_rows: 'all',
        },
      } as FormField;
    case 'ranked_choice':
      return {
        ...base,
        label: 'Rank your choices',
        required: false,
        options: [option('First idea'), option('Second idea'), option('Third idea')],
        ranks: 3,
      } as FormField;
    case 'roster_select':
      return {
        ...base,
        label: 'Choose from the roster',
        required: false,
        optionSource: 'roster',
        multiple: false,
        // Empty by design: Tier-1 options are materialized into the revision at
        // publish, never authored by hand.
        options: [],
      } as FormField;
    case 'repeat_group':
      return {
        ...base,
        label: 'Review each teammate',
        required: false,
        repeat: {
          // `classroom` is the only scope that needs no id, so it is the only
          // one a brand-new group can legally carry. The scope picker retargets
          // it to a tag or a repository once the instructor chooses one.
          over: 'teammates',
          scope: { by: 'classroom' },
          exclude_self: true,
          require_all_targets: true,
        },
        fields: [
          {
            id: newId(),
            type: 'long_text',
            label: 'How did they contribute?',
            required: false,
          },
        ],
      } as unknown as FormField;
    case 'heading':
      return { ...base, text: 'Section heading' } as unknown as FormField;
    case 'paragraph':
      return { ...base, text: 'Some explanatory text.' } as unknown as FormField;
    case 'banner':
      return {
        ...base,
        text: 'Something worth highlighting.',
        tone: 'info',
      } as unknown as FormField;
    default:
      // A silent `{ label: 'Your answer' }` used to live here, which meant a new
      // registry type produced a plausible-looking starter field that the save
      // would then reject for missing whatever its schema requires.
      return unhandledFieldType(type, 'fieldTypes.makeField');
  }
}

/** A fresh option row for the options / matrix editors. */
export const makeOption = (label = 'New option', description?: string): FormOption =>
  option(label, description);
