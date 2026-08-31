import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, data, useFetcher, useLoaderData } from 'react-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { IconDownload, IconSearch, IconTrash, IconX } from '@tabler/icons-react';
import type { FormField } from '@classmoji/services/form-contract';

import AnswerView from '~/components/forms/AnswerView.tsx';
import { ConfirmDialog } from '~/components/forms/ConfirmDialog.tsx';
import { answerColumnFields, formatAnswer } from '~/components/forms/answerFormat.ts';
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
/**
 * The ceiling on any one cell — an answer, a note, a question label.
 *
 * A `<td>` will not honour `max-width` under `table-layout: auto`, so the cap
 * has to live on a block INSIDE the cell; that is what every `CellText` below
 * is for. Without it one long-text answer sets the column's width to its own
 * `max-content` and drags the whole table past its container, which is half of
 * why this table needed to be scrolled at all.
 */
const CELL_CLAMP = 'block max-w-48 truncate';
/**
 * The same cap for the identity columns, which get a little more room: an email
 * address is how a response is recognised, and clipping it earlier than the
 * answers costs more than it saves.
 */
const IDENTITY_CLAMP = 'block max-w-56 truncate';
/**
 * And a tighter one for the HEADERS, because a question is a sentence. "How
 * familiar are you with the material?" was setting a 256px column over a cell
 * reading "7 / 10" — the header, not the data, was most of the table's width.
 */
const HEADER_CLAMP = 'block max-w-40 truncate';

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
  // value, MINUS the ones already standing as the Name and Email columns. A
  // matrix or a review block cannot be a column, and a form with twenty
  // questions would produce an unreadable table — the drawer is where the whole
  // response lives. See `answerColumnFields` for why the identity fields come
  // out.
  const answerColumns = useMemo(
    () => answerColumnFields(currentFields as FormField[], MAX_ANSWER_COLUMNS),
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

  /**
   * `max-w-[96rem]`, wider than the rest of the forms admin (`max-w-7xl`), and
   * only on this page.
   *
   * This one is a data grid, not a document: identity, up to three answers, a
   * timestamp and two triage columns. At `max-w-7xl` the waitlist overflowed its
   * own container on a 1440-wide laptop by about 80px — enough to slice the Note
   * column off, nothing like enough to be worth scrolling for. The cap only
   * binds above roughly a 1330px viewport; below that the shell is viewport-
   * bound and this changes nothing.
   */
  return (
    <div className="mx-auto max-w-[96rem] px-6 py-8">
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
                    {/* A question is a whole sentence — "How familiar are you
                        with the material?" — and left to wrap it makes a header
                        three lines tall, or left to run it makes the column as
                        wide as the sentence. One clamped line, with the wording
                        intact on hover. */}
                    <span className={HEADER_CLAMP} title={heading}>
                      {heading}
                    </span>
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

/** Popover width, and the breathing room kept between it and the viewport edge. */
const POPOVER_WIDTH = 208;
const VIEWPORT_MARGIN = 8;
/** Popover-to-anchor gap. */
const ANCHOR_GAP = 4;

interface PopoverPlacement {
  left: number;
  /** Exactly one of these is set — `bottom` is the flipped-above case. */
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * Where a dropdown anchored to `anchor` goes, in VIEWPORT coordinates.
 *
 * Viewport coordinates because the layer is `position: fixed` and lives in a
 * portal on `document.body` — see `SuggestionPopover` for why it has to.
 *
 * It never measures the popover, and so never has to render it once to find out
 * where to put it. Instead it hands the popover the space that is actually
 * there: whichever side of the anchor has more room, and `maxHeight` set to
 * that room. A list too long for the space scrolls inside itself rather than
 * running off the screen, which makes "is it visible" true by construction
 * instead of true by arithmetic that a short window would get wrong.
 */
function placePopover(anchor: DOMRect): PopoverPlacement {
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(anchor.left, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN)
  );
  const below = window.innerHeight - anchor.bottom - ANCHOR_GAP - VIEWPORT_MARGIN;
  const above = anchor.top - ANCHOR_GAP - VIEWPORT_MARGIN;

  // The LAST ROW of a long table is the case this exists for: below the anchor
  // there is nothing left, so the list opens upward.
  return below >= above
    ? { left, top: anchor.bottom + ANCHOR_GAP, maxHeight: Math.max(below, 0) }
    : { left, bottom: window.innerHeight - anchor.top + ANCHOR_GAP, maxHeight: Math.max(above, 0) };
}

/**
 * Two placements that would paint identically.
 *
 * This is what lets `place()` be called after EVERY render without looping: a
 * fresh object from `placePopover` is never `===` the one in state, so an
 * unguarded `setPlacement` would re-render, re-run the effect, and set state
 * again forever. Comparing by value makes the update idempotent, which in turn
 * means the effect that keeps the list pinned as it filters needs no dependency
 * array to get right.
 */
const samePlacement = (a: PopoverPlacement | null, b: PopoverPlacement): boolean =>
  a !== null &&
  a.left === b.left &&
  a.top === b.top &&
  a.bottom === b.bottom &&
  a.maxHeight === b.maxHeight;

/**
 * The suggestion list, rendered into `document.body` rather than beside its
 * input.
 *
 * The table it sits in scrolls sideways (`overflow-x-auto`), and a scroll
 * container clips in BOTH axes — a browser cannot offer a horizontal scrollbar
 * and still let content spill out vertically. So an absolutely-positioned
 * dropdown on the last row was sliced off at the container's bottom edge, which
 * is exactly what Tim's screenshot shows: the control still worked, but nobody
 * could see what they were choosing. No amount of `z-index` fixes that; `z-index`
 * orders painting, and this is clipping.
 *
 * A portal takes the layer out of the clipping ancestor entirely, and `fixed`
 * positioning re-anchors it to the input by measurement. React events still
 * bubble through the REACT tree, so the wrapper's `stopPropagation` keeps a
 * click in here from also opening the row's drawer.
 *
 * `z-50` puts it over the response drawer (`z-40`), which is the other place a
 * `StatusCell` is edited.
 */
function SuggestionPopover({
  anchorRef,
  children,
}: {
  anchorRef: React.RefObject<HTMLInputElement | null>;
  children: React.ReactNode;
}) {
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const next = placePopover(anchor.getBoundingClientRect());
    setPlacement(current => (samePlacement(current, next) ? current : next));
  }, [anchorRef]);

  // `useLayoutEffect` so the first paint is already in the right place — a
  // frame at the window's top-left corner is a visible jump.
  //
  // No dependency array: the anchor also moves when the TABLE re-lays out (a
  // row committed, the filter narrowed the list), and re-measuring after every
  // render is both the simplest way to catch that and — because `place` bails
  // when nothing moved — a fixed point rather than a loop.
  useLayoutEffect(place);

  useLayoutEffect(() => {
    // Capture phase: the scroll that moves this anchor is the TABLE's, not the
    // window's, and a bubbling listener on window never hears it.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [place]);

  // Nothing to portal into during SSR. In practice this control only ever
  // mounts from a click, but a null first render costs nothing and makes that
  // an invariant rather than a habit.
  if (typeof document === 'undefined' || !placement) return null;

  return createPortal(
    <div
      data-status-suggestions
      // A mousedown on the list's own SCROLLBAR lands on this div, not on one of
      // the buttons — none of their `preventDefault` runs, the input blurs, and
      // the 150ms cancel closes the list out from under the drag. Only reachable
      // once the list is taller than the space it was given, which is precisely
      // the short-viewport case the flip exists for.
      onMouseDown={event => event.preventDefault()}
      style={{
        position: 'fixed',
        left: placement.left,
        top: placement.top,
        bottom: placement.bottom,
        width: POPOVER_WIDTH,
        maxHeight: placement.maxHeight,
      }}
      className="z-50 overflow-y-auto rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
    >
      {children}
    </div>,
    document.body
  );
}

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
      <SuggestionPopover anchorRef={inputRef}>
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
      </SuggestionPopover>
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
        className="w-56 max-w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
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
          ? `${CELL_CLAMP} text-left text-xs text-gray-600 dark:text-gray-300`
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
          {/* Clamped like every other cell: `extractIdentity` bounds a name at
              MAX_LABEL_CHARS, which is long enough that one pasted paragraph
              would set this column's width for the whole table. */}
          <span
            title={row.name || undefined}
            className={`${IDENTITY_CLAMP} text-sm font-medium ${
              partial ? '' : 'text-gray-900 dark:text-white'
            }`}
          >
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
      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
        <span className={IDENTITY_CLAMP} title={row.email}>
          {row.email}
        </span>
      </td>
      {answerColumns.map(field => {
        const text = formatAnswer(field, row.answers?.[field.id]);
        return (
          <td key={field.id} className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
            <span className={CELL_CLAMP} title={text || undefined}>
              {text}
            </span>
          </td>
        );
      })}
      <td
        className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400"
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
