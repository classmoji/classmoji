import { Input, InputNumber, Button, Table, Popconfirm, Alert, Select } from 'antd';
import { useState } from 'react';

import { DeleteOutlined, WarningOutlined } from '@ant-design/icons';

import { SettingSection, Emoji } from '~/components';
import { useCallout } from '@classmoji/ui-components';
import { useGlobalFetcher, useSubscription } from '~/hooks';

import tokenImage from '~/assets/images/token.png';
import EmojiPicker from './EmojiPicker';

interface EmojiMappingRecord {
  emoji: string;
  grade: number;
  extra_tokens: number;
  description: string;
  [key: string]: unknown;
}

interface OrphanedEmoji {
  emoji: string;
  count: number;
}

interface EditingCell {
  emoji: string;
  field: 'grade' | 'extra_tokens' | 'description';
}

interface EmojiMappingProps {
  emojiMappings: EmojiMappingRecord[];
  orphanedEmojis?: OrphanedEmoji[];
}

const EmojiMapping = ({ emojiMappings, orphanedEmojis }: EmojiMappingProps) => {
  const [emoji, setEmoji] = useState('');
  const [grade, setGrade] = useState<string | null>(null);
  const [extraTokens, setExtraTokens] = useState(0);
  const [description, setDescription] = useState('');
  const [remapSelections, setRemapSelections] = useState<Record<string, string>>({});
  const { isFreeTier } = useSubscription();

  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [editValue, setEditValue] = useState<string | number | null>(null);

  const { notify, fetcher } = useGlobalFetcher();
  const callout = useCallout();

  const handleCellUpdate = (emojiKey: string, field: string, value: string | number | null) => {
    const mapping = emojiMappings.find(m => m.emoji === emojiKey);
    if (!mapping) return;

    fetcher!.submit(
      {
        emoji: mapping.emoji,
        grade: field === 'grade' ? parseFloat(String(value)) : mapping.grade,
        extra_tokens: field === 'extra_tokens' ? parseInt(String(value)) : mapping.extra_tokens,
        description: field === 'description' ? String(value ?? '') : mapping.description,
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

  const startEditing = (
    emojiKey: string,
    field: EditingCell['field'],
    currentValue: string | number | null
  ) => {
    setEditingCell({ emoji: emojiKey, field });
    setEditValue(currentValue);
  };

  const handleRemapSelection = (oldEmoji: string, newEmoji: string) => {
    setRemapSelections(prev => ({ ...prev, [oldEmoji]: newEmoji }));
  };

  const remapAllOrphans = () => {
    const mappings = Object.entries(remapSelections)
      .filter(([_, newEmoji]) => newEmoji)
      .map(([oldEmoji, newEmoji]) => ({ oldEmoji, newEmoji }));

    if (mappings.length === 0) {
      return callout.show({
        variant: 'error',
        title: 'Please select a new emoji for at least one orphaned grade.',
      });
    }

    notify('Remapping grades...');

    fetcher!.submit(
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
      return callout.show({
        variant: 'error',
        title: 'Please select an emoji and enter a numeric value.',
      });
    }

    notify('Creating emoji mapping...');

    fetcher!.submit(
      {
        grade: parseFloat(grade),
        emoji: emoji,
        extra_tokens: extraTokens,
        description: description,
      },
      {
        action: '?/saveEmojiToGradeMapping',
        method: 'POST',
        encType: 'application/json',
      }
    );

    setEmoji('');
    setGrade(null);
    setExtraTokens(0);
    setDescription('');
  };

  const deleteMapping = async (record: EmojiMappingRecord) => {
    notify('Deleting emoji mapping...');

    fetcher!.submit(
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

    fetcher!.submit(
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
      width: 72,
      render: (emoji: string) => (
        <div className="flex justify-center">
          <Emoji emoji={emoji} size="lg" />
        </div>
      ),
    },
    {
      title: 'Grade',
      dataIndex: 'grade',
      key: 'grade',
      width: 80,
      render: (grade: number, record: EmojiMappingRecord) => {
        const isEditing = editingCell?.emoji === record.emoji && editingCell?.field === 'grade';
        if (isEditing) {
          return (
            <InputNumber
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
      width: 90,
      render: (_: number, record: EmojiMappingRecord) => {
        const isEditing =
          editingCell?.emoji === record.emoji && editingCell?.field === 'extra_tokens';
        if (isEditing) {
          return (
            <div className="flex items-center justify-center gap-2">
              <img src={tokenImage} alt="token" className="w-4 h-4" />
              <InputNumber
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
      render: (description: string, record: EmojiMappingRecord) => {
        const isEditing =
          editingCell?.emoji === record.emoji && editingCell?.field === 'description';
        if (isEditing) {
          return (
            <Input
              size="small"
              value={editValue as string}
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
            className="text-ink-1 cursor-pointer bg-transparent border-none p-0 m-0 hover:underline text-left"
          >
            {description || <span className="text-ink-4 italic">No description</span>}
          </button>
        );
      },
    },
    {
      title: '',
      key: 'actions',
      width: 48,
      render: (_: unknown, record: EmojiMappingRecord) => (
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

  return (
    <SettingSection
      title="Emoji Mapping"
      description="Assign emojis to represent specific numerical values in your grading system."
    >
      <div className="flex flex-col gap-6">
        {(orphanedEmojis?.length ?? 0) > 0 && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message="Orphaned Grades Detected"
          description={
            <div className="mt-2">
              <p className="mb-3 text-ink-2">
                The following emoji grades are used but no longer have mappings. Select a new emoji
                for each to fix:
              </p>
              <div className="space-y-2">
                {orphanedEmojis!.map(({ emoji: oldEmoji, count }) => (
                  <div key={oldEmoji} className="flex items-center gap-3">
                    <div className="flex items-center gap-2 min-w-[140px]">
                      <Emoji emoji={oldEmoji} size="sm" />
                      <span className="text-ink-1 font-mono text-sm">{oldEmoji}</span>
                      <span className="text-ink-3 text-xs">({count})</span>
                    </div>
                    <span className="text-ink-4">&rarr;</span>
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
                            <span className="text-ink-4">({m.grade})</span>
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

      <div className="rounded-2xl ring-1 ring-line overflow-hidden">
        <div className="px-4 sm:px-5 py-4 border-b border-line bg-panel">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-ink-0">Emoji Mappings</span>
              <span className="text-xs text-ink-3 bg-nav-hover px-2 py-0.5 rounded-full tabular-nums">
                {emojiMappings?.length || 0}
              </span>
            </div>
            <Popconfirm
              title="Reset to defaults?"
              description="This will remove all existing mappings and add the default ones."
              onConfirm={populateDefaults}
              okText="Yes, reset"
              cancelText="Cancel"
            >
              <Button size="small">Populate Defaults</Button>
            </Popconfirm>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <EmojiPicker setEmoji={setEmoji} emoji={emoji} />
            <Input
              value={grade ?? undefined}
              onChange={e => setGrade(e.target.value)}
              type="number"
              placeholder="Grade (0-100)"
              min={0}
              max={100}
              className="!w-28"
            />
            <Input
              value={extraTokens}
              onChange={e => setExtraTokens(parseInt(e.target.value) || 0)}
              type="number"
              min={0}
              placeholder="Tokens"
              addonBefore={<img src={tokenImage} alt="token" className="w-4 h-4" />}
              className="!w-28"
            />
            <Input
              placeholder="Description (optional)"
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="flex-1 !min-w-[140px]"
            />
            <Button type="primary" onClick={createEmojiMapping}>
              Add
            </Button>
          </div>
        </div>

        <Table
          dataSource={emojiMappings?.length ? emojiMappings : []}
          columns={emojiMappingColumns}
          size="small"
          pagination={false}
          rowHoverable={false}
          rowKey="emoji"
          locale={{
            emptyText: (
              <div className="text-center py-8">
                <div className="font-medium text-ink-3">No emoji mappings yet</div>
                <div className="text-sm text-ink-4">Add your first mapping above</div>
              </div>
            ),
          }}
        />
      </div>
      </div>
    </SettingSection>
  );
};

export default EmojiMapping;
