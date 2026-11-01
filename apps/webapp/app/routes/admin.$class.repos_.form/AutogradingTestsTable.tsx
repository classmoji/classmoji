import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Table, Button, Popconfirm, Tag } from 'antd';
import { IconGripVertical } from '@tabler/icons-react';
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
  /** Move the test at `from` to `to`; the tests run in this order. */
  onMove: (from: number, to: number) => void;
}

const AutogradingTestsTable = ({ tests, onEdit, onRemove, onMove }: AutogradingTestsTableProps) => {
  // The row being dragged and the row it would land on (native drag and drop).
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  if (!tests.length) {
    return (
      <div className="text-center py-8 text-gray-500">
        <div className="font-medium">No tests added yet</div>
        <div className="text-sm">Add a test to enable autograding</div>
      </div>
    );
  }

  const endDrag = () => {
    setDragIndex(null);
    setOverIndex(null);
  };

  // The handle is a button, so the order can also be changed from the keyboard.
  const onHandleKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const to = event.key === 'ArrowUp' ? index - 1 : index + 1;
    if (to < 0 || to >= tests.length) return;
    onMove(index, to);
    // Keep focus on the moved test's handle.
    requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>(`[data-test-handle="${to}"]`)?.focus()
    );
  };

  const columns = [
    {
      title: <span className="sr-only">Order</span>,
      key: 'order',
      width: 56,
      render: (_: unknown, test: AutogradingTestData, index: number) => (
        <button
          type="button"
          data-test-handle={index}
          aria-label={`Move ${test.name || 'test'}: drag, or press the up and down arrow keys`}
          onKeyDown={event => onHandleKey(event, index)}
          className="inline-flex items-center gap-1 cursor-grab active:cursor-grabbing rounded px-1 py-0.5 text-ink-3 hover:text-ink-1 hover:bg-nav-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <IconGripVertical size={16} aria-hidden />
          <span className="text-xs tabular-nums">{index + 1}</span>
        </button>
      ),
    },
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

  // A line on the side the dragged row will land: above when moving up, below when moving down.
  const dropClass = (index: number) => {
    if (dragIndex === null || overIndex !== index || dragIndex === index) return '';
    return dragIndex > index
      ? '[&>td]:border-t-2 [&>td]:border-t-accent'
      : '[&>td]:border-b-2 [&>td]:border-b-accent';
  };

  return (
    <>
      <p className="mt-4 mb-2 text-xs text-ink-3">
        Tests run in this order. Drag a row by its handle to move it.
      </p>
      <Table
        columns={columns}
        dataSource={tests.map((test, index) => ({ ...test, key: index }))}
        rowHoverable={false}
        size="small"
        pagination={false}
        scroll={{ x: 'max-content' }}
        rowClassName={(_, index) =>
          `${dropClass(index)} ${dragIndex === index ? 'opacity-50' : ''}`.trim()
        }
        onRow={(_, index) => ({
          draggable: true,
          onDragStart: event => {
            if (index === undefined) return;
            setDragIndex(index);
            event.dataTransfer.effectAllowed = 'move';
            // Firefox starts a drag only when some data is set.
            event.dataTransfer.setData('text/plain', String(index));
          },
          onDragOver: event => {
            if (dragIndex === null || index === undefined) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            if (overIndex !== index) setOverIndex(index);
          },
          onDrop: event => {
            event.preventDefault();
            if (dragIndex !== null && index !== undefined) onMove(dragIndex, index);
            endDrag();
          },
          onDragEnd: endDrag,
        })}
      />
    </>
  );
};

export default AutogradingTestsTable;
