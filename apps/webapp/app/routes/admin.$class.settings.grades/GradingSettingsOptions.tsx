import { Form, InputNumber, Button, Switch } from 'antd';

import { useGlobalFetcher } from '~/hooks';
import { SettingSection } from '~/components';

interface GradingSettings {
  late_penalty_points_per_hour: number;
  show_grades_to_students: boolean;
}

interface GradingSettingsOptionsProps {
  settings: GradingSettings;
}

const GradingSettingsOptions = ({ settings }: GradingSettingsOptionsProps) => {
  const { fetcher } = useGlobalFetcher();

  const onFinish = (values: GradingSettings) => {
    fetcher!.submit(
      {
        late_penalty_points_per_hour: values.late_penalty_points_per_hour,
        show_grades_to_students: values.show_grades_to_students === true,
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
        className="max-w-md"
        onFinish={onFinish}
        initialValues={{
          late_penalty_points_per_hour: settings.late_penalty_points_per_hour,
          show_grades_to_students: settings.show_grades_to_students === true,
        }}
      >
        <Form.Item label="Late penalty points per hour" name="late_penalty_points_per_hour">
          <InputNumber className="w-full" min={0} />
        </Form.Item>

        <Form.Item
          label="Show students an estimated grade"
          name="show_grades_to_students"
          valuePropName="checked"
          extra="Computed from released grades only."
        >
          <Switch />
        </Form.Item>

        <Form.Item label={null}>
          <Button type="primary" htmlType="submit">
            Save
          </Button>
        </Form.Item>
      </Form>
    </SettingSection>
  );
};

export default GradingSettingsOptions;
