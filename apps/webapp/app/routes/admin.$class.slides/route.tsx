import { useEffect } from 'react';
import { useFetcher } from 'react-router';
import { Table, Button, Tag, Select, Switch, Tooltip } from 'antd';
import {
  IconPlus,
  IconPresentation,
  IconEyeOff,
  IconLock,
  IconWorld,
  IconEdit,
  IconNotes,
  IconDownload,
  IconExternalLink,
  IconPencil,
  IconReplace,
} from '@tabler/icons-react';
import getPrisma from '@classmoji/database';
import { useCallout } from '@classmoji/ui-components';
import {
  addClassroomAuditLog,
  assertClassroomAccess,
  assertClassroomMutationAllowed,
} from '~/utils/helpers';
import { ClassmojiService, isDeckSlide, slideKindLabel, slideLinkHost } from '@classmoji/services';
import { TableActionButtons, RecentViewers } from '~/components';
import { SlideActionLink, SlideKindChip } from '~/components/features/slides';
import type { Route } from './+types/route';

/**
 * A row of this list.
 *
 * `kindLabel` and `linkHost` are computed in the loader rather than here:
 * `slideKindLabel` and `slideLinkHost` live in the services barrel, and using
 * them in component code would pull Prisma and the deck parser into the client
 * bundle. The component only ever compares `kind` against a plain string.
 */
interface Slide {
  id: string;
  title: string;
  is_draft: boolean;
  is_public: boolean;
  allow_team_edit: boolean;
  show_speaker_notes: boolean;
  kind: 'DECK' | 'FILE' | 'LINK';
  kindLabel: string;
  linkHost: string | null;
}

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'SLIDES',
    attemptedAction: 'view_slides',
  });

  // Get all slides for this classroom.
  //
  // Explicit `select`, for the reason the student list already states: a Slide
  // row carries multiplex_id / multiplex_secret, which are live presentation
  // credentials rather than list data. The source_* columns come along because
  // the chip below is derived from them.
  const slides = await getPrisma().slide.findMany({
    where: { classroom_id: classroom.id },
    select: {
      id: true,
      title: true,
      is_draft: true,
      is_public: true,
      allow_team_edit: true,
      show_speaker_notes: true,
      kind: true,
      source_filename: true,
      source_path: true,
      source_url: true,
    },
    orderBy: { updated_at: 'desc' },
  });

  // The kind chip and the link's destination host are resolved HERE, server
  // side, so the table renders plain strings and the services barrel stays out
  // of the client bundle.
  const rows = slides.map(slide => ({
    id: slide.id,
    title: slide.title,
    is_draft: slide.is_draft,
    is_public: slide.is_public,
    allow_team_edit: slide.allow_team_edit,
    show_speaker_notes: slide.show_speaker_notes,
    kind: slide.kind,
    kindLabel: slideKindLabel(slide),
    linkHost: slideLinkHost(slide.source_url),
  }));

  // Fetch recent viewers for all slides in one query (with total counts and roles for admin UI)
  const resourcePaths = slides.map(slide => `slides/${slide.id}`);
  const slideViewersMap = await ClassmojiService.resourceView.getRecentViewersForPaths({
    resourcePaths,
    classroomId: classroom.id,
    limitPerPath: 50,
    includeTotalCount: true,
    includeRoles: true,
  });
  const slideViewers = Object.fromEntries(slideViewersMap);

  return {
    slides: rows,
    org: classroom,
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    slideViewers,
  };
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;
  const formData = await request.formData();

  const slideId = formData.get('slideId') as string;
  const field = formData.get('field') as string;
  const value = formData.get('value') as string;

  // Authorization: require OWNER or TEACHER to modify slide settings
  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'SLIDES',
    attemptedAction: 'update_slide_visibility',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  if (!slideId) {
    return { error: 'Slide not found' };
  }

  /**
   * Apply an update to a deck OF THE CLASSROOM THIS REQUEST WAS AUTHORIZED FOR.
   *
   * The authorization above binds to the classroom in the URL, but `slideId`
   * arrives in the form body, so the two have to be tied together explicitly:
   * the update is bound to `{ id, classroom_id }` and is only treated as done
   * when it matched exactly one row. Same pattern as the slides app's delete
   * route, which re-checks the deck's classroom after its own gate.
   *
   * On success it records an audit row, matching the MCP slide tools' shape
   * (resource_type 'SLIDES', the deck id, action UPDATE). `tool` names the
   * specific toggle: the audit service dedups UPDATEs on the same deck inside a
   * 5-second window, so flipping two switches in quick succession would
   * otherwise leave only the first one recorded.
   */
  const updateSlideInClassroom = async (
    data: Record<string, boolean>,
    audit: { tool: string; metadata: Record<string, unknown> }
  ) => {
    const { count } = await getPrisma().slide.updateMany({
      where: { id: slideId, classroom_id: classroom.id },
      data,
    });
    if (count !== 1) {
      return { error: 'Slide not found' };
    }
    await addClassroomAuditLog({
      classroomId: classroom.id,
      userId,
      role: membership!.role,
      action: 'UPDATE',
      resourceType: 'SLIDES',
      resourceId: slideId,
      metadata: { tool: audit.tool, ...audit.metadata },
    });
    return { success: true };
  };

  // Handle status changes (combines is_draft and is_public)
  if (field === 'status') {
    let is_draft = false;
    let is_public = false;

    if (value === 'draft') {
      is_draft = true;
      is_public = false;
    } else if (value === 'private') {
      is_draft = false;
      is_public = false;
    } else if (value === 'public') {
      is_draft = false;
      is_public = true;
    }

    return updateSlideInClassroom(
      { is_draft, is_public },
      { tool: 'web:slides.status', metadata: { field: 'status', value, is_draft, is_public } }
    );
  }

  // Handle boolean toggles (allow_team_edit, show_speaker_notes)
  //
  // Both are deck-only: team editing is about the deck editor and speaker notes
  // are a reveal.js concept, so neither means anything for an uploaded file or
  // a link. The switches are disabled for those kinds in the table, and this is
  // the half that actually enforces it — a disabled control is a hint, not a
  // gate, and `slideService.updateSlide` refuses the same pair with a
  // SlideKindError. Checking the kind first keeps the refusal a plain result
  // the list can show, rather than a thrown 409 that takes over the page.
  if (field === 'allow_team_edit' || field === 'show_speaker_notes') {
    const target = await getPrisma().slide.findFirst({
      where: { id: slideId, classroom_id: classroom.id },
      select: { kind: true },
    });
    if (!target) {
      return { error: 'Slide not found' };
    }
    if (!isDeckSlide(target)) {
      return { error: 'Team editing and speaker notes only apply to slide decks.' };
    }

    const enabled = value === 'true';
    return updateSlideInClassroom(
      { [field]: enabled },
      { tool: `web:slides.${field}`, metadata: { field, value: enabled } }
    );
  }

  return { error: 'Invalid field' };
};

// Helper to compute status from is_draft and is_public
function getSlideStatus(slide: { is_draft: boolean; is_public: boolean }) {
  if (slide.is_draft) return 'draft';
  if (slide.is_public) return 'public';
  return 'private';
}

// Status badge component (currently unused - kept for reference)
function _StatusBadge({ status }: { status: 'draft' | 'private' | 'public' }) {
  const config: Record<string, { color: string; icon: typeof IconEyeOff; label: string }> = {
    draft: { color: 'default', icon: IconEyeOff, label: 'Draft' },
    private: { color: 'blue', icon: IconLock, label: 'Private' },
    public: { color: 'green', icon: IconWorld, label: 'Public' },
  };
  const { color, icon: Icon, label } = config[status];
  return (
    <Tag color={color} className="flex items-center gap-1 w-fit">
      <Icon size={12} />
      {label}
    </Tag>
  );
}

export default function SlidesAdmin({ loaderData }: Route.ComponentProps) {
  const { slides, org, slidesUrl, slideViewers } = loaderData;
  const fetcher = useFetcher();
  const callout = useCallout();

  // The action RETURNS its refusals rather than throwing them, so they have to
  // be shown here or they are invisible: the control simply springs back on the
  // next revalidation and nothing says why. Same pattern as the pages list.
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.error) {
      callout.show({ variant: 'error', title: fetcher.data.error, autoDismissMs: 4000 });
    }
    // `callout` is stable per CalloutProvider, so it is not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  // Handle field updates
  const updateSlideField = (slideId: string, field: string, value: string | boolean) => {
    fetcher.submit({ slideId, field, value: String(value) }, { method: 'post' });
  };

  /**
   * A switch that only means something for a deck.
   *
   * Disabled AND explained for a file or a link: a control that simply refuses
   * to move reads as a bug. The server refuses the same write regardless of
   * what the browser sends.
   */
  const deckOnlySwitch = (record: Slide, field: 'allow_team_edit' | 'show_speaker_notes') => {
    const control = (
      <Switch
        size="small"
        disabled={record.kind !== 'DECK'}
        checked={record[field]}
        onChange={checked => updateSlideField(record.id, field, checked)}
      />
    );
    if (record.kind === 'DECK') return control;
    // antd needs a wrapper to hear the hover: a disabled control fires no
    // pointer events of its own.
    return (
      <Tooltip title="Only applies to decks">
        <span className="inline-flex">{control}</span>
      </Tooltip>
    );
  };

  const columns = [
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
      width: 250,
      // The chip says what the row IS, because the title's link no longer does
      // one thing: it opens a deck, downloads a file, or leaves for another
      // site. A link's destination host rides underneath for the same reason —
      // where the click lands is the one thing a bare title cannot say.
      render: (title: string, record: Slide) => (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <SlideKindChip label={record.kindLabel} />
            <a
              href={`${slidesUrl}/${record.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium !text-gray-600 dark:!text-gray-100 hover:!text-blue-600 dark:hover:!text-blue-400"
            >
              {title}
            </a>
          </div>
          {record.linkHost && (
            <span className="text-xs text-ink-3 truncate" title={record.linkHost}>
              {record.linkHost}
            </span>
          )}
        </div>
      ),
    },
    {
      title: 'Viewers',
      key: 'viewers',
      width: 120,
      render: (_: unknown, record: Slide) => {
        const rawData = slideViewers[`slides/${record.id}`] || { viewers: [], totalCount: 0 };
        const viewerData =
          'viewers' in rawData ? rawData : { viewers: rawData, totalCount: rawData.length };
        return (
          <RecentViewers
            viewers={viewerData.viewers}
            totalCount={viewerData.totalCount}
            groupByRole
          />
        );
      },
    },
    {
      title: 'Status',
      key: 'status',
      width: 130,
      render: (_: unknown, record: Slide) => {
        const status = getSlideStatus(record);
        return (
          <Select
            value={status}
            size="small"
            style={{ width: 110 }}
            onChange={value => updateSlideField(record.id, 'status', value)}
            options={[
              {
                value: 'draft',
                label: (
                  <span className="flex items-center gap-1">
                    <IconEyeOff size={14} /> Draft
                  </span>
                ),
              },
              {
                value: 'private',
                label: (
                  <span className="flex items-center gap-1">
                    <IconLock size={14} /> Private
                  </span>
                ),
              },
              {
                value: 'public',
                label: (
                  <span className="flex items-center gap-1">
                    <IconWorld size={14} /> Public
                  </span>
                ),
              },
            ]}
          />
        );
      },
    },
    {
      title: (
        <Tooltip title="Allow teaching assistants to edit this slide">
          <span className="flex items-center gap-1 cursor-help">
            <IconEdit size={14} />
            Team Edit
          </span>
        </Tooltip>
      ),
      key: 'allow_team_edit',
      width: 100,
      align: 'center',
      render: (_: unknown, record: Slide) => deckOnlySwitch(record, 'allow_team_edit'),
    },
    {
      title: (
        <Tooltip title="Allow viewers (students/public) to see speaker notes">
          <span className="flex items-center gap-1 cursor-help">
            <IconNotes size={14} />
            Notes
          </span>
        </Tooltip>
      ),
      key: 'show_speaker_notes',
      width: 80,
      align: 'center',
      render: (_: unknown, record: Slide) => deckOnlySwitch(record, 'show_speaker_notes'),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 220,
      /**
       * What you can DO with a row depends on what the row is.
       *
       * Delete is the one action all three share, and it keeps going to the
       * slides app's own confirmation screen (hence `skipDeleteConfirm`: the
       * confirmation is over there, not in a popconfirm here).
       *
       * A file and a link have no editor and nothing to present, so neither
       * offers Edit or Present — the slides app refuses both server-side for a
       * non-deck, and an affordance that leads to a refusal is worse than no
       * affordance. `${slidesUrl}/${id}` is still the one address for every
       * kind; it downloads a file and redirects a link.
       */
      render: (_: unknown, record: Slide) => {
        const deleteSlide = () =>
          window.open(`${slidesUrl}/${org.slug}/${record.id}/delete`, '_blank');

        if (record.kind === 'FILE') {
          return (
            <TableActionButtons onDelete={deleteSlide} skipDeleteConfirm>
              <SlideActionLink href={`${slidesUrl}/${record.id}`} icon={<IconDownload size={16} />}>
                Download
              </SlideActionLink>
              <SlideActionLink
                href={`${slidesUrl}/${org.slug}/${record.id}/replace`}
                icon={<IconReplace size={16} />}
              >
                Replace
              </SlideActionLink>
            </TableActionButtons>
          );
        }

        if (record.kind === 'LINK') {
          return (
            <TableActionButtons onDelete={deleteSlide} skipDeleteConfirm>
              <SlideActionLink
                href={`${slidesUrl}/${record.id}`}
                icon={<IconExternalLink size={16} />}
              >
                Open
              </SlideActionLink>
              <SlideActionLink
                href={`${slidesUrl}/${org.slug}/${record.id}/link`}
                icon={<IconPencil size={16} />}
              >
                Edit link
              </SlideActionLink>
            </TableActionButtons>
          );
        }

        return (
          <TableActionButtons
            onView={() => window.open(`${slidesUrl}/${record.id}`, '_blank')}
            onEdit={() => window.open(`${slidesUrl}/${record.id}?mode=edit`, '_blank')}
            onDelete={deleteSlide}
            skipDeleteConfirm
          >
            <SlideActionLink
              href={`${slidesUrl}/${record.id}/present`}
              icon={<IconPresentation size={16} />}
            >
              Present
            </SlideActionLink>
          </TableActionButtons>
        );
      },
    },
  ];

  return (
    <div className="min-h-full relative">
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1">Slides</h1>
        <div className="flex items-center gap-3">
          {/* One button, because there is now one screen behind it: the slides
              app's New Slide page is the source picker — start a blank deck,
              upload a file, paste a link, or import a Slides.com export, which
              is where the second button used to go. */}
          <Button
            type="primary"
            icon={<IconPlus size={16} />}
            onClick={() => window.open(`${slidesUrl}/${org.slug}/new`, '_blank')}
          >
            New Slide
          </Button>
        </div>
      </div>

      <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 min-h-[calc(100vh-10rem)]">
        <Table
          columns={columns as Parameters<typeof Table>[0]['columns']}
          dataSource={slides}
          rowKey="id"
          rowHoverable={false}
          size="middle"
          scroll={{ x: 'max-content' }}
          pagination={{
            pageSize: 25,
            showSizeChanger: true,
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} slides`,
          }}
          locale={{
            emptyText: (
              <div className="text-center py-12 text-gray-500">
                <div className="font-medium">No slides created yet</div>
                <div className="text-sm">Start a deck, upload a file, or add a link.</div>
              </div>
            ),
          }}
        />
      </div>
    </div>
  );
}
