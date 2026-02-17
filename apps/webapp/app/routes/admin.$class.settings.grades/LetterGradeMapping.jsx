import { Input, InputNumber, Button, Table, Card, Form, Popconfirm } from 'antd';
import { toast } from 'react-toastify';
import { useState } from 'react';

import { DeleteOutlined } from '@ant-design/icons';

import { SettingSection } from '~/components';
import { useGlobalFetcher } from '~/hooks';

const LetterGradeMapping = ({ letterGradeMappings }) => {
  const [letterGrade, setLetterGrade] = useState('');
  const [minGrade, setMinGrade] = useState(null);

  // Inline editing state
  const [editingCell, setEditingCell] = useState(null); // { letterGrade: string }
  const [editValue, setEditValue] = useState(null);

  const { notify, fetcher } = useGlobalFetcher();

  // Handle inline cell update
  const handleCellUpdate = (letterGradeKey, newMinGrade) => {
    fetcher.submit(
      {
        letter_grade: letterGradeKey,
        min_grade: parseFloat(newMinGrade),
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

  // Start editing a cell
  const startEditing = (letterGradeKey, currentValue) => {
    setEditingCell({ letterGrade: letterGradeKey });
    setEditValue(currentValue);
  };

  const createLetterGradeMapping = () => {
    if (!letterGrade || !minGrade) {
      return toast.error('Please enter a letter grade and a minimum numeric value.');
    }

    notify('Creating letter grade mapping...');

    fetcher.submit(
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

  const deleteMapping = async record => {
    notify('Deleting letter grade mapping...');

    fetcher.submit(
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

    fetcher.submit(
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
      width: '30%',
      render: grade => (
        <span
          className={`font-bold  px-3 py-1 rounded-lg ${
            grade === 'A'
              ? 'bg-green-100 text-green-700'
              : grade === 'B'
                ? 'bg-blue-100 text-blue-700'
                : grade === 'C'
                  ? 'bg-yellow-100 text-yellow-700'
                  : grade === 'D'
                    ? 'bg-orange-100 text-orange-700'
                    : 'bg-red-100 text-red-700'
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
      width: '40%',
      render: (grade, record) => {
        const isEditing = editingCell?.letterGrade === record.letter_grade;
        if (isEditing) {
          return (
            <InputNumber
              autoFocus
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
            className="font-medium text-gray-700 cursor-pointer bg-transparent border-none p-0 m-0 hover:underline"
          >
            {grade}%
          </button>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: '30%',
      render: (_, record) => (
        <Button
          type="text"
          icon={<DeleteOutlined />}
          onClick={() => deleteMapping(record)}
          className="text-red-500 hover:text-red-700 hover:bg-red-50"
          size="small"
        />
      ),
    },
  ];

  const sortedMappings = letterGradeMappings?.sort((a, b) => b.min_grade - a.min_grade) || [];

  return (
    <SettingSection
      title="Letter Grade Mapping"
      description="Define the letter grades and their corresponding minimum numeric values."
    >
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Form Section */}
        <Card className="h-fit">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1 h-6 bg-yellow-400 rounded-full"></div>
            <h3 className="text-lg font-semibold text-gray-900">Add Grade Mapping</h3>
          </div>

          <Form layout="vertical" className="space-y-4">
            <Form.Item label="Letter Grade" className="mb-4">
              <Input
                placeholder="Letter grade (e.g., A, B, C)"
                value={letterGrade}
                onChange={e => setLetterGrade(e.target.value.toUpperCase())}
                className="rounded-lg"
                maxLength={2}
              />
            </Form.Item>

            <Form.Item label="Minimum Numeric Value" className="mb-6">
              <Input
                placeholder="Min numeric value (0-100)"
                value={minGrade}
                onChange={e => setMinGrade(e.target.value)}
                type="number"
                min={0}
                max={100}
                addonAfter="%"
                className="rounded-lg"
              />
            </Form.Item>

            <Button type="primary" onClick={createLetterGradeMapping}>Save</Button>
          </Form>
        </Card>

        {/* Table Section */}
        <Card>
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-1 h-6 bg-yellow-400 rounded-full"></div>
              <h3 className="text-lg font-semibold text-gray-900">Current Mappings</h3>
              <span className="text-sm text-gray-500 bg-gray-100 px-2 py-1 rounded-full">
                {sortedMappings.length} total
              </span>
            </div>
            <Popconfirm
              title="Reset to defaults?"
              description="This will remove all existing mappings and add the standard A-F scale."
              onConfirm={populateDefaults}
              okText="Yes, reset"
              cancelText="Cancel"
            >
              <Button type="primary" size="small">Populate Defaults</Button>
            </Popconfirm>
          </div>

          <Table
            dataSource={sortedMappings}
            columns={letterGradeMappingColumns}
            size="middle"
            pagination={false}
            rowHoverable={false}
            locale={{
              emptyText: (
                <div className="text-center py-8 text-gray-500">
                  <div className="text-4xl mb-2">📝</div>
                  <div>No letter grade mappings yet</div>
                  <div className="text-sm">Add your first mapping to get started!</div>
                </div>
              ),
            }}
            className="rounded-lg"
          />
        </Card>
      </div>
    </SettingSection>
  );
};

export default LetterGradeMapping;
