import { Button, Form, Select } from 'antd';
import { useState } from 'react';

import { useGlobalFetcher } from '~/hooks';
import { SettingSection } from '~/components';
import { ActionTypes } from '~/constants';

const DefaultPageSection = ({ currentDefault, menuPages }) => {
  const [defaultPage, setDefaultPage] = useState(currentDefault);

  const { notify, fetcher } = useGlobalFetcher();

  const saveDefaultPage = () => {
    notify(ActionTypes.SAVE_DEFAULT_PAGE, 'Saving default page...');

    fetcher.submit(
      {
        default_student_page: defaultPage,
      },
      {
        action: '?/saveDefaultPage',
        method: 'POST',
        encType: 'application/json',
      }
    );
  };

  // Build options: Dashboard, Modules, then any menu pages
  const pageOptions = [
    { value: 'dashboard', label: 'Dashboard' },
    { value: 'modules', label: 'Modules' },
    ...menuPages.map(page => ({
      value: `page:${page.id}`,
      label: page.title,
    })),
  ];

  return (
    <SettingSection
      title="Default Student Page"
      description="Choose which page students see when they first enter your course."
    >
      <Form layout="vertical">
        <Form.Item label="Landing page">
          <Select
            value={defaultPage}
            onChange={setDefaultPage}
            options={pageOptions}
            style={{ width: '100%' }}
          />
        </Form.Item>

        <p className="text-sm text-gray-500 mb-4">
          Students will be automatically redirected to this page when they navigate to your course.
          {menuPages.length === 0 && (
            <span className="block mt-2 text-amber-600">
              To add custom pages as options, first create a page and enable &quot;Show in student menu&quot;.
            </span>
          )}
        </p>

        <Button type="primary" onClick={saveDefaultPage}>
          Save
        </Button>
      </Form>
    </SettingSection>
  );
};

export default DefaultPageSection;
