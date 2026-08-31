import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useForm,
  type Resolver,
  type UseFormRegister,
  type UseFormSetValue,
  type UseFormWatch,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  buildResponseSchema,
  type FormField,
  type FormOption,
  type ResolvedTargetRef,
} from '@classmoji/services/form-contract';

import { FieldShell } from './FormPreview.tsx';
import { isDisplayField } from './fieldTypes.ts';
import {
  answerableFields,
  coerceAnswers,
  defaultAnswers,
  friendlyErrorMap,
  identityPlan,
  type IdentityPlan,
} from './answerCoerce.ts';

/**
 * The LIVE form: a definition rendered as real, fillable controls.
 *
 * ── One renderer, three callers ────────────────────────────────────────────
 * The public fill page, the verify page's "edit answers" mode, and (mission 6)
 * the classroom fill page all mount this. A second renderer for editing would
 * be a second set of validation rules and a second set of controls, and the two
 * would drift until an answer that submits on one is refused by the other.
 *
 * ── Validation ─────────────────────────────────────────────────────────────
 * `zodResolver` over `buildResponseSchema` — the SAME schema factory the server
 * runs in `parseAnswers`. The values are narrowed by `coerceAnswers` before the
 * resolver sees them (a DOM form produces strings for everything), and because
 * zod's parsed OUTPUT is what `handleSubmit` receives, the object this component
 * hands its caller is byte-identical to the one the server will validate.
 *
 * This is a convenience, not a control. The server re-validates every
 * submission against the revision it names, and a browser that skips this
 * entirely gets exactly the same answer from the action.
 *
 * ── Draft autosave ─────────────────────────────────────────────────────────
 * Debounced to localStorage under `draftKey`, restored on mount, and CLEARED BY
 * THE CALLER — the fill page cannot know whether a submission was a first one
 * or an edit of an existing response (deliberately: telling it would be a
 * membership oracle), so the draft is dropped on the verify page after the
 * response is actually confirmed. Every access is wrapped: Safari's private
 * mode throws on `setItem`, and a form that white-screens because it could not
 * save a draft is worse than one that silently does not.
 *
 * A CLASSROOM fill passes `draftKey: null` and `onDraft` instead: the draft
 * belongs to an identified member and lives on the server, so it follows them
 * to another machine. The two are mutually exclusive by intent — a member's
 * answers should not also be sitting in a shared lab browser's localStorage.
 */

const DRAFT_DEBOUNCE_MS = 1000;
/**
 * Longer than the localStorage debounce because each tick is a round trip, not
 * a synchronous write. ~1.5s of quiet is the plan's figure.
 */
const SERVER_DRAFT_DEBOUNCE_MS = 1500;

export interface RendererIdentity {
  name?: string | null;
  email?: string | null;
}

export interface RendererSubmission {
  answers: Record<string, unknown>;
  identity: { email: string; name: string | null };
  /** True when the hidden honeypot was filled — a human never does this. */
  trapped: boolean;
}

/**
 * One review target, as the renderer needs it: the schema key plus the name the
 * card is headed with. `optional` marks a DEPARTED teammate — their stored
 * review still rides along in the form state and is still accepted by the
 * server, but no card is drawn for them and nothing is required of them.
 */
export interface ReviewTarget extends ResolvedTargetRef {
  name: string;
  login?: string | null;
}

export interface FormRendererProps {
  fields: FormField[];
  /**
   * Per `repeat_group` field id, the teammates THIS person reviews — resolved
   * server-side in the classroom loader and passed down whole. Required
   * whenever the definition contains a repeat group: `buildResponseSchema`
   * refuses to build one without it, deliberately, so that a renderer which
   * forgot to resolve fails loudly instead of accepting reviews of anyone.
   */
  reviewTargets?: Record<string, ReviewTarget[]>;
  /** Answers to prefill: a stored response, or a repopulate after a stale error. */
  storedAnswers?: Record<string, unknown> | null;
  identityDefaults?: RendererIdentity;
  /**
   * A CLASSROOM fill's session identity. When set the form shows it as a locked
   * row ("from your account") and renders NO identity inputs — including for a
   * definition with no email field of its own, which is exactly when the public
   * path would have added them.
   */
  lockedIdentity?: { name: string; email: string } | null;
  /** localStorage key for the draft. Omit (or null) to disable autosave. */
  draftKey?: string | null;
  /**
   * Server-side autosave. Called with the current answers after ~1.5s of quiet,
   * never on mount, and never when nothing has been typed. The caller decides
   * what to do with it (and whether the row is safe to write at all).
   */
  onDraft?: ((answers: Record<string, unknown>) => void) | null;
  submitLabel: string;
  busy?: boolean;
  /** A server-side error to show above the submit button. */
  error?: string | null;
  onSubmit: (submission: RendererSubmission) => void;
  /** Rendered between the last field and the submit row (the disclosure line). */
  footnote?: React.ReactNode;
}

interface FormValues {
  answers: Record<string, unknown>;
  identityName: string;
  identityEmail: string;
  /** The honeypot. Named for a field a bot expects to find and a person cannot see. */
  website: string;
}

// ─── localStorage, defensively ──────────────────────────────────────────────

interface StoredDraft {
  answers?: Record<string, unknown>;
  identityName?: string;
  identityEmail?: string;
}

function readDraft(key: string | null | undefined): StoredDraft | null {
  if (!key || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as StoredDraft;
  } catch {
    // Unparseable, or storage is unavailable. Either way there is no draft.
    return null;
  }
}

function writeDraft(key: string, draft: StoredDraft): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Quota, private mode, or storage disabled. The form still works.
  }
}

/**
 * Drop every draft for one form, whatever revision it was keyed to.
 *
 * The key is `forms:{formId}:{revisionId}`, so a form republished between a
 * draft being saved and the response being confirmed leaves an orphan under the
 * old revision. Sweeping the `forms:{formId}:` prefix is what stops that orphan
 * from being restored into the next visit as a "draft restored" surprise.
 */
export function clearDraftsForForm(formId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const prefix = `forms:${formId}:`;
    const doomed: string[] = [];
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (key && key.startsWith(prefix)) doomed.push(key);
    }
    for (const key of doomed) window.localStorage.removeItem(key);
  } catch {
    // Nothing to do — the draft simply outlives the submission.
  }
}

/** The key a form + revision pair stores its draft under. */
export const draftKeyFor = (formId: string, revisionId: string): string =>
  `forms:${formId}:${revisionId}`;

// ─── Controls ───────────────────────────────────────────────────────────────

const inputClass =
  'w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 ' +
  'placeholder:text-gray-400 focus:border-gray-500 focus:outline-none focus:ring-1 ' +
  'focus:ring-gray-400 dark:border-gray-600 dark:bg-gray-900 dark:text-white ' +
  'dark:placeholder:text-gray-500';

const optionsOf = (field: FormField): FormOption[] => (field.options as FormOption[]) ?? [];

/** An option's secondary line — a rubric level, a clarification. */
function OptionDescription({ text }: { text?: string }) {
  if (!text) return null;
  return <span className="block text-xs text-gray-500 dark:text-gray-400">{text}</span>;
}

function DisplayBlock({ field }: { field: FormField }) {
  const text = (field.text as string) ?? '';

  if (field.type === 'heading') {
    return (
      <h2 className="mb-3 mt-8 text-base font-semibold text-gray-900 first:mt-0 dark:text-white">
        {text}
      </h2>
    );
  }
  if (field.type === 'banner') {
    const warning = field.tone === 'warning';
    return (
      <div
        className={`mb-6 flex gap-2 rounded-md border px-3 py-2.5 text-sm ${
          warning
            ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200'
            : 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200'
        }`}
      >
        <span aria-hidden="true">{warning ? '⚠️' : 'ℹ️'}</span>
        <span>{text}</span>
      </div>
    );
  }
  return <p className="mb-6 text-sm text-gray-600 dark:text-gray-300">{text}</p>;
}

export default function FormRenderer({
  fields,
  reviewTargets,
  storedAnswers,
  identityDefaults,
  lockedIdentity,
  draftKey,
  onDraft,
  submitLabel,
  busy = false,
  error,
  onSubmit,
  footnote,
}: FormRendererProps) {
  const plan: IdentityPlan = useMemo(() => identityPlan(fields), [fields]);
  // A locked identity answers the question the identity inputs exist to ask.
  const needsIdentityInputs = plan.emailFieldId === null && !lockedIdentity;

  /**
   * A draft is read ONCE, synchronously, into the initial values.
   *
   * Restoring in an effect instead would mean the first paint shows an empty
   * form and then repopulates it, which reads as the page losing the answers
   * and getting them back — and would fight any typing that happened in
   * between.
   */
  const restored = useRef<StoredDraft | null>(null);
  if (restored.current === null) restored.current = readDraft(draftKey) ?? {};
  const draft = restored.current;
  const didRestore = Boolean(draft && (draft.answers || draft.identityEmail || draft.identityName));

  const schema = useMemo(
    () =>
      z.object({
        // The SAME context the submit path builds server-side: current
        // teammates plus any departed one whose review is still on file. The
        // browser cannot widen it — it only renders what the loader resolved —
        // and the server rebuilds it from scratch regardless.
        answers: buildResponseSchema(fields, { resolved: reviewTargets }),
        identityName: z.string().max(300).optional(),
        identityEmail: needsIdentityInputs
          ? z
              .string()
              .trim()
              .min(1, 'We need an address to send your link to.')
              .email('That does not look like an email address.')
          : z.string().optional(),
        // Declared so zod keeps it out of the way. Its VALUE is never trusted
        // here — the caller reads it and the server decides.
        website: z.string().optional(),
      }),
    [fields, needsIdentityInputs, reviewTargets]
  );

  /**
   * Coerce, then hand to zodResolver. The order matters: the contract's schemas
   * describe stored shapes (a number is a number), and every DOM input produces
   * a string.
   */
  const resolver = useMemo<Resolver<FormValues>>(() => {
    /**
     * `friendlyErrorMap` turns the contract's developer-facing messages into
     * ones a person filling in a waitlist can act on — applied at the point
     * each issue is raised rather than in a post-pass, so nested paths (a
     * matrix row, a repeat group's inner field) get it too.
     *
     * The cast is to `ParseParams`, which zod declares with every field
     * required even though `safeParseAsync` treats them all as optional and
     * fills in `path` and `async` itself. Passing an error map alone is the
     * documented usage; the type simply does not describe it.
     */
    const parseOptions = { errorMap: friendlyErrorMap } as Partial<z.ParseParams> as z.ParseParams;
    const zod = zodResolver(schema, parseOptions) as unknown as Resolver<FormValues>;
    return async (values, context, options) => {
      const coerced = {
        ...values,
        answers: coerceAnswers(fields, (values.answers ?? {}) as Record<string, unknown>),
      } as FormValues;
      return zod(coerced, context, options);
    };
  }, [schema, fields]);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver,
    defaultValues: {
      answers: defaultAnswers(
        fields,
        {
          ...(storedAnswers ?? {}),
          ...(draft.answers ?? {}),
        },
        reviewTargets
      ),
      identityName: draft.identityName ?? identityDefaults?.name ?? '',
      identityEmail: draft.identityEmail ?? identityDefaults?.email ?? '',
      website: '',
    },
  });

  // ── Debounced autosave ────────────────────────────────────────────────────
  const values = watch();
  useEffect(() => {
    if (!draftKey) return;
    const handle = window.setTimeout(() => {
      writeDraft(draftKey, {
        answers: values.answers,
        identityName: values.identityName,
        identityEmail: values.identityEmail,
      });
    }, DRAFT_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
    // `values` is a fresh object every render by design — that IS the change
    // signal, and the debounce is what keeps it from being a write per keypress.
  }, [draftKey, values]);

  /**
   * ── Debounced server autosave (classroom fills) ─────────────────────────
   *
   * Two guards, and BOTH are load-bearing. `watch()` hands back a fresh object
   * on every render, not on every edit, which is what makes the effect's
   * dependency a change signal at all — and also what makes it dangerous here.
   *
   *  - The first run is skipped, so merely OPENING a form does not create a
   *    DRAFT row. Otherwise the partial-response list fills up with people who
   *    never typed anything.
   *
   *  - The answers are compared to what was last SENT. Without that, this loops
   *    forever: the save is a fetcher submit, a fetcher submit re-renders (and
   *    revalidates the loader, which re-renders again), a re-render reschedules
   *    the timer, and the timer saves. A tab left open would POST every couple
   *    of seconds for as long as it stayed open. The localStorage autosave
   *    above has the identical shape and is safe only because writing to
   *    localStorage causes no render.
   *
   * The comparison is against the last SENT value rather than the last SEEN
   * one on purpose: a re-render while a save is still pending must RESCHEDULE
   * the timer, not cancel it — React runs the previous cleanup before this
   * effect, so an early return there would silently drop the save.
   */
  const draftReady = useRef(false);
  const lastSentDraft = useRef<string>('');
  // Held in a ref so the effect can depend on `values` alone. Callers pass an
  // inline arrow (it closes over a fetcher), which is a new function identity
  // every render — in the dependency array it would say "changed" on renders
  // where nothing about the draft did.
  const draftSink = useRef(onDraft);
  draftSink.current = onDraft;

  useEffect(() => {
    if (!draftSink.current) return;

    const serialized = JSON.stringify(values.answers ?? {});
    if (!draftReady.current) {
      draftReady.current = true;
      lastSentDraft.current = serialized;
      return;
    }
    if (serialized === lastSentDraft.current) return;

    const handle = window.setTimeout(() => {
      lastSentDraft.current = serialized;
      draftSink.current?.(values.answers as Record<string, unknown>);
    }, SERVER_DRAFT_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [values]);

  /**
   * Has this form become interactive?
   *
   * Server-rendered markup looks like a working form and is not one: a
   * `<select>` set before hydration is reset by React's first controlled
   * render, and a click on a roster name does nothing at all. The attribute
   * this drives is the only honest signal of the difference — the DOM is
   * otherwise identical before and after — and it is what the e2e suite waits
   * on instead of racing the bundle.
   */
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  /**
   * The message for one answer path, walking the nested error tree.
   *
   * A path is a list because a repeat group's inner controls live two levels
   * down — `answers.{groupId}.{targetId}.{fieldId}` — and a lookup keyed only on
   * a field id would find nothing for any of them, so every card would render
   * as valid while the submit silently failed.
   *
   * `root` is checked alongside `message`: react-hook-form parks an error
   * raised ON an object (the group's own min/max refinement) under `root` when
   * the object also has per-key errors, and under `message` when it does not.
   */
  const errorFor = (...path: string[]): string | undefined => {
    let node: unknown = errors.answers;
    for (const step of path) {
      if (!node || typeof node !== 'object') return undefined;
      node = (node as Record<string, unknown>)[step];
    }
    if (!node || typeof node !== 'object') return undefined;
    const entry = node as { message?: string; root?: { message?: string } };
    return entry.message ?? entry.root?.message;
  };

  const submit = handleSubmit(data => {
    const answers = data.answers as Record<string, unknown>;

    // A locked identity is the session's, and the server re-derives it from the
    // session anyway. Sending it is a courtesy to the staff table, not a claim.
    if (lockedIdentity) {
      onSubmit({
        answers,
        identity: { email: lockedIdentity.email, name: lockedIdentity.name || null },
        trapped: false,
      });
      return;
    }

    const emailFromAnswers = plan.emailFieldId ? answers[plan.emailFieldId] : undefined;
    const nameFromAnswers = plan.nameFieldId ? answers[plan.nameFieldId] : undefined;

    onSubmit({
      answers,
      identity: {
        email: String(
          (typeof emailFromAnswers === 'string' && emailFromAnswers) || data.identityEmail || ''
        ).trim(),
        name:
          String(
            (typeof nameFromAnswers === 'string' && nameFromAnswers) || data.identityName || ''
          ).trim() || null,
      },
      trapped: Boolean(data.website && data.website.trim()),
    });
  });

  return (
    <FormBody
      fields={fields}
      reviewTargets={reviewTargets}
      register={register}
      watch={watch}
      setValue={setValue}
      errorFor={errorFor}
      needsIdentityInputs={needsIdentityInputs}
      lockedIdentity={lockedIdentity ?? null}
      identityEmailError={errors.identityEmail?.message as string | undefined}
      hydrated={hydrated}
      didRestore={didRestore}
      submit={submit}
      submitLabel={submitLabel}
      busy={busy}
      error={error}
      footnote={footnote}
    />
  );
}

// ─── The rendered form ──────────────────────────────────────────────────────
//
// MODULE SCOPE, not nested inside `FormRenderer`. This is load-bearing, not
// tidiness: the draft autosave subscribes to every value via `watch()`, so the
// renderer re-renders on EVERY KEYSTROKE. A component declared inside that body
// would be a brand-new function identity on each of those renders, and React
// treats a changed element type as a different component — it unmounts the live
// input and mounts a fresh one, which drops focus. The form would accept
// exactly one character per click.
//
// It survived every `fill()`-based test, because `fill()` sets a value in one
// atomic event and refocuses per call. `pressSequentially` in
// `forms-fill.spec.ts` is the assertion that actually discriminates it, and it
// is there permanently for that reason.

/**
 * A react-hook-form path into the answer set. Named because it appears in six
 * signatures and because RHF's own `Path<FormValues>` is a template literal —
 * a bare `string` does not satisfy it, and widening the form values to make it
 * would give up every other name check in this file.
 */
type AnswerPath = `answers.${string}`;

interface ControlProps {
  field: FormField;
  /**
   * The field's FULL react-hook-form path — `answers.{id}` at the top level and
   * `answers.{groupId}.{targetId}.{id}` inside a review card.
   *
   * Passed in rather than derived from `field.id`, because a repeat group
   * renders the SAME inner definition once per teammate: derived names would
   * collide, every card would share one value, and typing in one would type in
   * all of them.
   */
  name: AnswerPath;
  register: UseFormRegister<FormValues>;
  watch: UseFormWatch<FormValues>;
  setValue: UseFormSetValue<FormValues>;
  invalid: boolean;
}

/** How many matches the roster list shows before it asks for a narrower query. */
const ROSTER_VISIBLE_MATCHES = 40;

/**
 * `roster_select` — one control, two behaviours.
 *
 * The options are people, materialized into the revision at publish, and there
 * may be a hundred of them. A `<select>` of a hundred names is technically a
 * control and practically a wall, which is why this is a search box over a
 * filtered list: type three letters of a name, click the person.
 *
 * `multiple` decides the shape of the answer AND the shape of the control:
 * chips you can remove (Mockup 4's "Jordan Okafor ✕  Sam Whitfield ✕") versus a
 * single chosen name. The stored answer is user ids either way — a list for
 * multi, a bare id for single — which is what `coerceValue` and the contract's
 * answer schema both expect.
 *
 * The list is INLINE rather than a popover. A popover needs focus-loss
 * handling, an escape key, and a decision about what a click outside means; a
 * bordered box with a scroll needs none of that, works identically on a phone,
 * and cannot end up in the state where the options are open over the submit
 * button. `useState` lives here (a module-scope component) and not in the
 * renderer — see the note above `FormBody` for why that placement is
 * load-bearing.
 */
// `register` is in the props (it is the shared ControlProps shape) and
// deliberately unused: this field is not a DOM input, so there is nothing to
// register. Its value reaches `handleSubmit` the same way the opinion scale's
// does — `defaultValueFor` seeds it into the form state and `setValue` moves it.
function RosterSelect({ field, name, watch, setValue, invalid }: ControlProps) {
  const multiple = Boolean(field.multiple);
  const options = optionsOf(field);
  const label = String(field.label ?? 'people');
  const [query, setQuery] = useState('');

  const raw = watch(name) as unknown;
  const selectedIds: string[] = multiple
    ? ((Array.isArray(raw) ? raw : []).filter(Boolean) as string[])
    : typeof raw === 'string' && raw
      ? [raw]
      : [];

  const byId = new Map(options.map(option => [option.id, option]));
  const selected = selectedIds.map(id => byId.get(id)).filter(Boolean) as FormOption[];
  const chosen = new Set(selectedIds);

  const needle = query.trim().toLowerCase();
  const matches = options.filter(
    option => !chosen.has(option.id) && (!needle || option.label.toLowerCase().includes(needle))
  );

  const choose = (optionId: string) => {
    setValue(name, multiple ? [...selectedIds, optionId] : optionId, { shouldDirty: true });
    setQuery('');
  };

  const drop = (optionId: string) => {
    setValue(name, multiple ? selectedIds.filter(id => id !== optionId) : '', {
      shouldDirty: true,
    });
  };

  if (options.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-gray-300 px-3 py-2 text-sm italic text-gray-500 dark:border-gray-600 dark:text-gray-400">
        Nobody is on this list yet — ask the course staff to publish the form again once the roster
        is loaded.
      </p>
    );
  }

  return (
    <div
      // Two roster fields on one form offer the SAME people. Without a handle
      // per field, "click Jordan Okafor" is ambiguous on the page and in a test.
      data-testid={`roster-${field.id}`}
      className={`rounded-md border bg-white dark:bg-gray-900 ${
        invalid ? 'border-red-400' : 'border-gray-300 dark:border-gray-600'
      }`}
    >
      {selected.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-2 pt-2">
          {selected.map(option => (
            <span
              key={option.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 py-1 pl-3 pr-1.5 text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-100"
            >
              {option.label}
              <button
                type="button"
                onClick={() => drop(option.id)}
                aria-label={`Remove ${option.label}`}
                className="flex h-5 w-5 items-center justify-center rounded-full text-gray-500 hover:bg-gray-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {/* Single-pick: once someone is chosen the search box goes away, so the
          control reads as an answer rather than as an unfinished search. */}
      {multiple || selected.length === 0 ? (
        <>
          <input
            type="text"
            role="combobox"
            // The list is always rendered below the box (no popover), so it is
            // permanently "expanded" — and it is the element this control owns.
            aria-expanded="true"
            aria-controls={`roster-${field.id}-list`}
            aria-autocomplete="list"
            aria-label={`Search ${label}`}
            autoComplete="off"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={
              field.optionSource === 'teaching_team'
                ? 'Search the teaching team…'
                : 'Search the roster…'
            }
            aria-invalid={invalid}
            className="w-full border-0 bg-transparent px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none dark:text-white dark:placeholder:text-gray-500"
          />
          <ul
            id={`roster-${field.id}-list`}
            className="max-h-48 overflow-y-auto border-t border-gray-200 py-1 dark:border-gray-700"
          >
            {matches.slice(0, ROSTER_VISIBLE_MATCHES).map(option => (
              <li key={option.id}>
                <button
                  type="button"
                  onClick={() => choose(option.id)}
                  className="block w-full px-3 py-1.5 text-left text-sm text-gray-800 hover:bg-gray-100 dark:text-gray-100 dark:hover:bg-gray-800"
                >
                  {option.label}
                  <OptionDescription text={option.description} />
                </button>
              </li>
            ))}
            {matches.length === 0 ? (
              <li className="px-3 py-1.5 text-sm italic text-gray-500 dark:text-gray-400">
                No matches.
              </li>
            ) : null}
            {matches.length > ROSTER_VISIBLE_MATCHES ? (
              <li className="px-3 py-1.5 text-xs text-gray-500 dark:text-gray-400">
                {matches.length - ROSTER_VISIBLE_MATCHES} more — keep typing to narrow it down.
              </li>
            ) : null}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function Control({ field, name, register, watch, setValue, invalid }: ControlProps) {
  {
    const described = invalid ? `${name}-error` : undefined;
    const description = field.description as string | undefined;
    /**
     * Every control names ITSELF.
     *
     * `FieldShell` draws the question as a `<div>`, not a `<label htmlFor>` —
     * it is shared with the builder preview and the read-only answer view,
     * where there is no control to point at. Without an explicit name a screen
     * reader announces "edit text, blank" for every question, which is the
     * whole form unusable; the groups are named too, so a scale's "7" belongs
     * to a question rather than floating on the page.
     */
    const labelled = { 'aria-label': String(field.label ?? '') };

    switch (field.type) {
      case 'long_text':
        return (
          <textarea
            {...register(name)}
            {...labelled}
            rows={4}
            placeholder={field.placeholder as string | undefined}
            aria-invalid={invalid}
            aria-describedby={described}
            className={inputClass}
          />
        );

      case 'email': {
        const domain = field.domain as string | undefined;
        return (
          <input
            {...register(name)}
            {...labelled}
            type="email"
            autoComplete="email"
            placeholder={
              (field.placeholder as string | undefined) ??
              (domain ? `first.last@${domain}` : 'name@example.com')
            }
            aria-invalid={invalid}
            aria-describedby={described}
            className={inputClass}
          />
        );
      }

      case 'number':
        return (
          <input
            {...register(name)}
            {...labelled}
            type="number"
            inputMode="decimal"
            min={field.min as number | undefined}
            max={field.max as number | undefined}
            placeholder={field.placeholder as string | undefined}
            aria-invalid={invalid}
            aria-describedby={described}
            className={`${inputClass} max-w-40`}
          />
        );

      case 'dropdown':
        return (
          <div>
            <select
              {...register(name)}
              {...labelled}
              aria-invalid={invalid}
              aria-describedby={described}
              className={inputClass}
            >
              <option value="">Choose…</option>
              {optionsOf(field).map(option => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            {/* A <select> cannot show per-option prose, so any descriptions the
                instructor wrote are listed beneath it rather than dropped. */}
            {optionsOf(field).some(option => option.description) ? (
              <dl className="mt-2 space-y-1">
                {optionsOf(field)
                  .filter(option => option.description)
                  .map(option => (
                    <div key={option.id} className="text-xs">
                      <dt className="inline font-medium text-gray-600 dark:text-gray-300">
                        {option.label}:{' '}
                      </dt>
                      <dd className="inline text-gray-500 dark:text-gray-400">
                        {option.description}
                      </dd>
                    </div>
                  ))}
              </dl>
            ) : null}
          </div>
        );

      case 'multiselect':
        return (
          <fieldset {...labelled} aria-describedby={described} className="flex flex-col gap-2">
            {optionsOf(field).map(option => (
              <label
                key={option.id}
                className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-100"
              >
                <input
                  type="checkbox"
                  value={option.id}
                  {...register(name)}
                  className="mt-1 h-4 w-4 shrink-0"
                />
                <span>
                  {option.label}
                  <OptionDescription text={option.description} />
                </span>
              </label>
            ))}
          </fieldset>
        );

      case 'switch':
        return (
          <label className="flex items-start gap-2 text-sm text-gray-800 dark:text-gray-100">
            <input
              type="checkbox"
              {...register(name)}
              {...labelled}
              aria-invalid={invalid}
              aria-describedby={described}
              className="mt-1 h-4 w-4 shrink-0"
            />
            <span>
              {/* A REQUIRED switch is the acknowledgment pattern; its description
                  is the thing being agreed to, so it belongs next to the box. */}
              {description ?? (field.required ? 'I agree' : 'Yes')}
            </span>
          </label>
        );

      case 'opinion_scale': {
        const scale = field.scale as {
          min: number;
          max: number;
          minLabel?: string;
          maxLabel?: string;
        };
        const current = watch(name) as unknown;
        const steps: number[] = [];
        for (let step = scale.min; step <= scale.max; step++) steps.push(step);

        return (
          <div>
            <div
              role="radiogroup"
              {...labelled}
              aria-describedby={described}
              className="flex flex-wrap gap-1.5"
            >
              {steps.map(step => {
                const selected = Number(current) === step;
                return (
                  <button
                    key={step}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() =>
                      setValue(name, selected ? '' : step, {
                        shouldValidate: false,
                        shouldDirty: true,
                      })
                    }
                    className={`flex h-9 w-9 items-center justify-center rounded-md border text-sm transition ${
                      selected
                        ? 'border-gray-900 bg-gray-900 font-semibold text-white dark:border-white dark:bg-white dark:text-gray-900'
                        : 'border-gray-300 text-gray-600 hover:border-gray-500 dark:border-gray-600 dark:text-gray-300'
                    }`}
                  >
                    {step}
                  </button>
                );
              })}
            </div>
            {scale.minLabel || scale.maxLabel ? (
              <div className="mt-1.5 flex justify-between gap-4 text-xs text-gray-500 dark:text-gray-400">
                <span>{scale.minLabel}</span>
                <span className="text-right">{scale.maxLabel}</span>
              </div>
            ) : null}
          </div>
        );
      }

      case 'roster_select':
        return (
          <RosterSelect
            field={field}
            name={name}
            register={register}
            watch={watch}
            setValue={setValue}
            invalid={invalid}
          />
        );

      case 'ranked_choice': {
        const ranks = (field.ranks as number) ?? 1;
        const current = (watch(name) as unknown[] | undefined) ?? [];
        const options = optionsOf(field);

        return (
          <div className="flex flex-col gap-2">
            {Array.from({ length: ranks }, (_, index) => {
              const chosen = String(current[index] ?? '');
              // Each option is usable once — the constraint the contract
              // enforces, surfaced as options that disappear once taken rather
              // than as a warning banner about not repeating yourself.
              const takenElsewhere = new Set(
                current.filter((value, position) => position !== index && value).map(String)
              );
              return (
                <div key={index} className="flex items-center gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gray-100 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                    {index + 1}
                  </span>
                  <select
                    value={chosen}
                    aria-label={`Choice ${index + 1}`}
                    onChange={event => {
                      const next = [...current];
                      next[index] = event.target.value;
                      setValue(name, next, { shouldDirty: true });
                    }}
                    className={inputClass}
                  >
                    <option value="">Choose an option…</option>
                    {options
                      .filter(option => !takenElsewhere.has(option.id))
                      .map(option => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                  </select>
                </div>
              );
            })}
          </div>
        );
      }

      case 'matrix': {
        const matrix = field.matrix as { rows: FormOption[]; columns: FormOption[] };
        return (
          /* ONE set of radio inputs, restyled at ≤640px rather than duplicated.
             A second stacked copy would mean two DOM nodes per choice sharing a
             name, which is a class of bug that only shows up on a phone. */
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm max-sm:block">
              <thead className="max-sm:hidden">
                <tr>
                  <th scope="col" className="w-1/3 px-2 py-1.5" />
                  {matrix.columns.map(column => (
                    <th
                      key={column.id}
                      scope="col"
                      className="px-2 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-300"
                    >
                      {column.label}
                      <OptionDescription text={column.description} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="max-sm:block">
                {matrix.rows.map(row => (
                  <tr
                    key={row.id}
                    className="border-t border-gray-100 dark:border-gray-800 max-sm:mb-3 max-sm:block max-sm:rounded-md max-sm:border max-sm:border-gray-200 max-sm:p-3 max-sm:dark:border-gray-700"
                  >
                    <th
                      scope="row"
                      className="px-2 py-2 text-left text-sm font-normal text-gray-700 dark:text-gray-200 max-sm:mb-2 max-sm:block max-sm:px-0 max-sm:font-medium"
                    >
                      {row.label}
                      <OptionDescription text={row.description} />
                    </th>
                    {matrix.columns.map(column => (
                      <td
                        key={column.id}
                        className="px-2 py-2 max-sm:flex max-sm:items-center max-sm:justify-between max-sm:gap-3 max-sm:px-0 max-sm:py-1"
                      >
                        {/* Visible only in the stacked layout, where the column
                            header row is gone. */}
                        <span className="hidden text-sm text-gray-600 max-sm:inline dark:text-gray-300">
                          {column.label}
                        </span>
                        <input
                          type="radio"
                          value={column.id}
                          {...register(`${name}.${row.id}` as AnswerPath)}
                          aria-label={`${row.label}: ${column.label}`}
                          className="h-4 w-4"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }

      default:
        return (
          <input
            {...register(name)}
            {...labelled}
            type="text"
            placeholder={field.placeholder as string | undefined}
            aria-invalid={invalid}
            aria-describedby={described}
            className={inputClass}
          />
        );
    }
  }
}

// ─── Review cards (repeat_group) ────────────────────────────────────────────
//
// MODULE SCOPE, like every other control here, and for the same reason: this
// component owns `useState` for which cards are open, and a component declared
// inside `FormRenderer` would be a new function identity on every keystroke —
// unmounting the open card mid-sentence. See the note above `ControlProps`.

/** The read of one card's answers, narrowed the way the resolver will see it. */
const reviewAt = (
  watch: UseFormWatch<FormValues>,
  groupId: string,
  targetId: string
): Record<string, unknown> => {
  const value = watch(`answers.${groupId}.${targetId}` as AnswerPath) as unknown;
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
};

interface RepeatGroupProps {
  field: FormField;
  targets: ReviewTarget[];
  register: UseFormRegister<FormValues>;
  watch: UseFormWatch<FormValues>;
  setValue: UseFormSetValue<FormValues>;
  errorFor: (...path: string[]) => string | undefined;
}

/**
 * One collapsible card per teammate — Mockup 4's peer-review block.
 *
 * ── Completion is computed, not tracked ────────────────────────────────────
 * A card's tick comes from running the group's INNER definition through the
 * same `buildResponseSchema` the whole form uses, over the same coerced values.
 * Nothing counts "have they touched it" — a card is done when its answers would
 * actually validate, which is the only definition that agrees with what the
 * submit button will do.
 *
 * ── Which cards are open ───────────────────────────────────────────────────
 * The first one, plus any card holding an error, plus whatever the person has
 * opened. Auto-opening on error is load-bearing rather than polish: a required
 * review inside a collapsed card would otherwise refuse the submit while
 * showing nothing at all to fix.
 */
function RepeatGroup({ field, targets, register, watch, setValue, errorFor }: RepeatGroupProps) {
  const groupId = field.id;
  const inner = useMemo(() => (field.fields as FormField[] | undefined) ?? [], [field]);
  // Departed teammates ride along in the form values and are never drawn: the
  // card would invite a review of somebody who is no longer on the team.
  const visible = targets.filter(target => !target.optional);

  const innerSchema = useMemo(() => buildResponseSchema(inner), [inner]);
  const [opened, setOpened] = useState<Record<string, boolean>>({});

  const completion = visible.map(target => {
    const review = reviewAt(watch, groupId, target.user_id);
    return innerSchema.safeParse(coerceAnswers(inner, review)).success;
  });
  const done = completion.filter(Boolean).length;

  if (visible.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-gray-300 px-3 py-2.5 text-sm text-gray-600 dark:border-gray-600 dark:text-gray-300">
        You are the only person on your team, so there is nobody to review. The rest of the form is
        still yours to fill in.
      </p>
    );
  }

  return (
    <div data-testid={`review-group-${groupId}`}>
      <p
        data-testid={`review-progress-${groupId}`}
        className="mb-3 text-xs font-medium text-gray-500 dark:text-gray-400"
      >
        {done} of {visible.length} reviewed
      </p>

      {visible.map((target, index) => {
        const complete = completion[index];
        /**
         * Two different errors, shown in two different places.
         *
         * `targetError` is raised ON the card — "this one is required" for a
         * teammate nobody has reviewed, which is what `require_all_targets`
         * produces. It has no inner field to attach to, so it is rendered
         * beside the card's heading whether the card is open or shut.
         *
         * `innerError` is a question inside the card, which the card's own
         * fields render for themselves. It only decides whether the card
         * springs open: a required review hidden inside a collapsed card would
         * refuse the submit while showing nothing at all to fix.
         */
        const targetError = errorFor(groupId, target.user_id);
        const innerError = inner
          .map(child => errorFor(groupId, target.user_id, child.id))
          .find(message => Boolean(message));
        const cardError = targetError ?? innerError;
        const open = opened[target.user_id] ?? (index === 0 || Boolean(innerError));

        return (
          <div
            key={target.user_id}
            data-testid={`review-card-${target.user_id}`}
            data-complete={complete ? 'true' : 'false'}
            className={`mb-3 rounded-md border ${
              cardError
                ? 'border-red-300 dark:border-red-800'
                : 'border-gray-200 dark:border-gray-700'
            }`}
          >
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpened(current => ({ ...current, [target.user_id]: !open }))}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
            >
              <span aria-hidden="true" className="text-xs text-gray-400">
                {open ? '▾' : '▸'}
              </span>
              <span className="flex-1 text-sm font-medium text-gray-900 dark:text-white">
                {target.name}
              </span>
              <span
                aria-label={complete ? `${target.name} reviewed` : `${target.name} not reviewed`}
                className={`text-xs font-medium ${
                  complete
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-gray-400 dark:text-gray-500'
                }`}
              >
                {complete ? '✓' : '—'}
              </span>
            </button>

            {open ? (
              <div className="border-t border-gray-100 px-3 pb-1 pt-3 dark:border-gray-800">
                {inner.map(child => (
                  <Field
                    key={child.id}
                    field={child}
                    name={`answers.${groupId}.${target.user_id}.${child.id}` as AnswerPath}
                    register={register}
                    watch={watch}
                    setValue={setValue}
                    message={errorFor(groupId, target.user_id, child.id)}
                  />
                ))}
              </div>
            ) : null}

            {targetError ? (
              <p
                role="alert"
                className="px-3 pb-2.5 text-xs font-medium text-red-600 dark:text-red-400"
              >
                {targetError}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

interface FieldProps extends Omit<ControlProps, 'invalid'> {
  message?: string;
  /** Only a repeat_group needs these, and only at the top level. */
  targets?: ReviewTarget[];
  errorFor?: (...path: string[]) => string | undefined;
}

function Field({ field, name, register, watch, setValue, message, targets, errorFor }: FieldProps) {
  if (isDisplayField(field.type)) return <DisplayBlock field={field} />;

  const description = field.description as string | undefined;

  return (
    <FieldShell field={field}>
      {/* A switch renders its own description beside the box; every other type
          gets it above the control, where it reads as part of the question. */}
      {description && field.type !== 'switch' ? (
        <p className="mb-2 text-sm text-gray-500 dark:text-gray-400">{description}</p>
      ) : null}
      {field.type === 'repeat_group' ? (
        <RepeatGroup
          field={field}
          targets={targets ?? []}
          register={register}
          watch={watch}
          setValue={setValue}
          errorFor={errorFor ?? (() => undefined)}
        />
      ) : (
        <Control
          field={field}
          name={name}
          register={register}
          watch={watch}
          setValue={setValue}
          invalid={Boolean(message)}
        />
      )}
      {message ? (
        <p
          id={`${name}-error`}
          role="alert"
          className="mt-1.5 text-xs font-medium text-red-600 dark:text-red-400"
        >
          {message}
        </p>
      ) : null}
    </FieldShell>
  );
}

interface FormBodyProps {
  fields: FormField[];
  reviewTargets?: Record<string, ReviewTarget[]>;
  register: UseFormRegister<FormValues>;
  watch: UseFormWatch<FormValues>;
  setValue: UseFormSetValue<FormValues>;
  errorFor: (...path: string[]) => string | undefined;
  needsIdentityInputs: boolean;
  lockedIdentity: { name: string; email: string } | null;
  identityEmailError?: string;
  hydrated: boolean;
  didRestore: boolean;
  submit: (event?: React.BaseSyntheticEvent) => Promise<void>;
  submitLabel: string;
  busy: boolean;
  error?: string | null;
  footnote?: React.ReactNode;
}

function FormBody({
  fields,
  reviewTargets,
  register,
  watch,
  setValue,
  errorFor,
  needsIdentityInputs,
  lockedIdentity,
  identityEmailError,
  hydrated,
  didRestore,
  submit,
  submitLabel,
  busy,
  error,
  footnote,
}: FormBodyProps) {
  const answerable = answerableFields(fields);

  return (
    <form onSubmit={submit} noValidate data-hydrated={hydrated ? 'true' : 'false'}>
      {/* Mockup 4's locked identity row. It sits ABOVE the questions, not among
          them: it is not a question, it is the answer to "who is filling this
          in", and it is already settled by the session. */}
      {lockedIdentity ? (
        <div className="mb-6 rounded-md border border-gray-200 bg-gray-50 px-3 py-2.5 dark:border-gray-700 dark:bg-gray-800/60">
          <div className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Your name
          </div>
          <div className="mt-0.5 text-sm text-gray-900 dark:text-white">
            {lockedIdentity.name || lockedIdentity.email}{' '}
            <span className="text-gray-500 dark:text-gray-400">— from your account</span>
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{lockedIdentity.email}</div>
        </div>
      ) : null}

      {didRestore ? (
        <p className="mb-5 rounded-md bg-gray-100 px-3 py-2 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          We restored the answers you started on this device.
        </p>
      ) : null}

      {fields.map(field => (
        <Field
          key={field.id}
          field={field}
          name={`answers.${field.id}` as AnswerPath}
          targets={reviewTargets?.[field.id]}
          errorFor={errorFor}
          register={register}
          watch={watch}
          setValue={setValue}
          // A repeat group's own message would be its min/max refinement; the
          // per-card errors are rendered inside the group, so this stays for
          // the group-level rule only.
          message={errorFor(field.id)}
        />
      ))}

      {answerable.length === 0 ? (
        <p className="mb-6 text-sm italic text-gray-500 dark:text-gray-400">
          This form has nothing to fill in yet.
        </p>
      ) : null}

      {needsIdentityInputs ? (
        <div className="mb-6 border-t border-gray-200 pt-5 dark:border-gray-700">
          {/* Real <label htmlFor> here, unlike the question fields: those go
              through the shared `FieldShell` (which has no control to point at
              in the preview and answer views, so they name themselves with
              aria-label). This block owns its own markup, so it can do the
              plain, correct thing. */}
          <label
            htmlFor="forms-identity-name"
            className="mb-1.5 block text-sm font-medium text-gray-800 dark:text-gray-100"
          >
            Your name
          </label>
          <input
            id="forms-identity-name"
            {...register('identityName')}
            type="text"
            autoComplete="name"
            className={`${inputClass} mb-4`}
          />
          <label
            htmlFor="forms-identity-email"
            className="mb-1.5 block text-sm font-medium text-gray-800 dark:text-gray-100"
          >
            Your email address<span className="ml-0.5 text-red-500">*</span>
          </label>
          <input
            id="forms-identity-email"
            {...register('identityEmail')}
            type="email"
            autoComplete="email"
            aria-invalid={Boolean(identityEmailError)}
            className={inputClass}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            We will send a link here to confirm your response.
          </p>
          {identityEmailError ? (
            <p role="alert" className="mt-1.5 text-xs font-medium text-red-600 dark:text-red-400">
              {identityEmailError}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* The honeypot. Off-screen rather than `display:none`: a bot that skips
          hidden fields is exactly the bot this catches, and screen readers are
          kept out with aria-hidden + tabIndex instead. */}
      <div
        aria-hidden="true"
        className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden"
      >
        <label htmlFor="website">Website</label>
        <input id="website" type="text" tabIndex={-1} autoComplete="off" {...register('website')} />
      </div>

      {footnote ? (
        <div className="mb-4 text-xs text-gray-500 dark:text-gray-400">{footnote}</div>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {error}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="rounded-md bg-gray-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200"
      >
        {busy ? 'Sending…' : submitLabel}
      </button>
    </form>
  );
}
