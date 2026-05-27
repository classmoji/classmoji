import { Button, Form, Input } from 'antd';
import { useState } from 'react';

import { useGlobalFetcher } from '~/hooks';
import { SettingSection } from '~/components';

interface ProfileSectionProps {
  organization: { name: string };
}

const ProfileSection = ({ organization }: ProfileSectionProps) => {
  const [name, setName] = useState(organization.name);

  const { fetcher } = useGlobalFetcher();

  const saveProfile = () => {
    if (!fetcher) return;

    fetcher.submit(
      { name },
      {
        action: '?/saveProfile',
        method: 'POST',
        encType: 'application/json',
      }
    );
  };

  return (
    <SettingSection title="Profile" description="Change the profile of your classroom.">
      <Form layout="vertical">
        <Form.Item label="Course name">
          <Input value={name} onChange={e => setName(e.target.value)} />
        </Form.Item>

        <Button type="primary" onClick={saveProfile}>
          Save
        </Button>
      </Form>
    </SettingSection>
  );
};

export default ProfileSection;
