import { Table, Button, Popconfirm, Tag } from 'antd';
import type { AutogradingTestData } from './FormAutogradingTest';

const METHOD_LABELS: Record<string, string> = {
  COMMAND: 'Run command',
  IO: 'Input / output',
  PYTHON: 'Python',
  JAVA: 'Java',
  NODE: 'Node',
  C: 'C',
  CPP: 'C++',
};

interface AutogradingTestsTableProps {
  tests: AutogradingTestData[];
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
}

const AutogradingTestsTable = ({ tests, onEdit, onRemove }: AutogradingTestsTableProps) => {
  if (!tests.length) {
    return (
      <div className="text-center py-8 text-gray-500">
        <div className="font-medium">No tests added yet</div>
        <div className="text-sm">Add a test to enable autograding</div>
      </div>
    );
  }

  const columns = [
    {
      title: 'Test',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => name || 'Untitled',
    },
    {
      title: 'Method',
      dataIndex: 'method',
      key: 'method',
      render: (method: string) => <Tag>{METHOD_LABELS[method] ?? method}</Tag>,
    },
    {
      title: 'Run command',
      dataIndex: 'run_command',
      key: 'run_command',
      render: (command: string) => <code className="text-xs text-ink-2">{command || '—'}</code>,
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: unknown, __: AutogradingTestData, index: number) => (
        <div className="flex">
          <Button type="link" className="pl-0" onClick={() => onEdit(index)}>
            Edit
          </Button>
          <Popconfirm
            title="Delete test"
            description="Remove this autograding test?"
            onConfirm={() => onRemove(index)}
            okText="Yes"
            cancelText="No"
            okButtonProps={{ danger: true }}
          >
            <Button type="link" danger className="pl-0">
              Delete
            </Button>
          </Popconfirm>
        </div>
      ),
    },
  ];

  return (
    <Table
      className="mt-4"
      columns={columns}
      dataSource={tests.map((test, index) => ({ ...test, key: index }))}
      rowHoverable={false}
      size="small"
      pagination={false}
      scroll={{ x: 'max-content' }}
    />
  );
};

export default AutogradingTestsTable;
