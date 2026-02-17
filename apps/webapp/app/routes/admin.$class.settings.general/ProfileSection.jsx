import { Button, Form, Input, Select } from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';

import { useGlobalFetcher } from '~/hooks';
import { SettingSection } from '~/components';
import { ActionTypes } from '~/constants';

const ProfileSection = ({ organization }) => {
  const [name, setName] = useState(organization.name);
  const [term, setTerm] = useState(organization.term);
  const [year, setYear] = useState(organization.year);

  const { notify, fetcher } = useGlobalFetcher();

  const saveProfile = () => {
    notify(ActionTypes.SAVE_PROFILE, 'Saving profile...');

    fetcher.submit(
      {
        name,
        term,
        year,
      },
      {
        action: '?/saveProfile',
        method: 'POST',
        encType: 'application/json',
      }
    );
  };

  const currentYear = dayjs().year();

  const yearOptions = Array.from({ length: 10 }, (_, i) => currentYear + i).map(year => {
    return (
      <Select.Option key={year} value={year}>
        {year}
      </Select.Option>
    );
  });

  return (
    <SettingSection title="Profile" description="Change the profile of your classroom.">
      <Form layout="vertical">
        <Form.Item label="Course name">
          <Input value={name} onChange={e => setName(e.target.value)} />
        </Form.Item>

        <div className="grid grid-cols-2 gap-3">
          <Form.Item label="Term">
            <Select value={term} onChange={setTerm}>
              <Select.Option value="FALL">Fall</Select.Option>
              <Select.Option value="SPRING">Spring</Select.Option>
              <Select.Option value="SUMMER">Summer</Select.Option>
              <Select.Option value="WINTER">Winter</Select.Option>
            </Select>
          </Form.Item>
          <Form.Item label="Year">
            <Select value={year} onChange={setYear}>
              {yearOptions}
            </Select>
          </Form.Item>
        </div>

        <Button type="primary" onClick={saveProfile}>Save</Button>
      </Form>
    </SettingSection>
  );
};

export default ProfileSection;
