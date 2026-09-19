import { useState } from 'react';

import { SettingSection, TableActionButtons } from '~/components';
import { Input, Button, Table, Tag } from 'antd';
import { useCallout } from '@classmoji/ui-components';
import { useGlobalFetcher } from '~/hooks';

interface Tag {
  id: string;
  name: string;
}

interface TagSectionProps {
  tags: Tag[];
}

const TagSection = ({ tags }: TagSectionProps) => {
  const [name, setName] = useState('');
  const { fetcher } = useGlobalFetcher();
  const callout = useCallout();

  const createTag = () => {
    // Compare and submit the trimmed name — the action trims too, so an untrimmed
    // check here would wave through a duplicate and then silently create nothing.
    const trimmedName = name.trim();
    if (!trimmedName) {
      callout.show({ variant: 'error', title: 'Please enter a tag name' });
      return;
    }

    if (tags.find((tag: Tag) => tag.name === trimmedName)) {
      callout.show({ variant: 'error', title: 'Tag already exists' });
      return;
    }

    fetcher!.submit(
      { name: trimmedName },
      { action: '?/createTag', method: 'POST', encType: 'application/json' }
    );

    setName('');
  };

  const deleteTag = (tagId: string) => {
    fetcher!.submit(
      { tagId },
      { action: '?/deleteTag', method: 'POST', encType: 'application/json' }
    );
  };

  const columns = [
    {
      title: 'Tag',
      dataIndex: 'name',
      width: 200,
      render: (tag: string) => <Tag>#{tag}</Tag>,
    },
    {
      title: 'Action(s)',
      width: 200,

      render: (_: unknown, tag: Tag) => {
        return <TableActionButtons onDelete={() => deleteTag(tag.id)} />;
      },
    },
  ];

  return (
    <SettingSection
      title="Tags"
      description="Create tags to categorize teams and use them to filter teams."
    >
      <div className="w-3/4">
        <div className="flex items-center gap-2 mb-4">
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Enter a tag name"
          />

          <Button type="primary" onClick={createTag}>
            Create
          </Button>
        </div>

        <Table
          dataSource={tags}
          columns={columns}
          rowHoverable={false}
          scroll={{ x: 'max-content' }}
        />
      </div>
    </SettingSection>
  );
};

export default TagSection;
