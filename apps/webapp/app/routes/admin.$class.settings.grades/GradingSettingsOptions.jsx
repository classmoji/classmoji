import { useState } from 'react';
import { Form, InputNumber, Button, Switch } from 'antd';

import { useGlobalFetcher } from '~/hooks';
import { SettingSection } from '~/components';

const GradingSettingsOptions = ({ settings }) => {
  const { fetcher, notify } = useGlobalFetcher();
  const [showGradesToStudents, setShowGradesToStudents] = useState(
    settings.show_grades_to_students
  );

  const onFinish = values => {
    notify('SAVE_GRADING_SETTINGS', 'Saving grading settings...');

    fetcher.submit(
      {
        late_penalty_points_per_hour: values.late_penalty_points_per_hour,
        show_grades_to_students: showGradesToStudents,
      },
      {
        action: '?/saveGradingSettings',
        method: 'POST',
        encType: 'application/json',
      }
    );
  };

  return (
    <SettingSection
      title="Grading Options"
      description="Set the default grading options for the organization."
    >
      <Form
        layout="vertical"
        className="w-[50%]"
        onFinish={onFinish}
        initialValues={{
          late_penalty_points_per_hour: settings.late_penalty_points_per_hour,
        }}
      >
        <Form.Item label="Late penalty points per hour" name="late_penalty_points_per_hour">
          <InputNumber className="w-full" min={0} />
        </Form.Item>

        <Form.Item label="Show grades to students" name="show_grades_to_students">
          <Switch
            checked={showGradesToStudents}
            onChange={value => {
              setShowGradesToStudents(value);
            }}
          />
        </Form.Item>

        <Form.Item label={null}>
          <Button type="primary" htmlType="submit">Save</Button>
        </Form.Item>
      </Form>
    </SettingSection>
  );
};

export default GradingSettingsOptions;
