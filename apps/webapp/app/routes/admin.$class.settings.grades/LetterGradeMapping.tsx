import { Input, InputNumber, Button, Table, Popconfirm } from 'antd';
import { useState } from 'react';

import { DeleteOutlined } from '@ant-design/icons';

import { SettingSection } from '~/components';
import { useCallout } from '@classmoji/ui-components';
import { useGlobalFetcher } from '~/hooks';

interface LetterGradeMap {
  letter_grade: string;
  min_grade: number;
}

interface LetterGradeMappingProps {
  letterGradeMappings: LetterGradeMap[];
}

const LetterGradeMapping = ({ letterGradeMappings }: LetterGradeMappingProps) => {
  const [letterGrade, setLetterGrade] = useState('');
  const [minGrade, setMinGrade] = useState<string | null>(null);

  const [editingCell, setEditingCell] = useState<{ letterGrade: string } | null>(null);
  const [editValue, setEditValue] = useState<number | null>(null);

  const { notify, fetcher } = useGlobalFetcher();
  const callout = useCallout();

  const handleCellUpdate = (letterGradeKey: string, newMinGrade: number | null) => {
    fetcher!.submit(
      {
        letter_grade: letterGradeKey,
        min_grade: newMinGrade != null ? parseFloat(String(newMinGrade)) : 0,
      },
      {
        action: '?/saveLetterGradeMapping',
        method: 'POST',
        encType: 'application/json',
      }
    );
    setEditingCell(null);
    setEditValue(null);
  };

  const startEditing = (letterGradeKey: string, currentValue: number) => {
    setEditingCell({ letterGrade: letterGradeKey });
    setEditValue(currentValue);
  };

  const createLetterGradeMapping = () => {
    if (!letterGrade || !minGrade) {
      return callout.show({
        variant: 'error',
        title: 'Please enter a letter grade and a minimum numeric value.',
      });
    }

    notify('Creating letter grade mapping...');

    fetcher!.submit(
      {
        letter_grade: letterGrade,
        min_grade: parseFloat(minGrade),
      },
      {
        action: '?/saveLetterGradeMapping',
        method: 'POST',
        encType: 'application/json',
      }
    );

    setLetterGrade('');
    setMinGrade(null);
  };

  const deleteMapping = async (record: LetterGradeMap) => {
    notify('Deleting letter grade mapping...');

    fetcher!.submit(
      {
        letter_grade: record.letter_grade,
      },
      {
        action: '?/deleteLetterGradeMapping',
        method: 'DELETE',
        encType: 'application/json',
      }
    );
  };

  const populateDefaults = () => {
    notify('Adding default letter grade mappings...');

    fetcher!.submit(
      {},
      {
        action: '?/populateDefaultLetterGradeMappings',
        method: 'POST',
        encType: 'application/json',
      }
    );
  };

  const letterGradeMappingColumns = [
    {
      title: 'Letter Grade',
      dataIndex: 'letter_grade',
      key: 'letter_grade',
      width: 120,
      render: (grade: string) => (
        <span
          className={`font-bold px-3 py-1 rounded-lg text-sm ${
            grade === 'A'
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
              : grade === 'B'
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                : grade === 'C'
                  ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                  : grade === 'D'
                    ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                    : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
          }`}
        >
          {grade}
        </span>
      ),
    },
    {
      title: 'Minimum Grade',
      dataIndex: 'min_grade',
      key: 'min_grade',
      render: (grade: number, record: LetterGradeMap) => {
        const isEditing = editingCell?.letterGrade === record.letter_grade;
        if (isEditing) {
          return (
            <InputNumber
              size="small"
              min={0}
              max={100}
              value={editValue}
              onChange={value => setEditValue(value)}
              onPressEnter={() => handleCellUpdate(record.letter_grade, editValue)}
              onBlur={() => handleCellUpdate(record.letter_grade, editValue)}
              className="w-20"
              addonAfter="%"
            />
          );
        }
        return (
          <button
            type="button"
            onClick={() => startEditing(record.letter_grade, grade)}
            className="font-medium text-ink-1 cursor-pointer bg-transparent border-none p-0 m-0 hover:underline"
          >
            {grade}%
          </button>
        );
      },
    },
    {
      title: '',
      key: 'actions',
      width: 48,
      render: (_: unknown, record: LetterGradeMap) => (
        <Button
          type="text"
          icon={<DeleteOutlined />}
          onClick={() => deleteMapping(record)}
          className="text-red-500 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
          size="small"
        />
      ),
    },
  ];

  const sortedMappings =
    letterGradeMappings?.sort(
      (a: LetterGradeMap, b: LetterGradeMap) => b.min_grade - a.min_grade
    ) || [];

  return (
    <SettingSection
      title="Letter Grade Mapping"
      description="Define the letter grades and their corresponding minimum numeric values."
    >
      <div className="rounded-2xl ring-1 ring-line overflow-hidden">
        <div className="px-4 sm:px-5 py-4 border-b border-line bg-panel">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-ink-0">Letter Grades</span>
              <span className="text-xs text-ink-3 bg-nav-hover px-2 py-0.5 rounded-full tabular-nums">
                {sortedMappings.length}
              </span>
            </div>
            <Popconfirm
              title="Reset to defaults?"
              description="This will remove all existing mappings and add the standard A-F scale."
              onConfirm={populateDefaults}
              okText="Yes, reset"
              cancelText="Cancel"
            >
              <Button size="small">Populate Defaults</Button>
            </Popconfirm>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Input
              placeholder="Letter (e.g. A)"
              value={letterGrade}
              onChange={e => setLetterGrade(e.target.value.toUpperCase())}
              maxLength={2}
              className="!w-28"
            />
            <Input
              placeholder="Min value"
              value={minGrade ?? undefined}
              onChange={e => setMinGrade(e.target.value)}
              type="number"
              min={0}
              max={100}
              addonAfter="%"
              className="!w-32"
            />
            <Button type="primary" onClick={createLetterGradeMapping}>
              Add
            </Button>
          </div>
        </div>

        <Table
          dataSource={sortedMappings}
          columns={letterGradeMappingColumns}
          size="small"
          scroll={{ x: 'max-content' }}
          pagination={false}
          rowHoverable={false}
          rowKey="letter_grade"
          locale={{
            emptyText: (
              <div className="text-center py-8">
                <div className="font-medium text-ink-3">No letter grade mappings yet</div>
                <div className="text-sm text-ink-4">Add your first mapping above</div>
              </div>
            ),
          }}
        />
      </div>
    </SettingSection>
  );
};

export default LetterGradeMapping;
