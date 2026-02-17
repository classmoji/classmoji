import { Button, Form, Input } from 'antd';
import { useState } from 'react';

import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService } from '@classmoji/services';
import { SettingSection } from '~/components';
import { ActionTypes } from '~/constants';
import { useGlobalFetcher } from '~/hooks';
import { assertClassroomAccess } from '~/utils/helpers';

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;

  // Authorize: only OWNER can access extension settings
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'SETTINGS',
    attemptedAction: 'view_extension_settings',
  });

  // Return classroom with settings for display (API keys stripped by assertClassroomAccess)
  return { classroom };
};

const SettingsExtensions = ({ loaderData }) => {
  const { classroom } = loaderData;

  const [tokensPerHour, setTokensPerHour] = useState(classroom.settings.default_tokens_per_hour);

  const { notify, fetcher } = useGlobalFetcher();

  const saveExtensionSettings = () => {
    notify(ActionTypes.SAVE_EXTENSION_SETTINGS, 'Saving extension configuration...');

    fetcher.submit(
      {
        default_tokens_per_hour: parseInt(tokensPerHour),
      },
      {
        action: '?/saveExtensionSettings',
        method: 'POST',
        encType: 'application/json',
      }
    );
  };

  return (
    <div className="w-2/3">
      <SettingSection
        title="Tokens per hour"
        description="Configure the default number of tokens per hour for deadline extensions"
      >
        <Form layout="vertical">
          <Form.Item label="Tokens per hour">
            <Input
              type="number"
              value={tokensPerHour}
              onChange={e => setTokensPerHour(e.target.value)}
            />
          </Form.Item>
        </Form>
      </SettingSection>

      <div className="flex justify-end">
        <Button type="primary" onClick={saveExtensionSettings}>Save</Button>
      </div>
    </div>
  );
};

export const action = async ({ params, request }) => {
  const { class: classSlug } = params;

  // Authorize: only OWNER can modify extension settings
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'SETTINGS',
    attemptedAction: 'modify_extension_settings',
  });

  const data = await request.json();

  return namedAction(request, {
    async saveExtensionSettings() {
      await ClassmojiService.classroom.updateSettings(classroom.id, data);
      return {
        success: 'Extension settings updated',
        action: ActionTypes.SAVE_EXTENSION_SETTINGS,
      };
    },
  });
};

export default SettingsExtensions;
