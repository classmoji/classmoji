import { useLoaderData, useFetcher } from 'react-router';
import { Table, Button, Tag, Select, Switch, Tooltip } from 'antd';
import { IconPlus, IconPresentation, IconEyeOff, IconLock, IconWorld, IconEdit, IconNotes } from '@tabler/icons-react';
import prisma from '@classmoji/database';
import { assertClassroomAccess } from '~/utils/helpers';
import { ClassmojiService } from '@classmoji/services';
import { PageHeader, TableActionButtons, RecentViewers } from '~/components';

export const loader = async ({ request, params }) => {
  const { class: classSlug } = params;

  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'SLIDES',
    attemptedAction: 'view_slides',
  });

  // Get all slides for this classroom
  const slides = await prisma.slide.findMany({
    where: { classroom_id: classroom.id },
    orderBy: { updated_at: 'desc' },
  });

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
    slides,
    org: classroom,
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    slideViewers,
  };
};

export const action = async ({ request, params }) => {
  const { class: classSlug } = params;
  const formData = await request.formData();

  const slideId = formData.get('slideId');
  const field = formData.get('field');
  const value = formData.get('value');

  // Authorization: require OWNER or TEACHER to modify slide settings
  await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'SLIDES',
    attemptedAction: 'update_slide_visibility',
  });

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

    await prisma.slide.update({
      where: { id: slideId },
      data: { is_draft, is_public },
    });

    return { success: true };
  }

  // Handle boolean toggles (allow_team_edit, show_speaker_notes)
  if (field === 'allow_team_edit' || field === 'show_speaker_notes') {
    await prisma.slide.update({
      where: { id: slideId },
      data: { [field]: value === 'true' },
    });

    return { success: true };
  }

  return { error: 'Invalid field' };
};

// Helper to compute status from is_draft and is_public
function getSlideStatus(slide) {
  if (slide.is_draft) return 'draft';
  if (slide.is_public) return 'public';
  return 'private';
}

// Status badge component
function StatusBadge({ status }) {
  const config = {
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

export default function SlidesAdmin() {
  const { slides, org, slidesUrl, slideViewers } = useLoaderData();
  const fetcher = useFetcher();

  // Handle field updates
  const updateSlideField = (slideId, field, value) => {
    fetcher.submit(
      { slideId, field, value: String(value) },
      { method: 'post' }
    );
  };

  const columns = [
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
      width: 250,
      render: (title, record) => (
        <a
          href={`${slidesUrl}/${record.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium !text-gray-600 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400"
        >
          {title}
        </a>
      ),
    },
    {
      title: 'Viewers',
      key: 'viewers',
      width: 120,
      render: (_, record) => {
        const viewerData = slideViewers[`slides/${record.id}`] || { viewers: [], totalCount: 0 };
        return <RecentViewers viewers={viewerData.viewers} totalCount={viewerData.totalCount} groupByRole />;
      },
    },
    {
      title: 'Status',
      key: 'status',
      width: 130,
      render: (_, record) => {
        const status = getSlideStatus(record);
        return (
          <Select
            value={status}
            size="small"
            style={{ width: 110 }}
            onChange={value => updateSlideField(record.id, 'status', value)}
            options={[
              { value: 'draft', label: <span className="flex items-center gap-1"><IconEyeOff size={14} /> Draft</span> },
              { value: 'private', label: <span className="flex items-center gap-1"><IconLock size={14} /> Private</span> },
              { value: 'public', label: <span className="flex items-center gap-1"><IconWorld size={14} /> Public</span> },
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
      render: (_, record) => (
        <Switch
          size="small"
          checked={record.allow_team_edit}
          onChange={checked => updateSlideField(record.id, 'allow_team_edit', checked)}
        />
      ),
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
      render: (_, record) => (
        <Switch
          size="small"
          checked={record.show_speaker_notes}
          onChange={checked => updateSlideField(record.id, 'show_speaker_notes', checked)}
        />
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      render: (_, record) => (
        <TableActionButtons
          onView={() => window.open(`${slidesUrl}/${record.id}`, '_blank')}
          onEdit={() => window.open(`${slidesUrl}/${record.id}?mode=edit`, '_blank')}
          onDelete={() => window.open(`${slidesUrl}/${org.slug}/${record.id}/delete`, '_blank')}
          skipDeleteConfirm
        >
          <a
            href={`${slidesUrl}/${record.id}/present`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 !text-gray-600 hover:text-gray-800 no-underline cursor-pointer"
          >
            <IconPresentation size={17} />
            <span>Present</span>
          </a>
        </TableActionButtons>
      ),
    },
  ];

  return (
    <div>
      <div className="mb-2 flex justify-between items-start">
        <PageHeader title="Slides" routeName="slides" />
        <div className="flex items-center gap-3">
          <Button
            onClick={() => {
              const url = `${slidesUrl}/import?class=${org.slug}`;
              window.open(url, '_blank');
            }}
          >
            Import from Slides.com
          </Button>
          <Button
            type="primary"
            icon={<IconPlus size={16} />}
            onClick={() => window.open(`${slidesUrl}/${org.slug}/new`, '_blank')}
          >
            Create Slide
          </Button>
        </div>
      </div>

      <div className="space-y-6">
        <div className="">
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
                  <div>No slides created yet</div>
                  <div className="text-sm">Create your first slide deck to get started!</div>
                </div>
              ),
            }}
          />
        </div>
      </div>
    </div>
  );
}
