import { Table, Tag } from 'antd';
import { IconEyeOff } from '@tabler/icons-react';
import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';
import { assertClassroomAccess } from '~/utils/helpers';
import { TableActionButtons } from '~/components';

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
    // table below renders.
    select: { id: true, title: true, is_draft: true },
    orderBy: { updated_at: 'desc' },
  });

  return {
    classSlug,
    slides,
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
      render: (title: string, record: { is_draft: boolean }) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{title}</span>
          {record.is_draft && (
            <Tag color="default" className="flex items-center gap-1 w-fit m-0">
              <IconEyeOff size={12} />
              Draft
            </Tag>
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
      render: (_: unknown, record: { id: string }) => (
        <TableActionButtons onView={() => window.open(`${slidesUrl}/${record.id}`, '_blank')} />
      ),
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
