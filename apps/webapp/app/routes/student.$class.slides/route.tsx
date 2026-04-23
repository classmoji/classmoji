import { Table } from 'antd';
import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';
import { assertClassroomAccess } from '~/utils/helpers';
import { PageHeader, TableActionButtons } from '~/components';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug!,
    allowedRoles: ['STUDENT', 'OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'SLIDES',
    attemptedAction: 'view_slides',
  });

  // Get published slides for this classroom (exclude drafts for students)
  const slides = await getPrisma().slide.findMany({
    where: {
      classroom_id: classroom.id,
      is_draft: false, // Only show published slides to students
    },
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
      render: (title: string) => <p className="font-medium">{title}</p>,
    },
    {
      title: 'Module',
      dataIndex: 'module',
      key: 'module',
      render: (module: string | null) =>
        module || <span className="text-gray-400 dark:text-gray-500">—</span>,
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
    <div>
      <PageHeader title="Slides" routeName="slides" />

      <Table
        columns={columns}
        dataSource={slides}
        rowKey="id"
        rowHoverable={false}
        size="middle"
        pagination={{
          pageSize: 25,
          showSizeChanger: true,
          showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} slides`,
        }}
        locale={{
          emptyText: (
            <div className="text-center py-8 text-gray-500">
              <div className="text-4xl mb-2">🎞️</div>
              <div>No slides available yet</div>
            </div>
          ),
        }}
      />
    </div>
  );
}
