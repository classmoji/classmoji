import { Input, InputNumber, Button, Table, Form, Card, Popconfirm, Alert, Select } from 'antd';
import { toast } from 'react-toastify';
import { useState, useRef, useEffect } from 'react';
import { useClickAway } from '@uidotdev/usehooks';

import { DeleteOutlined, WarningOutlined } from '@ant-design/icons';

import { SettingSection, Emoji } from '~/components';
import { useGlobalFetcher, useSubscription } from '~/hooks';

import tokenImage from '~/assets/images/token.png';
import EmojiPicker from './EmojiPicker';

const EmojiMapping = ({ emojiMappings, orphanedEmojis }) => {
  const [emoji, setEmoji] = useState('');
  const [grade, setGrade] = useState(null);
  const [extraTokens, setExtraTokens] = useState(0);
  const [description, setDescription] = useState('');
  const [remapSelections, setRemapSelections] = useState({});
  const { isProTier, isFreeTier } = useSubscription();

  // Inline editing state
  const [editingCell, setEditingCell] = useState(null); // { emoji: string, field: string }
  const [editValue, setEditValue] = useState(null);

  const { notify, fetcher } = useGlobalFetcher();

  // Handle inline cell update
  const handleCellUpdate = (emojiKey, field, value) => {
    const mapping = emojiMappings.find(m => m.emoji === emojiKey);
    if (!mapping) return;

    fetcher.submit(
      {
        emoji: mapping.emoji,
        grade: field === 'grade' ? parseFloat(value) : mapping.grade,
        extra_tokens: field === 'extra_tokens' ? parseInt(value) : mapping.extra_tokens,
        description: field === 'description' ? value : mapping.description,
      },
      {
        action: '?/saveEmojiToGradeMapping',
        method: 'POST',
        encType: 'application/json',
      }
    );
    setEditingCell(null);
    setEditValue(null);
  };

  // Start editing a cell
  const startEditing = (emojiKey, field, currentValue) => {
    setEditingCell({ emoji: emojiKey, field });
    setEditValue(currentValue);
  };

  // Cancel editing without saving
  const cancelEditing = () => {
    setEditingCell(null);
    setEditValue(null);
  };

  const handleRemapSelection = (oldEmoji, newEmoji) => {
    setRemapSelections(prev => ({ ...prev, [oldEmoji]: newEmoji }));
  };

  const remapAllOrphans = () => {
    const mappings = Object.entries(remapSelections)
      .filter(([_, newEmoji]) => newEmoji)
      .map(([oldEmoji, newEmoji]) => ({ oldEmoji, newEmoji }));

    if (mappings.length === 0) {
      return toast.error('Please select a new emoji for at least one orphaned grade.');
    }

    notify('Remapping grades...');

    fetcher.submit(
      { mappings },
      {
        action: '?/remapOrphanedEmojis',
        method: 'POST',
        encType: 'application/json',
      }
    );

    setRemapSelections({});
  };

  const createEmojiMapping = () => {
    if (!emoji || !grade) {
      return toast.error('Please select an emoji and enter a numeric value.');
    }

    notify('Creating emoji mapping...');

    fetcher.submit(
      {
        grade: parseFloat(grade),
        emoji: emoji,
        extra_tokens: parseInt(extraTokens),
        description: description,
      },
      {
        action: '?/saveEmojiToGradeMapping',
        method: 'POST',
        encType: 'application/json',
      }
    );

    setEmoji(null);
    setGrade(null);
    setExtraTokens(0);
    setDescription('');
  };

  const deleteMapping = async record => {
    notify('Deleting emoji mapping...');

    fetcher.submit(
      {
        emoji: record.emoji,
      },
      {
        action: '?/deleteEmojiToGradeMapping',
        method: 'DELETE',
        encType: 'application/json',
      }
    );
  };

  const populateDefaults = () => {
    notify('Adding default emoji mappings...');

    fetcher.submit(
      {},
      {
        action: '?/populateDefaultMappings',
        method: 'POST',
        encType: 'application/json',
      }
    );
  };

  const emojiMappingColumns = [
    {
      title: 'Emoji',
      dataIndex: 'emoji',
      key: 'emoji',
      width: '15%',
      render: emoji => {
        return (
          <div className="flex justify-center">
            <Emoji emoji={emoji} size="lg" />
          </div>
        );
      },
    },
    {
      title: 'Grade',
      dataIndex: 'grade',
      key: 'grade',
      width: '15%',
      render: (grade, record) => {
        const isEditing = editingCell?.emoji === record.emoji && editingCell?.field === 'grade';
        if (isEditing) {
          return (
            <InputNumber
              autoFocus
              size="small"
              min={0}
              max={100}
              value={editValue}
              onChange={value => setEditValue(value)}
              onPressEnter={() => handleCellUpdate(record.emoji, 'grade', editValue)}
              onBlur={() => handleCellUpdate(record.emoji, 'grade', editValue)}
              className="w-16"
            />
          );
        }
        return (
          <button
            type="button"
            onClick={() => startEditing(record.emoji, 'grade', grade)}
            className={`font-semibold cursor-pointer bg-transparent border-none p-0 m-0 hover:underline ${
              grade >= 90
                ? 'text-green-600'
                : grade >= 80
                  ? 'text-yellow-600'
                  : grade >= 70
                    ? 'text-orange-600'
                    : 'text-red-600'
            }`}
          >
            {grade}
          </button>
        );
      },
    },
    {
      title: 'Tokens',
      dataIndex: 'extra_tokens',
      hidden: isFreeTier,
      key: 'extra_tokens',
      width: '15%',
      render: (_, record) => {
        const isEditing = editingCell?.emoji === record.emoji && editingCell?.field === 'extra_tokens';
        if (isEditing) {
          return (
            <div className="flex items-center justify-center gap-2">
              <img src={tokenImage} alt="token" className="w-4 h-4" />
              <InputNumber
                autoFocus
                size="small"
                min={0}
                value={editValue}
                onChange={value => setEditValue(value)}
                onPressEnter={() => handleCellUpdate(record.emoji, 'extra_tokens', editValue)}
                onBlur={() => handleCellUpdate(record.emoji, 'extra_tokens', editValue)}
                className="w-14"
              />
            </div>
          );
        }
        return (
          <button
            type="button"
            onClick={() => startEditing(record.emoji, 'extra_tokens', record.extra_tokens)}
            className="flex items-center justify-center gap-2 cursor-pointer bg-transparent border-none p-0 m-0 hover:underline w-full"
          >
            <img src={tokenImage} alt="token" className="w-4 h-4" />
            <span className="font-medium">{record.extra_tokens}</span>
          </button>
        );
      },
    },
    {
      title: 'Description',
      dataIndex: 'description',
      key: 'description',
      render: (description, record) => {
        const isEditing = editingCell?.emoji === record.emoji && editingCell?.field === 'description';
        if (isEditing) {
          return (
            <Input
              autoFocus
              size="small"
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onPressEnter={() => handleCellUpdate(record.emoji, 'description', editValue)}
              onBlur={() => handleCellUpdate(record.emoji, 'description', editValue)}
              placeholder="Enter description..."
            />
          );
        }
        return (
          <button
            type="button"
            onClick={() => startEditing(record.emoji, 'description', description || '')}
            className="text-gray-700 cursor-pointer bg-transparent border-none p-0 m-0 hover:underline text-left"
          >
            {description || <span className="text-gray-400 italic">No description</span>}
          </button>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: '10%',
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

  return (
    <SettingSection
      title="Emoji Mapping"
      description="Assign emojis to represent specific numerical values in your grading system."
    >
      {orphanedEmojis?.length > 0 && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          className="mb-6"
          message="Orphaned Grades Detected"
          description={
            <div className="mt-2">
              <p className="mb-3 text-gray-600">
                The following emoji grades are used but no longer have mappings. Select a new emoji
                for each to fix:
              </p>
              <div className="space-y-2">
                {orphanedEmojis.map(({ emoji: oldEmoji, count }) => (
                  <div key={oldEmoji} className="flex items-center gap-3">
                    <div className="flex items-center gap-2 min-w-[140px]">
                      <Emoji emoji={oldEmoji} size="sm" />
                      <span className="text-gray-700 font-mono text-sm">{oldEmoji}</span>
                      <span className="text-gray-500 text-xs">({count})</span>
                    </div>
                    <span className="text-gray-400">→</span>
                    <Select
                      placeholder="Select new emoji"
                      className="w-48"
                      value={remapSelections[oldEmoji]}
                      onChange={value => handleRemapSelection(oldEmoji, value)}
                      options={emojiMappings?.map(m => ({
                        value: m.emoji,
                        label: (
                          <div className="flex items-center gap-2">
                            <Emoji emoji={m.emoji} size="sm" />
                            <span>{m.emoji}</span>
                            <span className="text-gray-400">({m.grade})</span>
                          </div>
                        ),
                      }))}
                    />
                  </div>
                ))}
              </div>
              <Button
                type="primary"
                size="small"
                className="mt-4"
                onClick={remapAllOrphans}
                disabled={Object.keys(remapSelections).length === 0}
              >
                Remap All
              </Button>
            </div>
          }
        />
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Form Section */}
        <Card className="h-fit">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1 h-6 bg-yellow-400 rounded-full"></div>
            <h3 className="text-lg font-semibold text-gray-900">Add New Mapping</h3>
          </div>

          <Form layout="vertical" className="space-y-4">
            <Form.Item label="Emoji Grade" className="mb-4">
              <EmojiPicker setEmoji={setEmoji} emoji={emoji} />
            </Form.Item>

            <Form.Item label="Numeric Value" className="mb-4">
              <Input
                value={grade}
                onChange={e => setGrade(e.target.value)}
                type="number"
                placeholder="Enter grade value (0-100)"
                min={0}
                max={100}
                className="rounded-lg"
              />
            </Form.Item>

            {isProTier && (
              <Form.Item label="Extra Tokens" className="mb-4">
                <Input
                  value={extraTokens}
                  onChange={e => setExtraTokens(e.target.value)}
                  type="number"
                  min={0}
                  addonBefore={<img src={tokenImage} alt="token" className="w-4 h-4" />}
                  addonAfter="tokens"
                  className="rounded-lg"
                />
              </Form.Item>
            )}

            <Form.Item label="Description" className="mb-6">
              <Input.TextArea
                rows={3}
                placeholder="Optional description for this grade mapping..."
                value={description}
                onChange={e => setDescription(e.target.value)}
                className="rounded-lg"
              />
            </Form.Item>

            <Button type="primary" onClick={createEmojiMapping}>Save</Button>
          </Form>
        </Card>

        {/* Table Section */}
        <Card>
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-1 h-6 bg-yellow-400 rounded-full"></div>
              <h3 className="text-lg font-semibold text-gray-900">Current Mappings</h3>
              <span className="text-sm text-gray-500 bg-gray-100 px-2 py-1 rounded-full">
                {emojiMappings?.length || 0} total
              </span>
            </div>
            <Popconfirm
              title="Reset to defaults?"
              description="This will remove all existing mappings and add the default ones."
              onConfirm={populateDefaults}
              okText="Yes, reset"
              cancelText="Cancel"
            >
              <Button type="primary" size="small">Populate Defaults</Button>
            </Popconfirm>
          </div>

          <Table
            dataSource={emojiMappings?.length ? emojiMappings : []}
            columns={emojiMappingColumns}
            size="middle"
            pagination={false}
            rowHoverable={false}
            locale={{
              emptyText: (
                <div className="text-center py-8 text-gray-500">
                  <div className="text-4xl mb-2">😊</div>
                  <div>No emoji mappings yet</div>
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

export default EmojiMapping;
