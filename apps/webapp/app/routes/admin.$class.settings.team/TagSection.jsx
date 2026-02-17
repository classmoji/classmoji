import { useState } from 'react';
import { toast } from 'react-toastify';

import { SettingSection, TableActionButtons } from '~/components';
import { Input, Button, Table, Tag } from 'antd';
import { useGlobalFetcher } from '~/hooks';

const TagSection = ({ tags }) => {
  const [name, setName] = useState('');
  const { fetcher } = useGlobalFetcher();

  const createTag = () => {
    if (tags.find(tag => tag.name === name)) {
      toast.error('Tag already exists');
      return;
    }

    fetcher.submit(
      { name },
      { action: '?/createTag', method: 'POST', encType: 'application/json' }
    );

    setName('');
  };

  const deleteTag = tagId => {
    fetcher.submit(
      { tagId },
      { action: '?/deleteTag', method: 'POST', encType: 'application/json' }
    );
  };

  const columns = [
    {
      title: 'Tag',
      dataIndex: 'name',
      width: '50%',
      render: tag => <Tag>#{tag}</Tag>,
    },
    {
      title: 'Action(s)',
      width: '50%',

      render: tag => {
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

          <Button type="primary" onClick={createTag}>Create</Button>
        </div>

        <Table dataSource={tags} columns={columns} rowHoverable={false} />
      </div>
    </SettingSection>
  );
};

export default TagSection;
