import { Table, Tag, ConfigProvider } from 'antd';
import type { ListedClassroom } from './utils';

interface Props {
  classrooms: ListedClassroom[];
  selectedIds: Set<number>;
  onSelectionChange: (ids: Set<number>) => void;
}

/**
 * Step 2 — pick which classrooms to import. Each selected one becomes its own
 * Classmoji classroom. Assignments, rosters, and grades are fetched per
 * classroom during the import itself, so only name/org are shown here.
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
      width: 320,
      render: (name: string, row: ListedClassroom) => (
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
      width: 240,
      render: (_: unknown, row: ListedClassroom) =>
        row.organization ? (
          <span className="text-gray-500 dark:text-gray-400">{row.organization.login}</span>
        ) : (
          <span className="text-red-500">No organization</span>
        ),
    },
  ];

  return (
    <div>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
        Select the classrooms to bring into Classmoji. Each becomes a new classroom with its roster,
        assignments, and student repositories, fetched live from GitHub during import.
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
            getCheckboxProps: (row: ListedClassroom) => ({ disabled: !row.organization }),
          }}
          scroll={{ y: 360 }}
        />
      </ConfigProvider>
    </div>
  );
}
