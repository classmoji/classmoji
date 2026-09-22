import { useEffect, useMemo, useState } from 'react';
import { useFetcher } from 'react-router';
import { Button, Modal, Select, Table, Tag } from 'antd';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import {
  IconCopy,
  IconExternalLink,
  IconEyeOff,
  IconLock,
  IconPencil,
  IconPlus,
  IconWorld,
} from '@tabler/icons-react';

import getPrisma from '@classmoji/database';
import { ClassmojiService, publicFormUrlFor } from '@classmoji/services';
import { useCallout } from '@classmoji/ui-components';
import {
  addClassroomAuditLog,
  assertClassroomAccess,
  assertProTier,
  formMutationBlocked,
} from '~/utils/helpers';
import { SearchInput, TableActionButtons } from '~/components';
import type { Route } from './+types/route';

dayjs.extend(relativeTime);

/**
 * Form MANAGEMENT in the webapp — the Slides shape, applied to forms.
 *
 * What lives here: the list, the status tri-state, copy link, delete, and the
 * links out. What does NOT live here: building a form, filling one, and reading
 * responses, all of which stay in apps/pages where the builder is. Exactly as
 * `admin.$class.slides` lists decks the slides app edits and presents.
 *
 * The four links that leave (New Form, Edit, Responses, and the back link that
 * comes home) are plain same-tab anchors to the pages app, not `window.open`:
 * this is one task that happens to span two origins, and a builder that opens
 * in a tab you did not ask for is a tab you then have to close. The exception
 * is the public fill URL, which really is a different site — a respondent view
 * of the form — so it opens in a new tab.
 *
 * Deep links under `/admin/:class/forms/**` are NOT this route: they belong to
 * `admin.$class.forms_.$`, the redirect that hands them to apps/pages. The
 * trailing underscore there is what keeps that splat from nesting inside this
 * list.
 */

type FormAccess = 'PUBLIC' | 'CLASSROOM';
type FormStatus = 'DRAFT' | 'OPEN' | 'CLOSED';

/**
 * A row as it leaves the loader — the same shape the pages list builds, because
 * both lists answer the same questions about the same rows and drifting apart
 * is how two screens start disagreeing about one form.
 */
interface FormRow {
  id: string;
  title: string;
  slug: string;
  access: FormAccess;
  status: FormStatus;
  /**
   * Has this form ever been published? A form with no revision cannot legally
   * go OPEN, so the select disables that option rather than letting the action
   * explain it after the fact.
   */
  published: boolean;
  responses: number;
  responseCap: number | null;
  closesAt: string | null;
  updatedAt: string;
  /**
   * The link the copy button hands out — built in the loader, because it is the
   * only place that knows whether this classroom has a course site and
   * therefore which HOST and which PATH the link takes. See `publicFormUrlFor`.
   */
  publicUrl: string;
}

/**
 * The gate both the loader and the action apply.
 *
 * Named `resourceType: 'FORMS'` rather than the 'CLASSROOM_ACCESS' catch-all so
 * a denial in the audit log says what was refused — the same vocabulary the
 * pages-side `assertFormAdmin` and the MCP form tools use.
 *
 * Pro is enforced AFTER access, on purpose: a stranger probing this URL must
 * not learn a classroom's billing tier. `isProTier` on the nav entry only hides
 * the item; this is what refuses a free-tier classroom.
 */
const requireFormsAccess = (request: Request, classSlug: string, attemptedAction: string) =>
  assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'FORMS',
    attemptedAction,
  }).then(async access => {
    await assertProTier(classSlug);
    return access;
  });

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { classroom } = await requireFormsAccess(request, classSlug, 'view_forms');

  const pagesUrl = process.env.PAGES_URL || 'http://localhost:7100';

  const [forms, publicUrlFor] = await Promise.all([
    ClassmojiService.form.findByClassroomId(classroom.id),
    // The classroom's own site host when it has one, so what staff copy here is
    // the same short link the pages list copies. Resolved ONCE for the
    // classroom and applied per row — the hostname is a property of the
    // classroom, not of the form.
    //
    // PAGES_URL is the fallback origin rather than this request's origin: the
    // webapp is not the host that serves a form, so the origin that served this
    // page is the one host the link must NOT be built from.
    publicFormUrlFor(classroom, pagesUrl, classSlug),
  ]);

  return {
    classSlug,
    pagesUrl,
    forms: forms.map(
      (form): FormRow => ({
        id: form.id,
        title: form.title,
        slug: form.slug,
        access: form.access as FormAccess,
        status: form.status as FormStatus,
        published: Boolean(form.current_revision_id),
        responses: form._count.responses,
        responseCap: form.response_cap,
        // Dates are serialized here rather than left to the transport: the
        // client formats them and should not have to care which of Date and
        // string arrived.
        closesAt: form.closes_at ? form.closes_at.toISOString() : null,
        updatedAt: form.updated_at.toISOString(),
        publicUrl: publicUrlFor(form.slug),
      })
    ),
  };
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const classSlug = params.class!;

  // Its OWN gate, not the loader's and not the `/admin/:class` layout's. React
  // Router matches only the action route for a submission and revalidates
  // loaders afterwards, so a layout loader runs too late to refuse a POST.
  const { classroom, userId, membership } = await requireFormsAccess(
    request,
    classSlug,
    'mutate_form'
  );

  const formData = await request.formData();
  const intent = formData.get('intent');
  const rawFormId = formData.get('formId');
  // `formData.get` returns `File | string | null`, so this is a real narrowing
  // and not a formality: a multipart part would otherwise be cast to a string
  // and reach Prisma as an object.
  const formId = typeof rawFormId === 'string' ? rawFormId : null;

  if (!formId) return { error: 'Form not found' };

  // LOCKED / UNPUBLISHED classrooms are read-only for everyone but the owner.
  // RETURNED rather than thrown: these arrive by `fetcher.submit`, and a thrown
  // Response escalates to the ErrorBoundary and replaces the list.
  const blocked = formMutationBlocked(classroom, membership!.role);
  if (blocked) return blocked;

  // Read the form bound to the classroom that was authorized. A form id from
  // ANOTHER classroom must not be touched by a caller who is staff here — the
  // cross-classroom hole the MCP audit closed everywhere else.
  //
  // This read is for the MESSAGE and the audit metadata, not for safety: it and
  // the write are two statements, so on its own it would still be a race. Every
  // write below is additionally scoped by `classroom_id` in the service, which
  // is what actually closes the window — the same shape as the slides action's
  // `updateMany({ where: { id, classroom_id } })`.
  const form = await getPrisma().form.findFirst({
    where: { id: formId, classroom_id: classroom.id },
    select: { id: true, title: true, slug: true },
  });
  if (!form) return { error: 'Form not found' };

  if (intent === 'update-status') {
    const status = formData.get('status');
    if (status !== 'DRAFT' && status !== 'OPEN' && status !== 'CLOSED') {
      return { error: 'Unknown status' };
    }
    try {
      await ClassmojiService.form.quickUpdate(formId, { status }, { classroomId: classroom.id });
    } catch (error) {
      const code = (error as { code?: string }).code;
      // The one refusal quickUpdate makes: OPEN on a form that has never been
      // published. Surfaced as the instruction, not the error code.
      if (code === 'FORM_NO_FIELDS') {
        return { error: 'Publish this form before opening it.' };
      }
      // The scoped write matched nothing — the form left this classroom (or
      // was deleted) between the read above and the write.
      if (code === 'FORM_NOT_FOUND') return { error: 'Form not found' };
      throw error;
    }
    await addClassroomAuditLog({
      classroomId: classroom.id,
      userId,
      role: membership!.role,
      action: 'UPDATE',
      resourceType: 'FORMS',
      resourceId: formId,
      metadata: { tool: 'web:forms.status', status },
    });
    return { success: true };
  }

  if (intent === 'delete') {
    try {
      await ClassmojiService.form.deleteForm(formId, { classroomId: classroom.id });
    } catch (error) {
      if ((error as { code?: string }).code === 'FORM_NOT_FOUND') {
        return { error: 'Form not found' };
      }
      throw error;
    }
    // Deleting a form cascades to its responses, which is the point and also
    // why it is audited: this is the one action here that destroys collected
    // PII, and the row is the only record it happened.
    await addClassroomAuditLog({
      classroomId: classroom.id,
      userId,
      role: membership!.role,
      action: 'DELETE',
      resourceType: 'FORMS',
      resourceId: formId,
      metadata: { tool: 'web:forms.delete', title: form.title, slug: form.slug },
    });
    return { success: true };
  }

  return { error: 'Unknown intent' };
};

/**
 * The tri-state, with an icon per state — the shape the slides list's status
 * Select uses, so the two management screens read as one system rather than as
 * two people's tables. The icons also carry the meaning at a glance once the
 * select is closed, which a bare word in a 100px control does not.
 */
const STATUS_OPTIONS: { value: FormStatus; label: React.ReactNode }[] = [
  {
    value: 'DRAFT',
    label: (
      <span className="flex items-center gap-1">
        <IconEyeOff size={14} /> Draft
      </span>
    ),
  },
  {
    value: 'OPEN',
    label: (
      <span className="flex items-center gap-1">
        <IconWorld size={14} /> Open
      </span>
    ),
  },
  {
    value: 'CLOSED',
    label: (
      <span className="flex items-center gap-1">
        <IconLock size={14} /> Closed
      </span>
    ),
  },
];

export default function FormsAdmin({ loaderData }: Route.ComponentProps) {
  const { forms, classSlug, pagesUrl } = loaderData;
  // `message` is not this route's own shape: `formMutationBlocked` returns the
  // platform's typed 403 body, `{ error: 'CLASSROOM_LOCKED', message: '…' }`,
  // where `error` is a CODE and the sentence is in `message`.
  const fetcher = useFetcher<{ error?: string; message?: string; success?: boolean }>();
  const callout = useCallout();
  const [query, setQuery] = useState('');
  // The form a delete has been REQUESTED for and not yet confirmed. Holding the
  // ROW (not a boolean) is what lets the dialog name the form being deleted.
  const [pendingDelete, setPendingDelete] = useState<FormRow | null>(null);

  // The action RETURNS its refusals rather than throwing them, so they have to
  // be shown here or they are invisible: the select springs back on the next
  // revalidation and nothing says why. Same pattern as the slides list.
  //
  // The same effect closes the delete dialog, and ONLY once the delete has
  // actually succeeded. Closing it optimistically in the click handler (the
  // obvious `setPendingDelete(null)` before `fetcher.submit`) makes the dialog
  // disappear before anything has happened, which is a lie in the one case it
  // matters: a REFUSED delete — a LOCKED classroom, a form that moved — would
  // dismiss as though it had worked, leaving only a toast behind. Driven off
  // the settled fetcher, the dialog instead holds its spinner for as long as
  // the delete is running, closes when the row is really gone, and stays up
  // with the callout when the server says no.
  useEffect(() => {
    if (fetcher.state !== 'idle') return;
    if (fetcher.data?.error) {
      // `message` first: a classroom-status refusal puts its SENTENCE there and
      // a machine code in `error`, so reading `error` alone toasted the literal
      // string "CLASSROOM_LOCKED" at the instructor. This route's own refusals
      // only set `error`, and it is already a sentence.
      const title = fetcher.data.message ?? fetcher.data.error;
      callout.show({ variant: 'error', title, autoDismissMs: 4000 });
      return;
    }
    if (fetcher.data?.success) setPendingDelete(null);
    // `callout` is stable per CalloutProvider, so it is not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  const formsUrl = `${pagesUrl}/${classSlug}/forms`;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return forms;
    return forms.filter(
      form => form.title.toLowerCase().includes(needle) || form.slug.toLowerCase().includes(needle)
    );
  }, [forms, query]);

  const setStatus = (form: FormRow, status: FormStatus) => {
    fetcher.submit({ intent: 'update-status', formId: form.id, status }, { method: 'post' });
  };

  // Only reached through the modal — the row's Delete button opens it. The
  // dialog stays up, spinner on, until the fetcher settles; the effect above
  // closes it on success and leaves it open on a refusal.
  const remove = (form: FormRow) => {
    fetcher.submit({ intent: 'delete', formId: form.id }, { method: 'post' });
  };

  const copyLink = async (form: FormRow) => {
    try {
      await navigator.clipboard.writeText(form.publicUrl);
    } catch {
      // Clipboard is permission-gated and blocked outright in some embedded
      // contexts. The link is one click away on the Open action either way, so
      // say what happened rather than claiming a copy that did not happen.
      callout.show({
        variant: 'error',
        title: 'Could not copy the link — use Open to get it from the address bar.',
        autoDismissMs: 4000,
      });
      return;
    }
    callout.show({ variant: 'success', title: 'Form link copied', autoDismissMs: 2000 });
  };

  const columns = [
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
      width: 200,
      render: (title: string, record: FormRow) => (
        <div className="flex flex-col gap-0.5 min-w-0">
          <a
            href={`${formsUrl}/${record.slug}/edit`}
            className="font-medium !text-gray-600 dark:!text-gray-100 hover:!text-blue-600 dark:hover:!text-blue-400 no-underline truncate"
          >
            {title}
          </a>
          {/* `text-ink-3`, not `text-gray-400`: the slug has to stay legible on
              the dark card too, and a fixed grey is only ever tuned for one of
              the two themes. */}
          <span className="text-xs text-ink-3 truncate">/{record.slug}</span>
        </div>
      ),
    },
    {
      title: 'Access',
      dataIndex: 'access',
      key: 'access',
      width: 95,
      render: (access: FormAccess) => (
        <Tag color={access === 'PUBLIC' ? 'green' : 'blue'}>
          {access === 'PUBLIC' ? 'Public' : 'Classroom'}
        </Tag>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_: unknown, record: FormRow) => (
        <Select<FormStatus>
          value={record.status}
          size="small"
          style={{ width: 100 }}
          aria-label={`Status of ${record.title}`}
          onChange={value => setStatus(record, value)}
          options={STATUS_OPTIONS.map(option => ({
            ...option,
            // A form that has never been published has nothing to render, and
            // letting it go OPEN produces a much worse error later. The service
            // refuses the same write; this only stops the pointless round trip.
            disabled: option.value === 'OPEN' && !record.published,
          }))}
        />
      ),
    },
    {
      title: 'Responses',
      key: 'responses',
      width: 90,
      render: (_: unknown, record: FormRow) => (
        // Styled as a link at rest, not on hover: a bare "0" that only reveals
        // itself when the pointer happens to cross it is exactly the state in
        // which staff most need to reach this page.
        <a
          href={`${formsUrl}/${record.slug}/responses`}
          title={`Responses to ${record.title}`}
          className="!text-blue-600 dark:!text-blue-400 hover:underline"
        >
          {record.responses}
          {record.responseCap ? <span className="text-ink-3"> / {record.responseCap}</span> : null}
        </a>
      ),
    },
    {
      title: 'Closes',
      dataIndex: 'closesAt',
      key: 'closesAt',
      width: 105,
      render: (closesAt: string | null) => (
        <span className="text-sm text-ink-2">
          {closesAt ? dayjs(closesAt).format('MMM D, YYYY') : '—'}
        </span>
      ),
    },
    {
      title: 'Updated',
      dataIndex: 'updatedAt',
      key: 'updatedAt',
      width: 100,
      render: (updatedAt: string) => (
        <span className="text-sm text-ink-3" title={dayjs(updatedAt).format('MMM D, YYYY HH:mm')}>
          {dayjs(updatedAt).fromNow()}
        </span>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 210,
      /**
       * Four actions, not five. Responses was dropped from this column because
       * the Responses COUNT is already a link at rest — a second door to the
       * same page, three columns away, was the whole reason this column ran to
       * 370px against the slides list's 220. Delete drops its label the way
       * RepoActions and the assignment table do; the red trash is unambiguous.
       */
      render: (_: unknown, record: FormRow) => (
        <TableActionButtons
          onDelete={() => setPendingDelete(record)}
          hideDeleteText
          // The confirmation is the Modal below, which names the form and says
          // what else goes with it. A popconfirm reading "Are you sure?" would
          // not mention the responses.
          skipDeleteConfirm
        >
          <button
            type="button"
            onClick={() => copyLink(record)}
            title="Copy the public link to this form"
            aria-label={`Copy link to ${record.title}`}
            className="flex items-center gap-1 text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100 cursor-pointer bg-transparent border-0 p-0"
          >
            <IconCopy size={17} />
            {/* "Copy link", not "Copy": next to Open and Edit, a bare verb reads
                as "copy the form". */}
            <span>Copy link</span>
          </button>
          {/* The one link that opens a tab of its own: this is the respondent's
              view on the course's public address, not a step in the staff task. */}
          <a
            href={record.publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open the form as a respondent sees it"
            aria-label={`Open ${record.title} as a respondent sees it`}
            className="flex items-center gap-1 !text-gray-600 hover:!text-gray-800 dark:!text-gray-300 dark:hover:!text-gray-100 no-underline cursor-pointer"
          >
            <IconExternalLink size={17} />
            <span>Open</span>
          </a>
          <FormActionLink href={`${formsUrl}/${record.slug}/edit`} icon={<IconPencil size={17} />}>
            Edit
          </FormActionLink>
        </TableActionButtons>
      ),
    },
  ];

  return (
    <div className="min-h-full relative">
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1 shrink-0">Forms</h1>

        <div className="flex gap-3 min-w-0">
          <SearchInput
            query={query}
            setQuery={setQuery}
            placeholder="Search forms..."
            className="min-w-0 flex-1 sm:flex-initial sm:w-80"
          />
          {/* antd's Button renders an `<a>` when given `href`, which is what
              this needs: the new-form drawer is on the pages app, so the
              control has to be a real link — middle-clickable and copyable,
              not a scripted navigation.
              NOT `<a><ButtonNew/></a>`: a `<button>` nested inside an `<a>` is
              invalid interactive nesting, and the browser does not follow the
              link when the button is clicked. Verified in Chrome: the first
              version of this rendered correctly and did nothing. */}
          <Button
            type="primary"
            href={`${formsUrl}/new`}
            icon={<IconPlus size={16} />}
            className="shrink-0"
          >
            New Form
          </Button>
        </div>
      </div>

      <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 min-h-[calc(100vh-10rem)]">
        <Table
          columns={columns as Parameters<typeof Table>[0]['columns']}
          dataSource={visible}
          rowKey="id"
          rowHoverable={false}
          size="middle"
          scroll={{ x: 'max-content' }}
          pagination={{
            pageSize: 25,
            showSizeChanger: true,
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} forms`,
          }}
          locale={{
            emptyText: query ? (
              <div className="text-center py-12 text-gray-500">
                <div className="font-medium">No forms match “{query}”</div>
                <div className="text-sm">Try a different title or slug.</div>
              </div>
            ) : (
              <div className="text-center py-12 text-gray-500">
                <div className="font-medium">No forms created yet</div>
                <div className="text-sm">Waitlists, surveys, and team reviews all start here.</div>
              </div>
            ),
          }}
        />
      </div>

      <Modal
        open={pendingDelete !== null}
        title={pendingDelete ? `Delete “${pendingDelete.title}”?` : 'Delete this form?'}
        okText="Delete form"
        okButtonProps={{ danger: true, loading: fetcher.state !== 'idle' }}
        cancelText="Cancel"
        onOk={() => pendingDelete && remove(pendingDelete)}
        onCancel={() => setPendingDelete(null)}
      >
        <p className="text-ink-2">
          This also deletes every response collected against it. This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}

/**
 * One action in a row, as a real link to the pages app — same tab.
 *
 * Every colour is `!important` for the reason `SlideActionLink` documents: an
 * `<a>` is styled by unlayered global/antd CSS, which beats Tailwind's
 * `utilities` layer whatever the source order, so a plain `hover:text-gray-800`
 * next to an `!text-gray-600` never applies.
 */
function FormActionLink({
  href,
  icon,
  children,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className="flex items-center gap-1 !text-gray-600 hover:!text-gray-800 dark:!text-gray-300 dark:hover:!text-gray-100 no-underline cursor-pointer"
    >
      {icon}
      <span>{children}</span>
    </a>
  );
}
