import { Form, Switch } from 'antd';
import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService } from '@classmoji/services';
import { SettingSection } from '~/components';
import { ActionTypes } from '~/constants';
import { useGlobalFetcher } from '~/hooks';
import ProfileSection from './ProfileSection';
import DefaultPageSection from './DefaultPageSection';
import TweaksSection from '~/components/features/tweaks/TweaksSection';
import { assertClassroomAccess } from '~/utils/helpers';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  // Authorize: only OWNER can access general settings
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'SETTINGS',
    attemptedAction: 'view_general_settings',
  });

  // Fetch pages that appear in student menu (potential default page options)
  const menuPages = await ClassmojiService.page.findForStudentMenu(classroom.id);

  // Return classroom for settings display (API keys stripped by assertClassroomAccess)
  return { classroom, menuPages };
};

const SettingsGeneral = ({ loaderData }: Route.ComponentProps) => {
  const { classroom, menuPages } = loaderData;
  const { notify, fetcher } = useGlobalFetcher();

  const handleRecentViewersToggle = (checked: boolean) => {
    notify(ActionTypes.SAVE_EXTENSION_SETTINGS, 'Saving...');
    fetcher!.submit(
      { recent_viewers_enabled: checked },
      { action: '?/saveExtensionSettings', method: 'POST', encType: 'application/json' }
    );
  };

  return (
    <div className="w-2/3 space-y-6">
      <ProfileSection
        organization={{
          name: classroom.name,
          term: classroom.term ?? '',
          year: String(classroom.year ?? ''),
        }}
      />
      <DefaultPageSection
        currentDefault={classroom.settings?.default_student_page || 'dashboard'}
        menuPages={menuPages}
      />
      <TweaksSection />
      <SettingSection
        title="Features"
        description="Enable or disable optional features for this classroom."
      >
        <Form layout="vertical">
          <Form.Item
            label="Recent Viewers"
            extra="Show who has recently viewed each page in the navbar"
          >
            <Switch
              checked={classroom.settings?.recent_viewers_enabled ?? true}
              onChange={handleRecentViewersToggle}
            />
          </Form.Item>
        </Form>
      </SettingSection>
    </div>
  );
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const classSlug = params.class!;

  // Authorize: only OWNER can modify general settings
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'SETTINGS',
    attemptedAction: 'modify_general_settings',
  });

  const data = await request.json();

  return namedAction(request, {
    async saveProfile() {
      await ClassmojiService.classroom.update(classroom.id, data);
      return {
        success: 'Classroom profile updated',
        action: ActionTypes.SAVE_PROFILE,
      };
    },

    async saveExtensionSettings() {
      await ClassmojiService.classroom.updateSettings(classroom.id, data);
      return {
        success: 'Extension settings updated',
        action: ActionTypes.SAVE_EXTENSION_SETTINGS,
      };
    },

    async saveDefaultPage() {
      await ClassmojiService.classroom.updateSettings(classroom.id, {
        default_student_page: data.default_student_page,
      });
      return {
        success: 'Default page updated',
        action: ActionTypes.SAVE_DEFAULT_PAGE,
      };
    },

  });
};

export default SettingsGeneral;
