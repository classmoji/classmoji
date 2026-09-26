import { Table, Tag, ConfigProvider } from 'antd';
import type { ParsedClassroom } from './utils';

interface Props {
  classrooms: ParsedClassroom[];
  selectedIds: Set<number>;
  onSelectionChange: (ids: Set<number>) => void;
}

/**
 * Step 2 — pick which of the exported classrooms to import. A bundle commonly
 * contains many; each selected one becomes its own Classmoji classroom.
 */
export default function StepSelectClassrooms({
  classrooms,
  selectedIds,
  onSelectionChange,
}: Props) {
  const columns = [
    {
      title: 'Classroom',
      dataIndex: 'name',
      key: 'name',
      width: 260,
      render: (name: string, row: ParsedClassroom) => (
        <span>
          {name}{' '}
          {row.archived && (
            <Tag color="default" className="ml-1">
              Archived
            </Tag>
          )}
        </span>
      ),
    },
    {
      title: 'Organization',
      key: 'org',
      width: 220,
      render: (_: unknown, row: ParsedClassroom) => (
        <span className="text-gray-500 dark:text-gray-400">{row.organization.login}</span>
      ),
    },
    {
      title: 'Assignments',
      dataIndex: 'assignmentCount',
      key: 'assignments',
      align: 'right' as const,
      width: 96,
    },
    {
      title: 'Students',
      dataIndex: 'studentCount',
      key: 'students',
      align: 'right' as const,
      width: 84,
    },
    {
      title: 'Grades',
      key: 'grades',
      align: 'right' as const,
      width: 96,
      render: (_: unknown, row: ParsedClassroom) =>
        row.grades.length ? row.grades.length : <span className="text-gray-400">—</span>,
    },
  ];

  return (
    <div>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
        Select the classrooms to bring into Classmoji. Each becomes a new classroom with its roster,
        assignments, and student repositories.
      </p>
      {/* Brand green is the antd primary, so the default selected-row fill comes
          out as a solid, hard-to-read green. Tone it down to a faint translucent
          tint that stays legible in both light and dark modes; the checkbox is
          the real selection signal. */}
      <ConfigProvider
        theme={{
          components: {
            Table: {
              rowSelectedBg: 'rgba(22, 163, 74, 0.08)',
              rowSelectedHoverBg: 'rgba(22, 163, 74, 0.14)',
            },
          },
        }}
      >
        <Table
          rowKey="githubId"
          size="small"
          pagination={false}
          dataSource={classrooms}
          columns={columns}
          rowSelection={{
            selectedRowKeys: Array.from(selectedIds),
            onChange: keys => onSelectionChange(new Set(keys as number[])),
          }}
          scroll={{ y: 360 }}
        />
      </ConfigProvider>
    </div>
  );
}
