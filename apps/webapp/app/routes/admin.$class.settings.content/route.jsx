import { useParams } from 'react-router';
import { Form, Switch } from 'antd';
import { IconInfoCircle, IconExternalLink } from '@tabler/icons-react';

import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService } from '@classmoji/services';
import { SettingSection } from '~/components';
import { ActionTypes } from '~/constants';
import { useGlobalFetcher } from '~/hooks';
import { assertClassroomAccess } from '~/utils/helpers';
import { isAIAgentConfigured } from '~/utils/aiFeatures.server';

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;

  // Authorize: only OWNER can access content settings
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'CONTENT_SETTINGS',
    attemptedAction: 'view',
  });

  // Return classroom with settings for display (API keys stripped by assertClassroomAccess)
  return { organization: classroom, aiAgentAvailable: isAIAgentConfigured() };
};

/**
 * Generate a suggested content repository name based on classSlug and term
 */
function generateSuggestedRepoName(classSlug, term, year) {
  if (!term || !year) return `content-${classSlug}`;

  const termMap = { WINTER: 'w', SPRING: 's', SUMMER: 'u', FALL: 'f' };
  const termCode = termMap[term] || term.charAt(0).toLowerCase();
  const yearShort = String(year).slice(-2);

  return `content-${classSlug}-${yearShort}${termCode}`;
}

const SettingsContent = ({ loaderData }) => {
  const { organization, aiAgentAvailable } = loaderData;
  const { class: classSlug } = useParams();

  const { notify, fetcher } = useGlobalFetcher();

  // Generate repo name and URL for display
  const gitOrgLogin = organization.git_organization?.login || classSlug;
  const repoName = generateSuggestedRepoName(gitOrgLogin, organization.term, organization.year);
  const repoUrl = `https://github.com/${gitOrgLogin}/${repoName}`;

  // Handler for customizable repo name (currently disabled in UI)
  const handleContentRepoChange = e => {
    const value = e.target.value;
    notify(ActionTypes.SAVE_CONTENT_SETTINGS, 'Saving content repository...');

    fetcher.submit(
      {
        _action: 'saveContentRepo',
        content_repo_name: value,
      },
      {
        method: 'POST',
        encType: 'application/json',
        action: `/admin/${classSlug}/settings/content`,
      }
    );
  };

  const handleSlidesToggle = checked => {
    notify(ActionTypes.SAVE_CONTENT_SETTINGS, 'Saving slides settings...');

    fetcher.submit(
      {
        _action: 'saveContentSettings',
        slides_enabled: checked,
      },
      {
        method: 'POST',
        encType: 'application/json',
        action: `/admin/${classSlug}/settings/content`,
      }
    );
  };

  const handleSyllabusBotToggle = checked => {
    notify(ActionTypes.SAVE_CONTENT_SETTINGS, 'Saving syllabus bot settings...');

    fetcher.submit(
      {
        _action: 'saveContentSettings',
        syllabus_bot_enabled: checked,
      },
      {
        method: 'POST',
        encType: 'application/json',
        action: `/admin/${classSlug}/settings/content`,
      }
    );
  };

  const settings = organization.settings || {};

  return (
    <div className="space-y-8">
      {/* Content Repository Link */}
      <SettingSection
        title="Content Repository"
        description="Your course content (slides, pages, syllabus) is stored in a GitHub repository."
      >
        <a
          href={repoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
        >
          <span className="font-mono text-sm">{repoName}</span>
          <IconExternalLink size={16} />
        </a>
      </SettingSection>

      {/* Content Repository Name Setting - TEMPORARILY DISABLED
       * There are ~15 places in the codebase that hardcode the repo name pattern
       * instead of using getContentRepoName(). Until those are all updated,
       * allowing custom repo names would cause inconsistent behavior.
       * TODO: Update all hardcoded patterns to use the shared utility, then re-enable.
       */}
      {/* <SettingSection
        title="Content Repository"
        description="Configure the GitHub repository where your course content is stored. This repository is used by Slides and the Syllabus Bot to access course materials."
      >
        <Form layout="vertical" className="w-3/4">
          <Form.Item label="Repository Name">
            <Input
              defaultValue={settings.content_repo_name || suggestedRepoName}
              onBlur={handleContentRepoChange}
              onPressEnter={handleContentRepoChange}
            />
          </Form.Item>
        </Form>
      </SettingSection> */}

      {/* Slides Section */}
      <SettingSection
        title="Slides"
        description="Enable slide presentations for this classroom. When enabled, instructors can create and present slides to students."
      >
        <Form layout="vertical" className="w-3/4">
          <Form.Item label="Enable Slides">
            <Switch checked={settings.slides_enabled ?? false} onChange={handleSlidesToggle} />
          </Form.Item>
        </Form>
      </SettingSection>

      {/* Syllabus Bot Section */}
      <SettingSection
        title="Syllabus Bot"
        description="Enable an AI-powered assistant that helps students find information about your course from the syllabus and course materials."
      >
        <Form layout="vertical" className="w-3/4">
          <Form.Item label="Enable Syllabus Bot">
            <Switch
              checked={settings.syllabus_bot_enabled ?? false}
              onChange={handleSyllabusBotToggle}
              disabled={!aiAgentAvailable}
            />
          </Form.Item>

          {settings.syllabus_bot_enabled && (
            <div className="mt-4 p-4 bg-gray-100 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
              <div className="flex items-center gap-2 mb-3">
                <IconInfoCircle size={16} className="text-gray-500 dark:text-gray-400" />
                <span className="font-medium text-gray-900 dark:text-gray-100">About the Syllabus Bot</span>
              </div>
              <div className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
                <p>
                  When enabled, students will see a floating chat button on student pages. They
                  can ask questions about:
                </p>
                <ul className="list-disc list-inside ml-2 space-y-1 text-gray-500 dark:text-gray-400">
                  <li>Due dates and deadlines</li>
                  <li>Grading policies and rubrics</li>
                  <li>Course schedule and topics</li>
                  <li>Assignment requirements</li>
                  <li>Office hours and contact information</li>
                </ul>
                <p className="mt-3">
                  <span className="font-medium text-gray-700 dark:text-gray-200">Customization:</span> Add a{' '}
                  <code className="bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded text-gray-700 dark:text-gray-300">bot-context/</code> folder to your
                  content repository with additional context files (e.g., FAQ, policies,
                  announcements).
                </p>
              </div>
            </div>
          )}
        </Form>
      </SettingSection>
    </div>
  );
};

export const action = async ({ params, request }) => {
  const { class: classSlug } = params;

  // Authorize: only OWNER can modify content settings
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'CONTENT_SETTINGS',
    attemptedAction: 'modify',
  });

  const data = await request.json();

  const formData = new FormData();
  if (data._action) {
    formData.append('_action', data._action);
  }

  return namedAction(formData, {
    async saveContentRepo() {
      const { content_repo_name } = data;
      await ClassmojiService.classroom.updateSettings(classroom.id, {
        content_repo_name: content_repo_name || null,
      });
      return {
        success: 'Content repository updated',
        action: ActionTypes.SAVE_CONTENT_SETTINGS,
      };
    },

    async saveContentSettings() {
      const { _action, ...updateData } = data;
      await ClassmojiService.classroom.updateSettings(classroom.id, updateData);
      return {
        success: 'Content settings updated',
        action: ActionTypes.SAVE_CONTENT_SETTINGS,
      };
    },
  });
};

export default SettingsContent;
