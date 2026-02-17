import { Table, Tag, Card } from 'antd';
import prisma from '@classmoji/database';
import { assertClassroomAccess } from '~/utils/helpers';
import { PageHeader, TableActionButtons } from '~/components';

export const loader = async ({ request, params }) => {
  const { class: classSlug } = params;

  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['STUDENT', 'OWNER', 'TEACHER', 'ASSISTANT'],
    resourceType: 'SLIDES',
    attemptedAction: 'view_slides',
  });

  // Get published slides for this classroom (exclude drafts for students)
  const slides = await prisma.slide.findMany({
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

export default function StudentSlides({ loaderData }) {
  const { slides, slidesUrl } = loaderData;

  const columns = [
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
      render: (title, record) => <p className="font-medium">{title}</p>,
    },
    {
      title: 'Module',
      dataIndex: 'module',
      key: 'module',
      render: module => module || <span className="text-gray-400 dark:text-gray-500">—</span>,
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <TableActionButtons
          onView={() => window.open(`${slidesUrl}/${record.id}`, '_blank')}
        />
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
