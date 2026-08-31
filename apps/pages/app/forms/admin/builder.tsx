import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useFetcher, useLoaderData, type SubmitTarget } from 'react-router';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { IconLock, IconPlus } from '@tabler/icons-react';
import type { FormField } from '@classmoji/services/form-contract';

import { ClassmojiService } from '~/utils/db.server.ts';
import { assertFormAdmin, formMutationBlocked } from '~/utils/formAuth.server.ts';
import FormPreview from '~/components/forms/FormPreview.tsx';
import { ConfirmDialog } from '~/components/forms/ConfirmDialog.tsx';
import FieldCard from '~/components/forms/builder/FieldCard.tsx';
import type { ScopeChoices } from '~/components/forms/builder/FieldConfig.tsx';
import { FIELD_TYPE_META, makeField } from '~/components/forms/fieldTypes.ts';

/**
 * The builder: a field LIST on the left, a live preview on the right.
 *
 * ── What the client edits ──────────────────────────────────────────────────
 * The NORMALIZED definition the server stored, never a translated editing
 * shape. The loader hands back `draft_fields` exactly as `parseFormDefinition`
 * left it, the builder patches objects in place (minting ids for anything new),
 * and the save posts the result straight back through the same parse. Field ids
 * therefore survive every edit, which is what keeps answers collected against
 * an earlier revision pointing at the fields they were given.
 *
 * ── Saving vs. publishing ──────────────────────────────────────────────────
 * `form.service.update` accepts a field list only while the form is a DRAFT:
 * once responses can exist, a changed definition is a new REVISION rather than
 * an edit of the one people already answered. So there are two paths, and the
 * second is not "save then publish":
 *
 *   DRAFT   → Save writes draft_fields. Publish snapshots them into revision 1.
 *   OPEN /  → Save is disabled. "Publish a new version" runs, server-side and
 *   CLOSED    in one action, quickUpdate(DRAFT) → update(fields) → publish() —
 *             the only sequence the service permits, and one the client must
 *             not attempt as three round trips, because a failure between them
 *             would leave a live form parked in DRAFT.
 */

type FormAccess = 'PUBLIC' | 'CLASSROOM';
type FormStatus = 'DRAFT' | 'OPEN' | 'CLOSED';

const fieldsOf = (payload: unknown): FormField[] => {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload as FormField[];
  return ((payload as { fields?: FormField[] }).fields ?? []) as FormField[];
};

/**
 * A stored instant as the local wall-clock string a `datetime-local` input
 * wants (`YYYY-MM-DDTHH:mm`).
 *
 * `toISOString().slice(0, 16)` is the tempting one-liner and it is wrong: it
 * yields UTC, so an instructor in New York setting "5pm" would see "10pm" on
 * the next page load and, believing they had mistyped, would fix it — moving
 * the real deadline five hours earlier.
 *
 * Returns '' for an unset or unparseable value, which is what clears the input.
 */
const toLocalInput = (iso: string): string => {
  if (!iso) return '';
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
    `T${pad(when.getHours())}:${pad(when.getMinutes())}`
  );
};

export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const classroomSlug = params.classroomSlug!;
  const { classroom } = await assertFormAdmin(classroomSlug, request, { action: 'edit_form' });

  const form = await ClassmojiService.form.findBySlug(classroom.id, params.formSlug!, {
    includeCurrentRevision: true,
  });
  if (!form) throw new Response('Form not found', { status: 404 });

  // Team-review scopes. Read here rather than in the component because both
  // lists are classroom-scoped data and the picker must never be able to name a
  // tag or an assignment from another classroom.
  const [tags, repositories] = await Promise.all([
    ClassmojiService.organizationTag.findByClassroomId(classroom.id),
    ClassmojiService.repository.findByClassroomId(classroom.id),
  ]);

  const revisions = (form as { revisions?: Array<{ version: number }> }).revisions ?? [];

  return {
    classroomSlug,
    form: {
      id: form.id,
      title: form.title,
      slug: form.slug,
      description: form.description,
      access: form.access as FormAccess,
      status: form.status as FormStatus,
      published: Boolean(form.current_revision_id),
      version: revisions[0]?.version ?? 0,
      responseCap: form.response_cap,
      // The full instant, not a date. The browser turns it into the local
      // wall-clock value the `datetime-local` input wants, because only the
      // browser knows what zone "5pm" means to the person reading it — the
      // server rendering that string would be answering in ITS zone and
      // silently moving the deadline for everyone else.
      closesAtIso: form.closes_at ? form.closes_at.toISOString() : '',
      allowMultiple: form.allow_multiple,
    },
    fields: fieldsOf(form.draft_fields),
    scopes: {
      tags: tags.map(tag => ({ id: tag.id, name: tag.name })),
      repositories: repositories
        .filter(repo => repo.type === 'GROUP')
        .map(repo => ({ id: repo.id, title: repo.title })),
    } satisfies ScopeChoices,
  };
};

export const action = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const classroomSlug = params.classroomSlug!;
  const { classroom, userId, membership } = await assertFormAdmin(classroomSlug, request, {
    action: 'edit_form',
  });

  const blocked = formMutationBlocked(classroom, membership.role);
  if (blocked) return blocked;

  const body = (await request.json()) as {
    intent?: string;
    fields?: unknown;
    title?: string;
    access?: FormAccess;
    responseCap?: number | null;
    closesAt?: string | null;
    allowMultiple?: boolean;
  };

  // Resolve by (classroom, slug), never by an id from the request body: the
  // form is addressed by the same pair the URL was authorized against, so a
  // form in another classroom is unreachable from here by construction.
  const form = await ClassmojiService.form.findBySlug(classroom.id, params.formSlug!);
  if (!form) throw new Response('Form not found', { status: 404 });

  const audit = (action: 'UPDATE', tool: string, data: Record<string, unknown> = {}) =>
    ClassmojiService.audit.create({
      user_id: userId,
      classroom_id: classroom.id,
      role: membership.role,
      resource_type: 'FORMS',
      resource_id: form.id,
      action,
      data: { tool, slug: form.slug, ...data },
    });

  try {
    switch (body.intent) {
      case 'save-fields': {
        await ClassmojiService.form.update(form.id, { fields: body.fields });
        await audit('UPDATE', 'forms.builder.save-fields');
        return { ok: true, savedAt: new Date().toISOString() };
      }

      case 'publish': {
        // A draft with unsaved edits must be written before it is snapshotted,
        // or Publish would quietly ship the previously saved list.
        if (body.fields !== undefined) {
          await ClassmojiService.form.update(form.id, { fields: body.fields });
        }
        const { revision } = await ClassmojiService.form.publish(form.id);
        await audit('UPDATE', 'forms.builder.publish', { version: revision.version });
        return { ok: true, published: true, version: revision.version };
      }

      case 'new-version': {
        // ONE service call, one transaction, one row lock.
        //
        // This used to be three un-transacted calls — DRAFT, save fields,
        // publish — under a comment claiming that running all three "here" kept
        // a failure from stranding the form. It did not: three writes in one
        // request handler are not three writes in one transaction, and a throw
        // between the first and the third left a LIVE form sitting in DRAFT,
        // which 404s for every filler until someone thinks to press Publish
        // again. `publishNewVersion` leaves the form on the old revision or on
        // the new one, and there is no third outcome.
        const { revision } = await ClassmojiService.form.publishNewVersion(form.id, body.fields);
        await audit('UPDATE', 'forms.builder.new-version', { version: revision.version });
        return { ok: true, published: true, version: revision.version };
      }

      case 'save-meta': {
        await ClassmojiService.form.update(form.id, {
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.access !== undefined ? { access: body.access } : {}),
          ...(body.responseCap !== undefined ? { response_cap: body.responseCap } : {}),
          ...(body.closesAt !== undefined
            ? { closes_at: body.closesAt ? new Date(body.closesAt) : null }
            : {}),
          ...(body.allowMultiple !== undefined ? { allow_multiple: body.allowMultiple } : {}),
        });
        await audit('UPDATE', 'forms.builder.save-meta');
        return { ok: true, savedAt: new Date().toISOString() };
      }

      default:
        return { error: 'Unknown intent' };
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    // Every one of these is a rule the service owns and the UI should explain
    // rather than re-implement.
    if (
      code === 'FORM_NOT_DRAFT' ||
      code === 'FORM_ACCESS_FROZEN' ||
      code === 'FORM_NO_FIELDS' ||
      code === 'FORM_DEFINITION_INVALID' ||
      code === 'FORM_DEFINITION_TOO_LARGE' ||
      code === 'FORM_FIELD_ACCESS_VIOLATION'
    ) {
      return { error: (error as Error).message };
    }
    throw error;
  }
};

export default function FormBuilder() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{
    error?: string;
    ok?: boolean;
    published?: boolean;
    version?: number;
    savedAt?: string;
  }>();

  const [fields, setFields] = useState<FormField[]>(data.fields as FormField[]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [title, setTitle] = useState(data.form.title);

  /**
   * The close time, as local wall-clock text.
   *
   * Starts EMPTY and is filled in on mount rather than rendered from the
   * loader: the conversion needs the browser's zone, which the server does not
   * have, so rendering it server-side would be a hydration mismatch on every
   * form that has a close time — and React would silently keep whichever value
   * it happened to prefer.
   */
  const [closesAt, setClosesAt] = useState('');
  useEffect(() => {
    setClosesAt(toLocalInput(data.form.closesAtIso));
  }, [data.form.closesAtIso]);

  const status = data.form.status;
  const isDraft = status === 'DRAFT';
  const access = data.form.access;
  const busy = fetcher.state !== 'idle';

  /**
   * The intent of the last action posted from this page.
   *
   * React Router revalidates every loaded route after ANY fetcher action, and
   * the loader hands back a fresh `fields` array each time — a new reference
   * even when the stored draft is byte-identical. So the effect below fires
   * after a settings save too, and without this guard it would overwrite the
   * instructor's unsaved field edits with the last SAVED draft: type a
   * question, tab out of the response-cap box, and the question is gone. A
   * metadata save touches no field list, so it must not adopt one.
   */
  const lastIntent = useRef<string | null>(null);

  // After a field-list write (save / publish / new version) the server's list
  // is authoritative — adopt it and drop the dirty flag rather than leaving the
  // pane claiming unsaved edits it has already stored.
  useEffect(() => {
    if (lastIntent.current === 'save-meta') return;
    setFields(data.fields as FormField[]);
    setDirty(false);
  }, [data.fields]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const mutate = (next: FormField[]) => {
    setFields(next);
    setDirty(true);
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = fields.findIndex(field => field.id === active.id);
    const to = fields.findIndex(field => field.id === over.id);
    if (from === -1 || to === -1) return;
    mutate(arrayMove(fields, from, to));
  };

  const addField = (type: Parameters<typeof makeField>[0]) => {
    const field = makeField(type);
    mutate([...fields, field]);
    setExpanded(field.id);
  };

  // One cast, here: a normalized field list is `Record<string, unknown>` by
  // design (its shape is per-type), which no structural JSON type can describe.
  // The action re-parses whatever arrives through the contract anyway, so the
  // type on this boundary buys nothing the validator does not already provide.
  const post = (payload: Record<string, unknown>) => {
    lastIntent.current = String(payload.intent ?? '');
    fetcher.submit(payload as SubmitTarget, { method: 'post', encType: 'application/json' });
  };

  const save = () => post({ intent: 'save-fields', fields });
  const publish = () => post({ intent: 'publish', fields });

  // Asked in-app rather than by the browser — see `ConfirmDialog`. The toolbar
  // button opens the dialog; only the dialog's confirm posts.
  const [askNewVersion, setAskNewVersion] = useState(false);

  const newVersion = () => {
    setAskNewVersion(false);
    post({ intent: 'new-version', fields });
  };

  const saveTitle = () => {
    if (title.trim() && title !== data.form.title)
      post({ intent: 'save-meta', title: title.trim() });
  };

  const paletteNote = useMemo(
    () =>
      access === 'PUBLIC'
        ? 'Roster-sourced field types unlock when access is Classroom — and the server rejects them on a public form whatever the browser sends.'
        : 'All field types are available on a classroom form.',
    [access]
  );

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link
            to={`/${data.classroomSlug}/forms`}
            className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            ← Forms
          </Link>
          <input
            value={title}
            onChange={event => setTitle(event.target.value)}
            onBlur={saveTitle}
            aria-label="Form title"
            className="block w-full max-w-lg border-none bg-transparent p-0 text-xl font-bold text-gray-900 focus:outline-none dark:text-white"
          />
          <div className="text-xs text-gray-400">
            /{data.form.slug}
            {data.form.published
              ? ` · published version ${data.form.version}`
              : ' · never published'}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {isDraft ? (
            <>
              <button
                type="button"
                onClick={save}
                disabled={busy || !dirty}
                className="rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 disabled:opacity-40 dark:border-gray-600 dark:text-gray-200"
              >
                {dirty ? 'Save draft' : 'Saved'}
              </button>
              <button
                type="button"
                onClick={publish}
                disabled={busy || fields.length === 0}
                title={fields.length === 0 ? 'Add at least one field first' : undefined}
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-gray-900"
              >
                {data.form.published ? 'Publish new version' : 'Publish'}
              </button>
            </>
          ) : (
            <>
              <span
                className="rounded-md border border-gray-200 px-3 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400"
                title="A published form's questions are frozen. Publishing again creates a new version."
              >
                Save is off while this form is {status.toLowerCase()}
              </span>
              <button
                type="button"
                onClick={() => setAskNewVersion(true)}
                disabled={busy || fields.length === 0}
                className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-gray-900"
              >
                Publish new version
              </button>
            </>
          )}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm dark:border-gray-700">
        <span className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Access
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            access === 'PUBLIC'
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200'
              : 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200'
          }`}
        >
          {access === 'PUBLIC' ? 'Public link' : 'Classroom'}
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {access === 'PUBLIC'
            ? 'anyone with the link · identity is their email, verified by a link'
            : 'members only, signed in · identity comes from the session'}
        </span>
        {isDraft ? (
          <button
            type="button"
            onClick={() =>
              post({ intent: 'save-meta', access: access === 'PUBLIC' ? 'CLASSROOM' : 'PUBLIC' })
            }
            disabled={busy}
            className="ml-auto text-xs font-medium text-blue-600 hover:underline disabled:opacity-40 dark:text-blue-400"
          >
            Switch to {access === 'PUBLIC' ? 'Classroom' : 'Public link'}
          </button>
        ) : (
          <span className="ml-auto flex items-center gap-1 text-xs text-gray-400">
            <IconLock size={13} /> Frozen — responses under two identity modes cannot be mixed
          </span>
        )}
      </div>

      {/* Collection settings. Unlike the field list these are NOT frozen by
          publishing — `update` only refuses `fields` and `access` on a live
          form — so closing a form early or lifting a cap needs no new version.

          Each posts on BLUR, and only when the value actually changed: an
          unguarded blur would write an audit row saying the instructor edited
          the form when they only tabbed through it, and trigger a revalidation
          for nothing. */}
      {/* Laid out as a grid of THREE FIXED SLOTS per column — label, control,
          help — top-aligned, with the help slot always rendered even when it is
          empty.

          It used to be `items-end` with the help text tucked inside the Closes
          label, and so the row re-laid itself out the moment a close time was
          set: "Your local time" appeared, the Closes column grew, and because
          the columns were bottom-aligned the Closes label and input jumped
          UPWARD out of line with the response cap and the checkbox beside them.
          Top-aligning fixes the jump; reserving the help slot's height keeps
          the bordered box itself from changing height too. */}
      <div className="mb-5 flex flex-wrap items-start gap-4 rounded-lg border border-gray-200 px-3 py-2.5 dark:border-gray-700">
        <div>
          <label
            htmlFor="form-closes-at"
            className="block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
          >
            Closes
          </label>
          <input
            id="form-closes-at"
            type="datetime-local"
            value={closesAt}
            onChange={event => setClosesAt(event.target.value)}
            onBlur={event => {
              const next = event.target.value;
              if (next === toLocalInput(data.form.closesAtIso)) return;
              // An INSTANT goes to the server. `new Date('2026-01-12T17:00')`
              // is parsed in the browser's zone, which is the zone the
              // instructor typed in; sending the bare local string instead
              // would be re-parsed in the SERVER's zone and land hours off.
              post({
                intent: 'save-meta',
                closesAt: next ? new Date(next).toISOString() : null,
              });
            }}
            className="mt-1 block rounded-md border border-gray-300 bg-white px-2 py-1 text-sm normal-case tracking-normal text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
          />
          {/* Always rendered, conditionally filled — see the note above. */}
          <span className="mt-1 block h-4 text-[11px] leading-4 text-gray-400">
            {closesAt ? 'Your local time' : null}
          </span>
        </div>
        <div>
          <label
            htmlFor="form-response-cap"
            className="block text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
          >
            Response cap
          </label>
          <input
            id="form-response-cap"
            type="number"
            min={1}
            placeholder="none"
            defaultValue={data.form.responseCap ?? ''}
            onBlur={event => {
              if (event.target.value === String(data.form.responseCap ?? '')) return;
              post({
                intent: 'save-meta',
                responseCap: event.target.value === '' ? null : Number(event.target.value),
              });
            }}
            className="mt-1 block w-28 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm normal-case tracking-normal text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
          />
          <span className="mt-1 block h-4" />
        </div>
        <div>
          {/* This column has no label of its own — the checkbox carries its own
              text — so it takes an empty one, and the transparent border plus
              the same `py-1` as the inputs beside it makes the control row
              exactly their height. Without the spacer the checkbox would sit a
              label's height above the two inputs. */}
          <span className="block h-4" aria-hidden="true" />
          <label className="mt-1 flex items-center gap-2 border border-transparent py-1 text-sm text-gray-700 dark:text-gray-200">
            <input
              type="checkbox"
              defaultChecked={data.form.allowMultiple}
              onChange={event => post({ intent: 'save-meta', allowMultiple: event.target.checked })}
            />
            Let one person submit more than once
          </label>
          <span className="mt-1 block h-4" />
        </div>
      </div>

      {fetcher.data?.error ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          {fetcher.data.error}
        </div>
      ) : null}
      {fetcher.data?.published ? (
        <div
          role="status"
          className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
        >
          Published as version {fetcher.data.version}. Responses already collected keep the version
          they were filled against.
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext
              items={fields.map(field => field.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-2">
                {fields.map(field => (
                  <FieldCard
                    key={field.id}
                    field={field}
                    scopes={data.scopes as ScopeChoices}
                    expanded={expanded === field.id}
                    onToggle={() =>
                      setExpanded(current => (current === field.id ? null : field.id))
                    }
                    onChange={patch =>
                      mutate(
                        fields.map(other =>
                          other.id === field.id ? ({ ...other, ...patch } as FormField) : other
                        )
                      )
                    }
                    onRemove={() => mutate(fields.filter(other => other.id !== field.id))}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>

          {fields.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 py-10 text-center text-sm text-gray-400 dark:border-gray-600">
              No fields yet — add one below.
            </div>
          ) : null}

          <div className="mt-6">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
              Add a field
            </div>
            <div className="flex flex-wrap gap-1.5">
              {FIELD_TYPE_META.map(meta => {
                // The lock mirrors the registry's `classroomOnly` flag, which is
                // the same flag `assertFieldsAllowedForAccess` refuses a save
                // on. The UI never decides this independently.
                const locked = meta.classroomOnly && access === 'PUBLIC';
                return (
                  <button
                    key={meta.type}
                    type="button"
                    disabled={locked}
                    onClick={() => addField(meta.type)}
                    title={
                      locked
                        ? `${meta.label} reads the roster, which only a classroom form can do.`
                        : meta.hint
                    }
                    className={`flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs ${
                      locked
                        ? 'cursor-not-allowed border-gray-200 text-gray-300 dark:border-gray-700 dark:text-gray-600'
                        : 'border-gray-200 text-gray-700 hover:border-gray-400 dark:border-gray-700 dark:text-gray-200'
                    }`}
                  >
                    {locked ? <IconLock size={11} /> : <IconPlus size={11} />}
                    {meta.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{paletteNote}</p>
          </div>
        </div>

        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Live preview
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <FormPreview fields={fields} />
          </div>
          <p className="mt-2 text-xs text-gray-400">
            An approximation — the controls here do nothing. Open the form itself to fill it in.
          </p>
        </aside>
      </div>

      <ConfirmDialog
        open={askNewVersion}
        title="Publishing creates a new version of this form"
        body={[
          'Responses already collected keep the version they were filled against.',
          'Anyone with the form open will be asked to reload before they can submit.',
        ]}
        confirmLabel="Publish new version"
        busy={busy}
        onConfirm={newVersion}
        onCancel={() => setAskNewVersion(false)}
      />
    </div>
  );
}
