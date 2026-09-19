import { useParams } from 'react-router';
import { Button, Form, Modal, Switch } from 'antd';
import { IconInfoCircle, IconExternalLink } from '@tabler/icons-react';

import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService, ClassroomSettingsEntitlementError } from '@classmoji/services';
import { getContentRepoName } from '@classmoji/utils';
import { SettingSection } from '~/components';
import { ActionTypes } from '~/constants';
import { useGlobalFetcher } from '~/hooks';
import { assertClassroomAccess, assertClassroomMutationAllowed } from '~/utils/helpers';
import { isAIAgentConfigured } from '~/utils/aiFeatures.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  // Authorize: only OWNER can access content settings
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'CONTENT_SETTINGS',
    attemptedAction: 'view',
  });

  // The syllabus bot is Pro-only; the toggle is disabled (not hidden) on Free
  // so owners can see the feature exists and why it is unavailable.
  const syllabusBotEntitlement = await ClassmojiService.entitlement.canUseSyllabusBot(classroom.id);

  // Return classroom with settings for display (API keys stripped by assertClassroomAccess)
  return {
    organization: classroom,
    aiAgentAvailable: isAIAgentConfigured(),
    syllabusBotProRequired: !syllabusBotEntitlement.allowed,
  };
};

const SettingsContent = ({ loaderData }: Route.ComponentProps) => {
  const { organization, aiAgentAvailable, syllabusBotProRequired } = loaderData;
  const { class: classSlug } = useParams();

  const { fetcher } = useGlobalFetcher();

  // content_repo is the stored, user-editable repo name; the org-level helper is
  // only a fallback for legacy classrooms that predate it.
  const gitOrgLogin = organization.git_organization?.login || classSlug || '';
  const repoName = organization.content_repo || getContentRepoName({ login: gitOrgLogin });
  const repoUrl = `https://github.com/${gitOrgLogin}/${repoName}`;

  // Handler for customizable repo name (currently disabled in UI)
  const _handleContentRepoChange = (
    e: React.FocusEvent<HTMLInputElement> | React.KeyboardEvent<HTMLInputElement>
  ) => {
    const value = (e.target as HTMLInputElement).value;

    fetcher!.submit(
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

  const handleSlidesToggle = (checked: boolean) => {
    fetcher!.submit(
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

  const handleSyllabusBotToggle = (checked: boolean) => {
    fetcher!.submit(
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

  // The cache bust. Confirmed rather than immediate because it is a global act
  // — every asset URL in the classroom changes at once — even though it is a
  // safe one, and the confirm is where "safe" gets said out loud.
  const handleResetContentCache = () => {
    Modal.confirm({
      title: 'Reset content cache',
      content:
        'Every image and file gets a new URL and is fetched fresh. Nothing is deleted, and links you have already shared keep working.',
      okText: 'Reset cache',
      onOk: () => {
        fetcher!.submit(
          { _action: 'resetContentCache' },
          {
            method: 'POST',
            encType: 'application/json',
            action: `/admin/${classSlug}/settings/content`,
          }
        );
      },
    });
  };

  // Toggle which course sections appear in the student/assistant sidebar.
  const handleNavToggle =
    (key: 'show_modules' | 'show_pages' | 'show_repos') => (checked: boolean) => {
      fetcher!.submit(
        { _action: 'saveContentSettings', [key]: checked },
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
      {/* Student Navigation visibility */}
      <SettingSection
        title="Student Navigation"
        description="Choose which course sections students and assistants see in the sidebar. Turn these on in any combination."
      >
        <Form layout="vertical" className="w-3/4">
          <Form.Item label="Show Modules">
            <Switch
              checked={settings.show_modules ?? true}
              onChange={handleNavToggle('show_modules')}
            />
          </Form.Item>
          <Form.Item label="Show Pages">
            <Switch
              checked={settings.show_pages ?? true}
              onChange={handleNavToggle('show_pages')}
            />
          </Form.Item>
          <Form.Item label="Show Repositories">
            <Switch
              checked={settings.show_repos ?? true}
              onChange={handleNavToggle('show_repos')}
            />
          </Form.Item>
        </Form>
      </SettingSection>

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

      {/* Content cache bust */}
      <SettingSection
        title="Content Cache"
        description="Gives every image and file in this classroom a fresh URL. Use it if something looks stuck."
      >
        <div className="flex items-center gap-3">
          <Button onClick={handleResetContentCache}>Reset content cache</Button>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            Version {organization.content_key_version ?? 0}
          </span>
        </div>
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
              // The feature predates the Pro gate, so Free classrooms with a
              // stale `true` exist. Turning it OFF stays allowed (the server
              // gates only the `true` direction) — otherwise those owners are
              // stuck with a flag they cannot clear.
              disabled={
                !aiAgentAvailable || (syllabusBotProRequired && !settings.syllabus_bot_enabled)
              }
            />
          </Form.Item>

          {syllabusBotProRequired && (
            <div className="flex items-start gap-2 rounded-lg bg-stone-50 p-3 text-sm text-gray-600 dark:bg-neutral-800 dark:text-gray-400">
              <IconInfoCircle size={16} className="mt-0.5 shrink-0" />
              <span>
                The Syllabus Bot is available on the Pro plan.{' '}
                <a
                  href="/settings/billing"
                  className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                >
                  Upgrade to enable it
                </a>
                .
              </span>
            </div>
          )}

          {/* Hidden when Pro is required: on a grandfathered Free classroom the
              flag can still read `true`, but the runtime gate means students do
              NOT see the Course Assistant button, so this panel would be lying. */}
          {settings.syllabus_bot_enabled && !syllabusBotProRequired && (
            <div className="mt-4 p-4 bg-nav-hover rounded-lg border border-gray-200 dark:border-neutral-700">
              <div className="flex items-center gap-2 mb-3">
                <IconInfoCircle size={16} className="text-ink-3" />
                <span className="font-medium text-ink-0">About the Syllabus Bot</span>
              </div>
              <div className="space-y-2 text-sm text-gray-600 dark:text-gray-300">
                <p>
                  When enabled, students will see a Course Assistant button in the nav bar. They can
                  ask questions about:
                </p>
                <ul className="list-disc list-inside ml-2 space-y-1 text-ink-3">
                  <li>Due dates and deadlines</li>
                  <li>Grading policies and rubrics</li>
                  <li>Course schedule and topics</li>
                  <li>Assignment requirements</li>
                  <li>Office hours and contact information</li>
                </ul>
                <p className="mt-3">
                  <span className="font-medium text-gray-700 dark:text-gray-200">
                    Customization:
                  </span>{' '}
                  Add a{' '}
                  <code className="bg-gray-200 dark:bg-neutral-700 px-1.5 py-0.5 rounded text-ink-1">
                    bot-context/
                  </code>{' '}
                  folder to your content repository with additional context files (e.g., FAQ,
                  policies, announcements).
                </p>
              </div>
            </div>
          )}
        </Form>
      </SettingSection>
    </div>
  );
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const classSlug = params.class!;

  // Authorize: only OWNER can modify content settings
  const { classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'CONTENT_SETTINGS',
    attemptedAction: 'modify',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

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

    // Gated by the same assertClassroomAccess + assertClassroomMutationAllowed
    // pair above as every other action on this route — an OWNER of a classroom
    // that is still open to writes. Nothing extra is needed: the bump is
    // idempotent in effect (the version is only ever compared to itself), it
    // destroys nothing, and it is scoped to the one classroom already
    // authorized.
    async resetContentCache() {
      const { content_key_version } = await ClassmojiService.contentDelivery.bumpContentKeyVersion(
        classroom.id
      );
      return {
        success: 'Content cache reset',
        content_key_version,
        action: ActionTypes.RESET_CONTENT_CACHE,
      };
    },

    async saveContentSettings() {
      const { _action, ...updateData } = data;
      // updateSettings is the hard gate; catching here only turns the refusal
      // into a readable message instead of a 500.
      try {
        await ClassmojiService.classroom.updateSettings(classroom.id, updateData);
      } catch (error: unknown) {
        if (error instanceof ClassroomSettingsEntitlementError) {
          return {
            error: error.message,
            action: ActionTypes.SAVE_CONTENT_SETTINGS,
          };
        }
        throw error;
      }
      return {
        success: 'Content settings updated',
        action: ActionTypes.SAVE_CONTENT_SETTINGS,
      };
    },
  });
};

export default SettingsContent;
