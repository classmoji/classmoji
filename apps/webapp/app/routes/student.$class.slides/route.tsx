import { Table, Tag } from 'antd';
import { IconDownload, IconExternalLink, IconEyeOff } from '@tabler/icons-react';
import getPrisma from '@classmoji/database';
import { slideKindLabel, slideLinkHost } from '@classmoji/services';
import type { Route } from './+types/route';
import { assertClassroomAccess } from '~/utils/helpers';
import { TableActionButtons } from '~/components';
import { SlideActionLink, SlideKindChip } from '~/components/features/slides';

/**
 * A row of this list.
 *
 * `kindLabel` and `linkHost` are resolved in the loader: the helpers that
 * produce them live in the services barrel, and calling them from component
 * code would drag Prisma and the deck parser into the client bundle.
 */
interface SlideRow {
  id: string;
  title: string;
  is_draft: boolean;
  kind: 'DECK' | 'FILE' | 'LINK';
  kindLabel: string;
  linkHost: string | null;
}

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  const { classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug!,
    allowedRoles: ['STUDENT', 'OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'SLIDES',
    attemptedAction: 'view_slides',
  });

  // This route is shared: the assistant prefix re-exports it. Listing follows
  // the VIEW tier of the shared slide gate (assertSlideAccess) — the teaching
  // team may open a draft deck, so the list must show it, or staff can reach a
  // deck by URL that they cannot find. Students stay on published decks only.
  // Editing is a separate, narrower rule and is not granted here: this list
  // offers no edit affordance to anyone.
  //
  // `membership.role` is the caller's HIGHEST role in this classroom
  // (assertClassroomAccess resolves it in privilege order), so a TA who is also
  // enrolled as a student is staff here — the same answer the slide gate gives
  // them when they open one of these decks.
  const isStaff =
    membership?.role === 'OWNER' ||
    membership?.role === 'TEACHER' ||
    membership?.role === 'ASSISTANT';

  const slides = await getPrisma().slide.findMany({
    where: {
      classroom_id: classroom.id,
      ...(isStaff ? {} : { is_draft: false }),
    },
    // Explicit: a Slide row carries multiplex_id / multiplex_secret, which are
    // live presentation credentials rather than list data. Send only what the
    // table below renders — plus the source_* columns the kind chip is derived
    // from, which say nothing a viewer of the slide cannot already see.
    select: {
      id: true,
      title: true,
      is_draft: true,
      kind: true,
      source_filename: true,
      source_path: true,
      source_url: true,
    },
    orderBy: { updated_at: 'desc' },
  });

  return {
    classSlug,
    // The chip's word and a link's destination host are computed server side,
    // so the table renders plain strings.
    slides: slides.map(slide => ({
      id: slide.id,
      title: slide.title,
      is_draft: slide.is_draft,
      kind: slide.kind,
      kindLabel: slideKindLabel(slide),
      linkHost: slideLinkHost(slide.source_url),
    })),
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
  };
};

export default function StudentSlides({ loaderData }: Route.ComponentProps) {
  const { slides, slidesUrl } = loaderData;

  const columns = [
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
      // Drafts only ever reach a staff viewer (the loader filters them out for
      // students), so the badge marks the deck as a colleague's unpublished
      // work — matching how the admin list labels the same state. It is a
      // label, not a control: changing a deck's status stays on the admin page.
      //
      // The kind chip is the same one the admin list draws, and for the same
      // reason: opening a row downloads a file or leaves for another site as
      // often as it opens a deck, and the title alone cannot say which.
      render: (title: string, record: SlideRow) => (
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <SlideKindChip label={record.kindLabel} />
            <span className="font-medium">{title}</span>
            {record.is_draft && (
              <Tag color="default" className="flex items-center gap-1 w-fit m-0">
                <IconEyeOff size={12} />
                Draft
              </Tag>
            )}
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
      title: 'Repository',
      dataIndex: 'repository',
      key: 'repository',
      render: (repository: string | null) => repository || <span className="text-ink-4">—</span>,
    },
    {
      title: 'Actions',
      key: 'actions',
      // One address for every kind — `${slidesUrl}/${id}` opens a deck,
      // downloads a file and redirects a link — but the word on the control
      // says which of those is about to happen. "View" on a row that silently
      // starts a download is a small lie.
      render: (_: unknown, record: SlideRow) => {
        const href = `${slidesUrl}/${record.id}`;

        if (record.kind === 'FILE') {
          return (
            <TableActionButtons>
              <SlideActionLink href={href} icon={<IconDownload size={17} />}>
                Download
              </SlideActionLink>
            </TableActionButtons>
          );
        }

        if (record.kind === 'LINK') {
          return (
            <TableActionButtons>
              <SlideActionLink href={href} icon={<IconExternalLink size={17} />}>
                Open
              </SlideActionLink>
            </TableActionButtons>
          );
        }

        return <TableActionButtons onView={() => window.open(href, '_blank')} />;
      },
    },
  ];

  return (
    <div className="min-h-full relative">
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1">Slides</h1>
      </div>

      <div className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 min-h-[calc(100vh-10rem)]">
        <Table
          columns={columns}
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
                <div className="font-medium">No slides available yet</div>
              </div>
            ),
          }}
        />
      </div>
    </div>
  );
}
