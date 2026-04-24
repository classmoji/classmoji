import { SettingSection } from '~/components';
import { Form, Radio } from 'antd';
import { useGlobalFetcher } from '~/hooks';

interface StatusSectionProps {
  organization: { is_active: boolean };
}

const StatusSection = ({ organization }: StatusSectionProps) => {
  const { fetcher } = useGlobalFetcher();

  const handleStatusChange = async (isActive: boolean) => {
    fetcher!.submit(
      {
        is_active: isActive,
      },
      {
        action: '?/saveProfile',
        method: 'POST',
        encType: 'application/json',
      }
    );
  };

  return (
    <SettingSection
      title="Status"
      description="Change the status of your organization. Note that statistics are not computed for inactive classes"
    >
      <Form layout="vertical">
        <Form.Item label="Current status">
          <Radio.Group
            block
            options={[
              { label: 'Active', value: true },
              { label: 'Inactive', value: false },
            ]}
            optionType="button"
            value={organization.is_active}
            onChange={e => handleStatusChange(e.target.value)}
            className="w-1/2"
          />
        </Form.Item>
      </Form>
    </SettingSection>
  );
};

export default StatusSection;
