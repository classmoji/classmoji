import { useEffect, useMemo, useRef } from 'react';
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
 */

const DRAFT_DEBOUNCE_MS = 1000;

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

export interface FormRendererProps {
  fields: FormField[];
  /** Answers to prefill: a stored response, or a repopulate after a stale error. */
  storedAnswers?: Record<string, unknown> | null;
  identityDefaults?: RendererIdentity;
  /** localStorage key for the draft. Omit (or null) to disable autosave. */
  draftKey?: string | null;
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
  storedAnswers,
  identityDefaults,
  draftKey,
  submitLabel,
  busy = false,
  error,
  onSubmit,
  footnote,
}: FormRendererProps) {
  const plan: IdentityPlan = useMemo(() => identityPlan(fields), [fields]);
  const needsIdentityInputs = plan.emailFieldId === null;

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
        answers: buildResponseSchema(fields),
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
    [fields, needsIdentityInputs]
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
      answers: defaultAnswers(fields, {
        ...(storedAnswers ?? {}),
        ...(draft.answers ?? {}),
      }),
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

  const answerErrors = (errors.answers ?? {}) as Record<string, { message?: string } | undefined>;
  const errorFor = (fieldId: string): string | undefined => answerErrors[fieldId]?.message;

  const submit = handleSubmit(data => {
    const answers = data.answers as Record<string, unknown>;
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
      register={register}
      watch={watch}
      setValue={setValue}
      errorFor={errorFor}
      needsIdentityInputs={needsIdentityInputs}
      identityEmailError={errors.identityEmail?.message as string | undefined}
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

interface ControlProps {
  field: FormField;
  register: UseFormRegister<FormValues>;
  watch: UseFormWatch<FormValues>;
  setValue: UseFormSetValue<FormValues>;
  invalid: boolean;
}

function Control({ field, register, watch, setValue, invalid }: ControlProps) {
  {
    const name = `answers.${field.id}` as const;
    const described = invalid ? `${field.id}-error` : undefined;
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
                          {...register(`answers.${field.id}.${row.id}`)}
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

interface FieldProps extends Omit<ControlProps, 'invalid'> {
  message?: string;
}

function Field({ field, register, watch, setValue, message }: FieldProps) {
  if (isDisplayField(field.type)) return <DisplayBlock field={field} />;

  const description = field.description as string | undefined;

  return (
    <FieldShell field={field}>
      {/* A switch renders its own description beside the box; every other type
          gets it above the control, where it reads as part of the question. */}
      {description && field.type !== 'switch' ? (
        <p className="mb-2 text-sm text-gray-500 dark:text-gray-400">{description}</p>
      ) : null}
      <Control
        field={field}
        register={register}
        watch={watch}
        setValue={setValue}
        invalid={Boolean(message)}
      />
      {message ? (
        <p
          id={`${field.id}-error`}
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
  register: UseFormRegister<FormValues>;
  watch: UseFormWatch<FormValues>;
  setValue: UseFormSetValue<FormValues>;
  errorFor: (fieldId: string) => string | undefined;
  needsIdentityInputs: boolean;
  identityEmailError?: string;
  didRestore: boolean;
  submit: (event?: React.BaseSyntheticEvent) => Promise<void>;
  submitLabel: string;
  busy: boolean;
  error?: string | null;
  footnote?: React.ReactNode;
}

function FormBody({
  fields,
  register,
  watch,
  setValue,
  errorFor,
  needsIdentityInputs,
  identityEmailError,
  didRestore,
  submit,
  submitLabel,
  busy,
  error,
  footnote,
}: FormBodyProps) {
  const answerable = answerableFields(fields);

  return (
    <form onSubmit={submit} noValidate>
      {didRestore ? (
        <p className="mb-5 rounded-md bg-gray-100 px-3 py-2 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          We restored the answers you started on this device.
        </p>
      ) : null}

      {fields.map(field => (
        <Field
          key={field.id}
          field={field}
          register={register}
          watch={watch}
          setValue={setValue}
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
