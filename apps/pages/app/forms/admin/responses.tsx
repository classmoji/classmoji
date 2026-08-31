import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, data, useFetcher, useLoaderData } from 'react-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { IconDownload, IconSearch, IconTrash, IconX } from '@tabler/icons-react';
import type { FormField } from '@classmoji/services/form-contract';

import AnswerView from '~/components/forms/AnswerView.tsx';
import { ConfirmDialog } from '~/components/forms/ConfirmDialog.tsx';
import { formatAnswer, isScalarField } from '~/components/forms/answerFormat.ts';
import { ClassmojiService } from '~/utils/db.server.ts';
import { formMutationBlocked } from '~/utils/formAuth.server.ts';
import { hasRepeatGroup } from './responsesCsv.server.ts';
import {
  NO_STORE,
  auditResponses,
  loadResponseRows,
  requireFormForResponses,
  scopeResponseIds,
  type ResponseRow,
} from './responsesData.server.ts';

dayjs.extend(relativeTime);

/**
 * The staff responses surface: every submission to one form, with generic
 * triage.
 *
 * ── Generic, deliberately ──────────────────────────────────────────────────
 * There are no form types, so there is no per-type workflow UI. Triage is two
 * free-text staff-only columns on every response — a `staff_status` label and a
 * `staff_note` — and the stat tiles are nothing but counts per label. A course
 * that works its waitlist with "responded to / on roster / not eligible" and a
 * course that works a survey with "follow up" get the same surface; neither
 * label set is written down anywhere in this file. Suggestions come from the
 * labels already used ON THIS FORM, which is the only place they exist.
 *
 * Neither column is ever visible to the person who filled the form: the service's
 * self-read select omits them on every filler-facing path, including the
 * magic-link review page.
 *
 * ── PII posture ────────────────────────────────────────────────────────────
 * `no-store` on the loader (which covers the single-fetch `.data` request) and
 * re-emitted from `headers` (which covers the document). Every view, export,
 * triage edit and delete writes an audit row. This surface exists BEFORE the
 * public fill route by design — never collect what you cannot yet inspect and
 * delete.
 */

/** How many responses one bulk action may touch. */
const MAX_BULK = 200;
/** Answer columns in the table; everything else lives in the drawer. */
const MAX_ANSWER_COLUMNS = 3;

export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const context = await requireFormForResponses(
    params.classroomSlug!,
    params.formSlug!,
    request,
    'list_responses'
  );

  const [rows, suggestions] = await Promise.all([
    loadResponseRows(context.form.id),
    ClassmojiService.formResponse.statusLabelSuggestions(context.form.id),
  ]);

  await auditResponses({
    context,
    tool: 'forms.responses.view',
    action: 'VIEW',
    data: { count: rows.length },
  });

  return data(
    {
      classroomSlug: params.classroomSlug!,
      form: context.form,
      rows,
      suggestions,
      currentFields: context.currentFields,
      fieldsByRevision: context.fieldsByRevision,
      offersLongExport: hasRepeatGroup(context.currentFields),
    },
    { headers: NO_STORE }
  );
};

/** Re-emit the loader's `no-store` on the document response too. */
export const headers = ({ loaderHeaders }: { loaderHeaders: Headers }) => loaderHeaders;

interface ActionBody {
  intent?: string;
  responseIds?: string[];
  status?: string | null;
  note?: string | null;
}

export const action = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const context = await requireFormForResponses(
    params.classroomSlug!,
    params.formSlug!,
    request,
    'triage_responses'
  );

  // Same classroom-status gate the phase-2 form mutations use: a LOCKED or
  // UNPUBLISHED classroom is read-only for everyone but its owner, and a triage
  // label is classroom data like any other.
  const blocked = formMutationBlocked(context.classroom, context.membership.role);
  if (blocked) return blocked;

  const body = (await request.json()) as ActionBody;
  const requested = Array.isArray(body.responseIds) ? body.responseIds.slice(0, MAX_BULK) : [];
  // The ids came from a browser. Narrowing them to this form is what keeps a
  // response id from another classroom's form out of every call below.
  const ids = await scopeResponseIds(context.form.id, requested);
  if (ids.length === 0) return { error: 'No matching responses.' };

  if (body.intent === 'set-status' || body.intent === 'set-note') {
    const patch =
      body.intent === 'set-status'
        ? { staff_status: body.status ?? null }
        : { staff_note: body.note ?? null };

    for (const responseId of ids) {
      await ClassmojiService.formResponse.updateStaff({ responseId, ...patch });
      await auditResponses({
        context,
        tool: 'forms.responses.staff_update',
        action: 'UPDATE',
        responseId,
        data: patch,
      });
    }
    return { ok: true, updated: ids.length };
  }

  if (body.intent === 'delete') {
    for (const responseId of ids) {
      await ClassmojiService.formResponse.deleteResponse(responseId);
      // The one act here that destroys collected PII. The audit row is the only
      // record that it happened.
      await auditResponses({
        context,
        tool: 'forms.responses.delete',
        action: 'DELETE',
        responseId,
      });
    }
    return { ok: true, deleted: ids.length };
  }

  return { error: 'Unknown intent' };
};

// ─── Presentation helpers ───────────────────────────────────────────────────

/** A partial row is a submission in progress, not a response. */
const PARTIAL_STATES = new Set(['DRAFT', 'PENDING_VERIFICATION']);

const STATE_CHIP: Record<string, { label: string; title: string }> = {
  DRAFT: { label: 'Partial', title: 'Saved as the person typed; never submitted.' },
  PENDING_VERIFICATION: {
    label: 'Unverified',
    title: 'Submitted, but the email address was never confirmed.',
  },
};

const absolute = (iso: string) => dayjs(iso).format('MMM D, YYYY h:mm A');

// ─── Route component ────────────────────────────────────────────────────────

export default function FormResponses() {
  const {
    classroomSlug,
    form,
    rows,
    suggestions,
    currentFields,
    fieldsByRevision,
    offersLongExport,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ error?: string; ok?: boolean }>();

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [bulkStatusOpen, setBulkStatusOpen] = useState(false);

  // The answer columns: the first few TOP-LEVEL fields with a single readable
  // value. A matrix or a review block cannot be a column, and a form with
  // twenty questions would produce an unreadable table — the drawer is where
  // the whole response lives.
  const answerColumns = useMemo(
    () => (currentFields as FormField[]).filter(isScalarField).slice(0, MAX_ANSWER_COLUMNS),
    [currentFields]
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      row =>
        (row.name ?? '').toLowerCase().includes(needle) || row.email.toLowerCase().includes(needle)
    );
  }, [rows, query]);

  // Tiles describe the FORM, not the current search — they are the counts an
  // instructor works the queue against.
  const tiles = useMemo(() => {
    const submitted = rows.filter(row => !PARTIAL_STATES.has(row.submissionState));
    const byLabel = new Map<string, number>();
    let noStatus = 0;
    for (const row of submitted) {
      if (row.staffStatus) byLabel.set(row.staffStatus, (byLabel.get(row.staffStatus) ?? 0) + 1);
      else noStatus += 1;
    }
    const partial = rows.filter(row => row.submissionState === 'DRAFT').length;
    const unverified = rows.filter(row => row.submissionState === 'PENDING_VERIFICATION').length;

    return [
      { key: 'total', label: 'Responses', count: submitted.length, accent: true },
      { key: 'none', label: 'No status', count: noStatus, accent: false },
      ...[...byLabel.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([label, count]) => ({ key: `s:${label}`, label, count, accent: false })),
      ...(partial ? [{ key: 'partial', label: 'Partial', count: partial, accent: false }] : []),
      ...(unverified
        ? [{ key: 'unverified', label: 'Unverified', count: unverified, accent: false }]
        : []),
    ];
  }, [rows]);

  const open = rows.find(row => row.id === openId) ?? null;

  const submit = (body: Record<string, unknown>) =>
    fetcher.submit(body as never, { method: 'post', encType: 'application/json' });

  const setStatus = (ids: string[], status: string | null) =>
    submit({ intent: 'set-status', responseIds: ids, status });

  const setNote = (id: string, note: string | null) =>
    submit({ intent: 'set-note', responseIds: [id], note });

  // The ids a delete has been REQUESTED for and not yet confirmed. Keeping the
  // whole array (rather than a boolean) is what preserves the single-vs-bulk
  // wording, and means the bulk bar and the drawer share one dialog.
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);

  // Only reached through the dialog.
  const remove = (ids: string[]) => {
    setPendingDelete(null);
    submit({ intent: 'delete', responseIds: ids });
    setSelected(new Set());
    if (openId && ids.includes(openId)) setOpenId(null);
  };

  const toggle = (id: string) =>
    setSelected(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allVisibleSelected = visible.length > 0 && visible.every(row => selected.has(row.id));
  const selectedIds = [...selected];

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-base font-semibold text-gray-600 dark:text-gray-400">
          <Link
            to={`/${classroomSlug}/forms`}
            className="hover:text-gray-900 dark:hover:text-white"
          >
            Forms
          </Link>
          <span className="mx-1.5 text-gray-300 dark:text-gray-600">/</span>
          <Link
            to={`/${classroomSlug}/forms/${form.slug}/edit`}
            className="text-gray-900 hover:text-blue-600 dark:text-white dark:hover:text-blue-400"
          >
            {form.title}
          </Link>
          <span className="mx-1.5 text-gray-300 dark:text-gray-600">/</span>
          Responses
        </h1>

        <div className="flex items-center gap-2">
          <div className="relative">
            <IconSearch
              size={15}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search responses…"
              aria-label="Search responses by name or email"
              className="w-60 rounded-lg border border-gray-200 bg-white py-2 pl-8 pr-3 text-sm text-gray-900 placeholder:text-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </div>
          <ExportButton
            classroomSlug={classroomSlug}
            formSlug={form.slug}
            kind="wide"
            label="Export CSV"
          />
          {offersLongExport ? (
            <ExportButton
              classroomSlug={classroomSlug}
              formSlug={form.slug}
              kind="long"
              label="Export reviews"
            />
          ) : null}
        </div>
      </div>

      {fetcher.data?.error ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {fetcher.data.error}
        </div>
      ) : null}

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tiles.map(tile => (
          <div
            key={tile.key}
            className="rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900"
          >
            <div
              className={`text-2xl font-semibold ${
                tile.accent ? 'text-gray-900 dark:text-white' : 'text-gray-700 dark:text-gray-200'
              }`}
            >
              {tile.count}
            </div>
            <div className="truncate text-xs text-gray-500 dark:text-gray-400" title={tile.label}>
              {tile.label}
            </div>
          </div>
        ))}
      </div>

      {selectedIds.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm dark:border-blue-900 dark:bg-blue-950">
          <span className="font-medium text-blue-900 dark:text-blue-200">
            {selectedIds.length} selected
          </span>
          <span className="text-blue-300 dark:text-blue-800">·</span>
          {bulkStatusOpen ? (
            <StatusEditor
              suggestions={suggestions}
              initial=""
              onCommit={next => {
                setStatus(selectedIds, next);
                setBulkStatusOpen(false);
                setSelected(new Set());
              }}
              onCancel={() => setBulkStatusOpen(false)}
            />
          ) : (
            <button
              type="button"
              onClick={() => setBulkStatusOpen(true)}
              className="rounded-md border border-blue-300 bg-white px-2.5 py-1 text-xs font-medium text-blue-900 dark:border-blue-800 dark:bg-blue-900 dark:text-blue-100"
            >
              Set status ▾
            </button>
          )}
          <ExportButton
            classroomSlug={classroomSlug}
            formSlug={form.slug}
            kind="wide"
            label="Export selection"
            ids={selectedIds}
            small
          />
          <button
            type="button"
            onClick={() => setPendingDelete(selectedIds)}
            className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
          >
            Delete
          </button>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 py-16 text-center dark:border-gray-700">
          <div className="font-medium text-gray-700 dark:text-gray-200">No responses yet</div>
          <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {form.status === 'OPEN'
              ? 'Share the form link and answers will land here.'
              : 'Open the form to start collecting answers.'}
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="w-10 px-3 py-3">
                  <input
                    type="checkbox"
                    aria-label="Select every response shown"
                    checked={allVisibleSelected}
                    onChange={() =>
                      setSelected(
                        allVisibleSelected ? new Set() : new Set(visible.map(row => row.id))
                      )
                    }
                  />
                </th>
                {[
                  'Name',
                  'Email',
                  ...answerColumns.map(field => String(field.label ?? '')),
                  'Submitted',
                  'Status',
                  'Note',
                ].map((heading, index) => (
                  <th
                    key={`${heading}-${index}`}
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  >
                    {heading}
                  </th>
                ))}
                <th className="px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {visible.map(row => (
                <ResponseTableRow
                  key={row.id}
                  row={row}
                  answerColumns={answerColumns}
                  suggestions={suggestions}
                  checked={selected.has(row.id)}
                  onToggle={() => toggle(row.id)}
                  onOpen={() => setOpenId(row.id)}
                  onStatus={next => setStatus([row.id], next)}
                  onNote={next => setNote(row.id, next)}
                  onDelete={() => setPendingDelete([row.id])}
                />
              ))}
              {visible.length === 0 ? (
                <tr>
                  <td
                    colSpan={answerColumns.length + 6}
                    className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400"
                  >
                    No responses match “{query}”.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      {open ? (
        <ResponseDrawer
          row={open}
          fields={(fieldsByRevision[open.revisionId] ?? currentFields) as FormField[]}
          suggestions={suggestions}
          onClose={() => setOpenId(null)}
          onStatus={next => setStatus([open.id], next)}
          onNote={next => setNote(open.id, next)}
          onDelete={() => setPendingDelete([open.id])}
        />
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={
          pendingDelete && pendingDelete.length === 1
            ? 'Delete this response?'
            : `Delete ${pendingDelete?.length ?? 0} responses?`
        }
        body="The answers and the contact details go with it. This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        busy={fetcher.state !== 'idle'}
        onConfirm={() => pendingDelete && remove(pendingDelete)}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

// ─── Export button ──────────────────────────────────────────────────────────

/**
 * A NATIVE form post to the export resource route.
 *
 * Deliberately not a fetcher: the router would intercept the response and the
 * attachment would never reach the browser's download handling. A plain form
 * post lets the `Content-Disposition` do its job, keeps the page where it is,
 * and means the export is a server round trip — which is what makes it
 * auditable and `no-store`-able at all.
 */
function ExportButton({
  classroomSlug,
  formSlug,
  kind,
  label,
  ids,
  small = false,
}: {
  classroomSlug: string;
  formSlug: string;
  kind: 'wide' | 'long';
  label: string;
  ids?: string[];
  small?: boolean;
}) {
  return (
    <form method="post" action={`/${classroomSlug}/forms/${formSlug}/responses/export`}>
      <input type="hidden" name="kind" value={kind} />
      {(ids ?? []).map(id => (
        <input key={id} type="hidden" name="responseId" value={id} />
      ))}
      <button
        type="submit"
        className={
          small
            ? 'flex items-center gap-1.5 rounded-md border border-blue-300 bg-white px-2.5 py-1 text-xs font-medium text-blue-900 dark:border-blue-800 dark:bg-blue-900 dark:text-blue-100'
            : 'flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800'
        }
      >
        <IconDownload size={small ? 13 : 15} /> {label}
      </button>
    </form>
  );
}

// ─── Inline triage editors ──────────────────────────────────────────────────

/**
 * The status combobox: free text, with the labels already used on THIS form as
 * suggestions.
 *
 * Free entry is the feature, not a fallback. There is no status enum anywhere
 * in the stack — the workflow a course runs is the course's business — so the
 * control has to accept a word nobody has used before, and the suggestion list
 * is only there so the second person to use "responded to" spells it the same
 * way as the first.
 */
function StatusEditor({
  suggestions,
  initial,
  onCommit,
  onCancel,
}: {
  suggestions: Array<{ label: string; count: number }>;
  initial: string;
  onCommit: (next: string | null) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const matches = suggestions
    .filter(suggestion => suggestion.label.toLowerCase().includes(text.trim().toLowerCase()))
    .slice(0, 6);

  const commit = (value: string) => onCommit(value.trim() ? value.trim() : null);

  return (
    <div className="relative inline-block" onClick={event => event.stopPropagation()}>
      <input
        ref={inputRef}
        value={text}
        aria-label="Staff status"
        placeholder="Status…"
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit(text);
          }
          if (event.key === 'Escape') onCancel();
        }}
        // A blur that lands on this control's own dropdown must not cancel the
        // edit before the click registers, hence the delay.
        onBlur={() => setTimeout(onCancel, 150)}
        className="w-40 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
      />
      <div className="absolute left-0 top-full z-20 mt-1 w-52 rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900">
        {matches.map(suggestion => (
          <button
            key={suggestion.label}
            type="button"
            data-status-suggestion={suggestion.label}
            onMouseDown={event => {
              event.preventDefault();
              commit(suggestion.label);
            }}
            className="flex w-full items-center justify-between px-2.5 py-1 text-left text-xs text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            <span className="truncate">{suggestion.label}</span>
            <span className="ml-2 text-gray-400">{suggestion.count}</span>
          </button>
        ))}
        {text.trim() && !suggestions.some(item => item.label === text.trim()) ? (
          <button
            type="button"
            onMouseDown={event => {
              event.preventDefault();
              commit(text);
            }}
            className="w-full px-2.5 py-1 text-left text-xs text-blue-700 hover:bg-gray-100 dark:text-blue-300 dark:hover:bg-gray-800"
          >
            Use “{text.trim()}”
          </button>
        ) : null}
        <button
          type="button"
          onMouseDown={event => {
            event.preventDefault();
            onCommit(null);
          }}
          className="w-full border-t border-gray-100 px-2.5 py-1 text-left text-xs text-gray-500 hover:bg-gray-100 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          Clear status
        </button>
      </div>
    </div>
  );
}

function StatusCell({
  value,
  suggestions,
  onCommit,
}: {
  value: string | null;
  suggestions: Array<{ label: string; count: number }>;
  onCommit: (next: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <StatusEditor
        suggestions={suggestions}
        initial={value ?? ''}
        onCommit={next => {
          setEditing(false);
          onCommit(next);
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={event => {
        event.stopPropagation();
        setEditing(true);
      }}
      aria-label={value ? `Status: ${value}. Change it.` : 'Set a status'}
      className={
        value
          ? 'rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200'
          : 'text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
      }
    >
      {value ?? '—'}
    </button>
  );
}

function NoteCell({
  value,
  onCommit,
}: {
  value: string | null;
  onCommit: (next: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value ?? '');

  useEffect(() => setText(value ?? ''), [value]);

  if (editing) {
    return (
      <input
        autoFocus
        value={text}
        aria-label="Staff note"
        onClick={event => event.stopPropagation()}
        onChange={event => setText(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault();
            setEditing(false);
            onCommit(text.trim() ? text.trim() : null);
          }
          if (event.key === 'Escape') {
            setText(value ?? '');
            setEditing(false);
          }
        }}
        onBlur={() => {
          setEditing(false);
          if (text.trim() !== (value ?? '')) onCommit(text.trim() ? text.trim() : null);
        }}
        className="w-full min-w-40 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={event => {
        event.stopPropagation();
        setEditing(true);
      }}
      title={value ?? undefined}
      className={
        value
          ? 'block max-w-56 truncate text-left text-xs text-gray-600 dark:text-gray-300'
          : 'text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
      }
    >
      {value ?? '+ add note'}
    </button>
  );
}

// ─── Table row ──────────────────────────────────────────────────────────────

function ResponseTableRow({
  row,
  answerColumns,
  suggestions,
  checked,
  onToggle,
  onOpen,
  onStatus,
  onNote,
  onDelete,
}: {
  row: ResponseRow;
  answerColumns: FormField[];
  suggestions: Array<{ label: string; count: number }>;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onStatus: (next: string | null) => void;
  onNote: (next: string | null) => void;
  onDelete: () => void;
}) {
  const partial = PARTIAL_STATES.has(row.submissionState);
  const chip = STATE_CHIP[row.submissionState];

  return (
    <tr
      onClick={onOpen}
      className={`cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 ${
        // A partial is muted because it is not a response: it has not been
        // submitted (or not verified), and reading it as one would overstate
        // what the form has actually collected.
        partial ? 'text-gray-400 dark:text-gray-500' : ''
      }`}
    >
      <td className="px-3 py-3" onClick={event => event.stopPropagation()}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={`Select the response from ${row.name || row.email}`}
        />
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-medium ${partial ? '' : 'text-gray-900 dark:text-white'}`}>
            {row.name || '—'}
          </span>
          {chip ? (
            <span
              title={chip.title}
              className="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-600 dark:bg-gray-700 dark:text-gray-300"
            >
              {chip.label}
            </span>
          ) : null}
        </div>
      </td>
      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">{row.email}</td>
      {answerColumns.map(field => (
        <td
          key={field.id}
          className="max-w-48 truncate px-4 py-3 text-sm text-gray-600 dark:text-gray-300"
        >
          {formatAnswer(field, row.answers?.[field.id])}
        </td>
      ))}
      <td
        className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400"
        title={absolute(row.submittedAt)}
      >
        {dayjs(row.submittedAt).fromNow()}
      </td>
      <td className="px-4 py-3">
        <StatusCell value={row.staffStatus} suggestions={suggestions} onCommit={onStatus} />
      </td>
      <td className="px-4 py-3">
        <NoteCell value={row.staffNote} onCommit={onNote} />
      </td>
      <td className="px-3 py-3" onClick={event => event.stopPropagation()}>
        <button
          type="button"
          onClick={onDelete}
          title="Delete this response"
          aria-label={`Delete the response from ${row.name || row.email}`}
          className="text-gray-400 hover:text-red-600 dark:hover:text-red-400"
        >
          <IconTrash size={15} />
        </button>
      </td>
    </tr>
  );
}

// ─── Drawer ─────────────────────────────────────────────────────────────────

function ResponseDrawer({
  row,
  fields,
  suggestions,
  onClose,
  onStatus,
  onNote,
  onDelete,
}: {
  row: ResponseRow;
  fields: FormField[];
  suggestions: Array<{ label: string; count: number }>;
  onClose: () => void;
  onStatus: (next: string | null) => void;
  onNote: (next: string | null) => void;
  onDelete: () => void;
}) {
  const chip = STATE_CHIP[row.submissionState];

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Response details"
        className="relative z-10 flex h-full w-full max-w-xl flex-col overflow-y-auto bg-white shadow-xl dark:bg-gray-900"
      >
        <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-6 py-4 dark:border-gray-700">
          <div>
            <div className="text-base font-semibold text-gray-900 dark:text-white">
              {row.name || row.email}
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">{row.email}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the response"
            className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
            <IconX size={18} />
          </button>
        </div>

        <div className="border-b border-gray-200 px-6 py-4 text-sm dark:border-gray-700">
          <dl className="grid grid-cols-2 gap-y-2">
            <dt className="text-gray-500 dark:text-gray-400">Submitted</dt>
            <dd className="text-gray-800 dark:text-gray-100">{absolute(row.submittedAt)}</dd>
            <dt className="text-gray-500 dark:text-gray-400">Verified</dt>
            <dd className="text-gray-800 dark:text-gray-100">
              {row.verifiedAt ? absolute(row.verifiedAt) : '—'}
            </dd>
            <dt className="text-gray-500 dark:text-gray-400">State</dt>
            <dd className="text-gray-800 dark:text-gray-100">
              {chip ? `${chip.label} (${row.submissionState})` : row.submissionState}
            </dd>
            <dt className="text-gray-500 dark:text-gray-400">Account</dt>
            <dd className="truncate text-gray-800 dark:text-gray-100">
              {row.userId ? row.userId : 'No Classmoji account (email identity)'}
            </dd>
          </dl>
        </div>

        <div className="border-b border-gray-200 px-6 py-4 dark:border-gray-700">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-400">
            Staff only — never shown to the respondent
          </div>
          <div className="mb-3 flex items-center gap-3">
            <span className="text-sm text-gray-500 dark:text-gray-400">Status</span>
            <StatusCell value={row.staffStatus} suggestions={suggestions} onCommit={onStatus} />
          </div>
          <div className="flex items-start gap-3">
            <span className="mt-1 text-sm text-gray-500 dark:text-gray-400">Note</span>
            <div className="flex-1">
              <NoteCell value={row.staffNote} onCommit={onNote} />
            </div>
          </div>
        </div>

        <div className="flex-1 px-6 py-4">
          <AnswerView fields={fields} answers={row.answers} resolvedContext={row.resolvedContext} />
        </div>

        <div className="border-t border-gray-200 px-6 py-4 dark:border-gray-700">
          <button
            type="button"
            onClick={onDelete}
            className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950"
          >
            <IconTrash size={15} /> Delete this response
          </button>
        </div>
      </aside>
    </div>
  );
}
