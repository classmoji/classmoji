import { useMemo, useState } from 'react';
import { Link, Outlet, useFetcher, useLoaderData } from 'react-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import {
  IconCopy,
  IconExternalLink,
  IconListDetails,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
} from '@tabler/icons-react';

import { ClassmojiService, prisma } from '~/utils/db.server.ts';
import { assertFormAdmin, formMutationBlocked } from '~/utils/formAuth.server.ts';
import { ConfirmDialog } from '~/components/forms/ConfirmDialog.tsx';

dayjs.extend(relativeTime);

/**
 * The admin forms list — the landing surface behind the webapp's Forms nav
 * entry.
 *
 * Auth: `assertFormAdmin` in the loader AND in the action, not just the loader.
 * The root gate recognizes forms paths and stops requiring a session for the
 * public fill pages, which means nothing upstream of this action is checking
 * anything; a loader-only gate would leave the status select and the delete
 * button as open POST endpoints.
 */

type FormAccess = 'PUBLIC' | 'CLASSROOM';
type FormStatus = 'DRAFT' | 'OPEN' | 'CLOSED';

interface FormRow {
  id: string;
  title: string;
  slug: string;
  access: FormAccess;
  status: FormStatus;
  published: boolean;
  responses: number;
  responseCap: number | null;
  closesAt: string | null;
  updatedAt: string;
}

export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const classroomSlug = params.classroomSlug!;
  const { classroom } = await assertFormAdmin(classroomSlug, request, { action: 'list_forms' });

  const forms = await ClassmojiService.form.findByClassroomId(classroom.id);

  return {
    classroomSlug,
    classroomName: (classroom as { name?: string | null }).name ?? classroomSlug,
    // The share link is built from the host that served this request, so it is
    // right in dev, on the devport, and in production without a second env var.
    origin: new URL(request.url).origin,
    forms: forms.map(
      (form): FormRow => ({
        id: form.id,
        title: form.title,
        slug: form.slug,
        access: form.access as FormAccess,
        status: form.status as FormStatus,
        // A form that has never been published cannot legally go OPEN — the
        // select disables that option rather than letting the action explain it
        // after the fact.
        published: Boolean(form.current_revision_id),
        responses: form._count.responses,
        responseCap: form.response_cap,
        // Dates are serialized here rather than left to the transport: the
        // client formats them and should not have to care which of Date and
        // string arrived.
        closesAt: form.closes_at ? form.closes_at.toISOString() : null,
        updatedAt: form.updated_at.toISOString(),
      })
    ),
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
    action: 'mutate_form',
  });

  const body = (await request.json()) as { intent?: string; formId?: string; status?: FormStatus };
  const intent = body.intent;
  const formId = body.formId;

  if (!formId) return { error: 'Missing form id' };

  const blocked = formMutationBlocked(classroom, membership.role);
  if (blocked) return blocked;

  // Bind the record to the classroom that was authorized. Without this, a form
  // id from ANOTHER classroom would be mutated by a caller who is staff here —
  // the cross-classroom hole the MCP audit found and closed everywhere else.
  const form = await prisma.form.findUnique({
    where: { id: formId },
    select: { id: true, classroom_id: true, title: true, slug: true },
  });
  if (!form || form.classroom_id !== classroom.id) {
    return { error: 'Form not found' };
  }

  if (intent === 'update-status') {
    const status = body.status;
    if (status !== 'DRAFT' && status !== 'OPEN' && status !== 'CLOSED') {
      return { error: 'Unknown status' };
    }
    try {
      await ClassmojiService.form.quickUpdate(formId, { status });
    } catch (error) {
      // The one refusal quickUpdate makes: OPEN on a form that has never been
      // published. Surfaced as the instruction, not the error code.
      if ((error as { code?: string }).code === 'FORM_NO_FIELDS') {
        return { error: 'Publish this form before opening it.' };
      }
      throw error;
    }
    await ClassmojiService.audit.create({
      user_id: userId,
      classroom_id: classroom.id,
      role: membership.role,
      resource_type: 'FORMS',
      resource_id: formId,
      action: 'UPDATE',
      data: { tool: 'forms.list.update-status', status },
    });
    return { ok: true };
  }

  if (intent === 'delete') {
    await ClassmojiService.form.deleteForm(formId);
    // Deleting a form cascades to its responses, which is the point and also
    // why it is audited: this is the one action here that destroys collected
    // PII, and the row is the only record it happened.
    await ClassmojiService.audit.create({
      user_id: userId,
      classroom_id: classroom.id,
      role: membership.role,
      resource_type: 'FORMS',
      resource_id: formId,
      action: 'DELETE',
      data: { tool: 'forms.list.delete', title: form.title, slug: form.slug },
    });
    return { ok: true };
  }

  return { error: 'Unknown intent' };
};

const ACCESS_CHIP: Record<FormAccess, string> = {
  PUBLIC: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
  CLASSROOM: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200',
};

const STATUS_CHIP: Record<FormStatus, string> = {
  DRAFT: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  OPEN: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  CLOSED: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
};

export default function FormsList() {
  const { forms, classroomSlug, origin } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ error?: string; ok?: boolean }>();
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  // The form a delete has been REQUESTED for and not yet confirmed. Holding the
  // row (not a boolean) is what lets the dialog name the form being deleted.
  const [pendingDelete, setPendingDelete] = useState<FormRow | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return forms;
    return forms.filter(
      form => form.title.toLowerCase().includes(needle) || form.slug.toLowerCase().includes(needle)
    );
  }, [forms, query]);

  const linkFor = (form: FormRow) => `${origin}/${classroomSlug}/forms/${form.slug}`;

  const copyLink = async (form: FormRow) => {
    try {
      await navigator.clipboard.writeText(linkFor(form));
      setCopied(form.id);
      setTimeout(() => setCopied(current => (current === form.id ? null : current)), 1500);
    } catch {
      // Clipboard is permission-gated and blocked outright in some embedded
      // contexts. The link is visible on the row's View action either way, so a
      // refusal is a non-event rather than an error to shout about.
    }
  };

  const setStatus = (form: FormRow, status: FormStatus) => {
    fetcher.submit(
      { intent: 'update-status', formId: form.id, status },
      { method: 'post', encType: 'application/json' }
    );
  };

  // Only reached through the dialog — the row's trash button opens it.
  const remove = (form: FormRow) => {
    setPendingDelete(null);
    fetcher.submit(
      { intent: 'delete', formId: form.id },
      { method: 'post', encType: 'application/json' }
    );
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      {/* The new-form drawer renders here, over the table. */}
      <Outlet />

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Forms</h1>
        <div className="flex items-center gap-2">
          <div className="relative">
            <IconSearch
              size={15}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search forms…"
              aria-label="Search forms"
              className="w-56 rounded-lg border border-gray-200 bg-white py-2 pl-8 pr-3 text-sm text-gray-900 placeholder:text-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
            />
          </div>
          <Link
            to="new"
            className="flex items-center gap-1.5 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
          >
            <IconPlus size={16} /> New Form
          </Link>
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

      {forms.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 py-16 text-center dark:border-gray-700">
          <div className="font-medium text-gray-700 dark:text-gray-200">No forms yet</div>
          <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Waitlists, surveys, and team reviews all start here.
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-700">
          <table className="w-full">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                {['Title', 'Access', 'Status', 'Responses', 'Closes', 'Updated'].map(heading => (
                  <th
                    key={heading}
                    className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  >
                    {heading}
                  </th>
                ))}
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
              {visible.map(form => (
                <tr key={form.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                  <td className="px-4 py-3">
                    <Link
                      to={`/${classroomSlug}/forms/${form.slug}/edit`}
                      className="text-sm font-medium text-gray-900 hover:text-blue-600 dark:text-white dark:hover:text-blue-400"
                    >
                      {form.title}
                    </Link>
                    <div className="text-xs text-gray-400">/{form.slug}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${ACCESS_CHIP[form.access]}`}
                    >
                      {form.access === 'PUBLIC' ? 'Public' : 'Classroom'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={form.status}
                      aria-label={`Status of ${form.title}`}
                      onChange={event => setStatus(form, event.target.value as FormStatus)}
                      className={`cursor-pointer appearance-none rounded-full border-none px-2 py-0.5 pr-5 text-xs font-medium ${STATUS_CHIP[form.status]}`}
                      style={{
                        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24'%3E%3Cpath fill='currentColor' d='M7 10l5 5 5-5z'/%3E%3C/svg%3E")`,
                        backgroundRepeat: 'no-repeat',
                        backgroundPosition: 'right 4px center',
                      }}
                    >
                      <option value="DRAFT">Draft</option>
                      <option value="OPEN" disabled={!form.published}>
                        Open
                      </option>
                      <option value="CLOSED">Closed</option>
                    </select>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-300">
                    {/* One of TWO ways in — the other is the Actions column's
                        responses button. The count is styled as a link at rest,
                        not on hover: a bare "0" that only reveals itself when
                        the pointer happens to cross it is exactly the state in
                        which staff most need to reach this page, and it read as
                        plain text. */}
                    <Link
                      to={`/${classroomSlug}/forms/${form.slug}/responses`}
                      title={`Responses to ${form.title}`}
                      className="text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {form.responses}
                      {form.responseCap ? (
                        <span className="text-gray-400"> / {form.responseCap}</span>
                      ) : null}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                    {form.closesAt ? dayjs(form.closesAt).format('MMM D, YYYY') : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                    {dayjs(form.updatedAt).fromNow()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {/* First, and an ICON like the rest: responses is the
                          most-used staff action on a live form, and it was
                          previously reachable only by guessing that the count
                          in the Responses column was clickable. */}
                      <Link
                        to={`/${classroomSlug}/forms/${form.slug}/responses`}
                        title="See the responses collected by this form"
                        aria-label={`Responses to ${form.title}`}
                        className="text-gray-400 hover:text-blue-600 dark:hover:text-blue-400"
                      >
                        <IconListDetails size={16} />
                      </Link>
                      <button
                        type="button"
                        onClick={() => copyLink(form)}
                        title="Copy the link to this form"
                        aria-label={`Copy link to ${form.title}`}
                        className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                      >
                        <IconCopy size={16} />
                      </button>
                      <a
                        href={linkFor(form)}
                        target="_blank"
                        rel="noreferrer"
                        title="Open the form as a respondent sees it"
                        aria-label={`Open ${form.title}`}
                        className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                      >
                        <IconExternalLink size={16} />
                      </a>
                      <Link
                        to={`/${classroomSlug}/forms/${form.slug}/edit`}
                        title="Edit"
                        aria-label={`Edit ${form.title}`}
                        className="text-gray-400 hover:text-blue-600 dark:hover:text-blue-400"
                      >
                        <IconPencil size={16} />
                      </Link>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(form)}
                        title="Delete"
                        aria-label={`Delete ${form.title}`}
                        className="text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                      >
                        <IconTrash size={16} />
                      </button>
                      {copied === form.id ? (
                        <span className="text-xs text-emerald-600 dark:text-emerald-400">
                          copied
                        </span>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {visible.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400"
                  >
                    No forms match “{query}”.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete ? `Delete “${pendingDelete.title}”?` : 'Delete this form?'}
        body="This also deletes every response collected against it. This cannot be undone."
        confirmLabel="Delete form"
        variant="danger"
        busy={fetcher.state !== 'idle'}
        onConfirm={() => pendingDelete && remove(pendingDelete)}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
