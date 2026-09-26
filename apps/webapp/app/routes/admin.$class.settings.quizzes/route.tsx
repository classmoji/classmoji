import {} from 'react';
import { useParams } from 'react-router';
import { Form, Switch, Input, Select, Button, Modal, Badge, Alert, Divider } from 'antd';

import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService } from '@classmoji/services';
import { SettingSection } from '~/components';
import { ActionTypes } from '~/constants';
import { useGlobalFetcher } from '~/hooks';
import { assertClassroomAccess, assertClassroomMutationAllowed } from '~/utils/helpers';
import { isAIAgentConfigured } from '~/utils/aiFeatures.server';
import type { Route } from './+types/route';

const { Option } = Select;

/** Per-classroom model choices. Null (or unset) = the platform default. */
const MODEL_FIELDS = ['llm_model', 'code_aware_model', 'exploration_model'] as const;

/**
 * Per-classroom reasoning effort, per quiz phase. Null (or unset) = the
 * ai-agent's platform default: medium for questions, high for grading, low for
 * exploration.
 */
const EFFORT_FIELDS = ['question_effort', 'grading_effort', 'exploration_effort'] as const;

const EFFORT_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high (xhigh)' },
  { value: 'max', label: 'Max' },
] as const;

/**
 * Exploration stops at High. Its excerpt call reads up to ~20k tokens of code,
 * and at xhigh or max the thinking can use up the call's max_tokens before it
 * answers, which falls back to whole files. (packages/tasks exploreRepo.ts runs
 * those two as high anyway.)
 */
const EXPLORATION_EFFORT_OPTIONS = EFFORT_OPTIONS.filter(
  option => option.value !== 'xhigh' && option.value !== 'max'
);

/** The only values the action stores for each effort field (besides null). */
const EFFORT_LEVELS: Record<(typeof EFFORT_FIELDS)[number], readonly string[]> = {
  question_effort: EFFORT_OPTIONS.map(option => option.value),
  grading_effort: EFFORT_OPTIONS.map(option => option.value),
  exploration_effort: EXPLORATION_EFFORT_OPTIONS.map(option => option.value),
};

const EFFORT_LABELS: Record<(typeof EFFORT_FIELDS)[number], string> = {
  question_effort: 'Question effort',
  grading_effort: 'Grading effort',
  exploration_effort: 'Exploration effort',
};

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  // Authorize: only OWNER can access quiz settings
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'QUIZ_SETTINGS',
    attemptedAction: 'view',
  });

  // Get classroom settings with API key server-side only
  const settings = await ClassmojiService.classroom.getClassroomSettingsForServer(classroom.id);
  const apiKey = settings?.anthropic_api_key;

  // Dynamically fetch available models
  const { getAllModels } = await import('@classmoji/services');

  let models: { anthropic: { value: string; label: string }[] } = {
    anthropic: [],
  };

  try {
    // Try to fetch models - use API key from server-side fetch
    models = await getAllModels({ anthropicApiKey: apiKey! });

    console.log('[Quiz Settings] Loaded models:', {
      anthropic: models.anthropic.length,
    });
  } catch (error: unknown) {
    console.error('[Quiz Settings] Error loading models:', error);
    // Fallback models are already handled in getAllModels
  }

  // Return classroom with settings (excluding sensitive API keys)
  const safeSettings = settings
    ? {
        ...settings,
        anthropic_api_key: undefined,
        openai_api_key: undefined,
        has_anthropic_key: Boolean(settings.anthropic_api_key),
      }
    : null;

  return {
    organization: { ...classroom, settings: safeSettings },
    availableModels: models,
    aiAgentAvailable: isAIAgentConfigured(),
  };
};

const SettingsQuizzes = ({ loaderData }: Route.ComponentProps) => {
  const { organization, availableModels, aiAgentAvailable } = loaderData;
  const { class: classSlug } = useParams();
  const [form] = Form.useForm();

  const { fetcher } = useGlobalFetcher();

  const settings = (organization.settings || {}) as Record<string, unknown>;
  // Use the computed flag from getOrgForUI (API key is never sent to client)
  const hasAnthropicKey = settings.has_anthropic_key;
  const usingSystemDefaults = !hasAnthropicKey;

  // Get model lists from loader data
  const anthropicModels = availableModels?.anthropic || [];

  const handleQuizzesToggle = (checked: boolean) => {
    fetcher!.submit(
      {
        _action: 'saveQuizSettings',
        quizzes_enabled: checked,
      },
      {
        method: 'POST',
        encType: 'application/json',
        action: `/admin/${classSlug}/settings/quizzes`,
      }
    );
  };

  const handleSaveLLMSettings = (values: Record<string, unknown>) => {
    const payload: Record<string, string | null> = {
      _action: 'saveLLMSettings',
      anthropic_api_key: (values.anthropic_api_key as string) || '',
    };
    // A cleared Select is undefined, which JSON.stringify drops, so the server
    // would never see the clear. Send null to put the column back to default.
    for (const field of [...MODEL_FIELDS, ...EFFORT_FIELDS]) {
      payload[field] = (values[field] as string) || null;
    }
    fetcher!.submit(payload, {
      method: 'POST',
      encType: 'application/json',
      action: `/admin/${classSlug}/settings/quizzes`,
    });
  };

  const handleClearSettings = () => {
    Modal.confirm({
      title: 'Clear LLM Settings',
      content:
        'This will remove all custom LLM configuration and revert to system defaults. Are you sure?',
      okText: 'Clear',
      okType: 'danger',
      onOk: () => {
        fetcher!.submit(
          {
            _action: 'clearLLMSettings',
          },
          {
            method: 'POST',
            encType: 'application/json',
            action: `/admin/${classSlug}/settings/quizzes`,
          }
        );
      },
    });
  };

  return (
    <div className="">
      {!aiAgentAvailable && (
        <Alert
          message="AI Agent Not Configured"
          description="The AI agent service is not available. Quiz features require AI_AGENT_URL and AI_AGENT_SHARED_SECRET to be configured."
          type="warning"
          showIcon={true}
          style={{ marginBottom: '16px' }}
        />
      )}

      {/* Quiz Functionality Section */}
      <SettingSection
        title="Quiz Functionality"
        description="Enable or disable quizzes for all users in this classroom. When disabled, students, assistants, and admins will not be able to access the quiz feature."
      >
        <Form layout="vertical" className="w-3/4">
          <Form.Item label="Enable Quizzes">
            <Switch
              checked={organization.settings?.quizzes_enabled ?? true}
              onChange={handleQuizzesToggle}
              disabled={!aiAgentAvailable}
            />
          </Form.Item>
        </Form>
      </SettingSection>

      <Divider />

      <Form
        form={form}
        layout="vertical"
        className="w-3/4"
        onFinish={handleSaveLLMSettings}
        initialValues={{
          anthropic_api_key: '',
          // undefined, not '', so an unset Select shows its placeholder.
          llm_model: (settings.llm_model as string) || undefined,
          code_aware_model: (settings.code_aware_model as string) || undefined,
          exploration_model: (settings.exploration_model as string) || undefined,
          question_effort: (settings.question_effort as string) || undefined,
          grading_effort: (settings.grading_effort as string) || undefined,
          exploration_effort: (settings.exploration_effort as string) || undefined,
        }}
      >
        {/* API Keys Section */}
        <SettingSection
          title="API Key"
          description="Configure your Anthropic API key for AI-powered quizzes. Leave empty to use system-wide environment variables."
          extra={
            usingSystemDefaults ? (
              <Badge
                count={
                  <span className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm">
                    Using System Environment Variables
                  </span>
                }
              />
            ) : (
              <Badge
                count={
                  <span className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm">
                    Using Organization API Key
                  </span>
                }
              />
            )
          }
        >
          {usingSystemDefaults && (
            <Alert
              message="Provide an Anthropic API key below to configure custom model and effort settings."
              type="info"
              showIcon={true}
              style={{ marginBottom: '16px' }}
            />
          )}

          <Form.Item
            label="Anthropic API Key"
            name="anthropic_api_key"
            extra="Leave empty to use system default"
          >
            <Input.Password
              placeholder="sk-ant-..."
              visibilityToggle
              value={hasAnthropicKey ? '••••••••••••••••' : ''}
            />
          </Form.Item>

          <Button type="primary" htmlType="submit">
            Save
          </Button>
        </SettingSection>

        <Divider />

        {/* Standard Quiz Settings Section */}
        <SettingSection
          title="Standard Quiz Settings"
          description="Configure the AI model for standard quizzes."
        >
          <Form.Item label="Model" name="llm_model">
            <Select disabled={usingSystemDefaults} placeholder="Select a model">
              {anthropicModels.map((model: { value: string; label: string }) => (
                <Option key={model.value} value={model.value}>
                  {model.label}
                </Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            label="Question effort"
            name="question_effort"
            extra="Question and conversation turns in standard and code-aware quizzes. Higher effort is slower but more thorough; models that don't support effort ignore it."
          >
            <Select allowClear disabled={!hasAnthropicKey} placeholder="Default: Medium">
              {EFFORT_OPTIONS.map(option => (
                <Option key={option.value} value={option.value}>
                  {option.label}
                </Option>
              ))}
            </Select>
          </Form.Item>

          <Button type="primary" htmlType="submit">
            Save
          </Button>
        </SettingSection>

        <Divider />

        {/* Grading applies to both quiz types */}
        <SettingSection
          title="Quiz Grading"
          description="Configure the final grading of standard and code-aware quizzes."
        >
          <Form.Item
            label="Grading effort"
            name="grading_effort"
            extra="How much the AI reasons when it grades a finished quiz; models that don't support effort ignore it."
          >
            <Select allowClear disabled={!hasAnthropicKey} placeholder="Default: High">
              {EFFORT_OPTIONS.map(option => (
                <Option key={option.value} value={option.value}>
                  {option.label}
                </Option>
              ))}
            </Select>
          </Form.Item>

          <Button type="primary" htmlType="submit">
            Save
          </Button>
        </SettingSection>

        <Divider />

        {/* Code-Aware Quiz Settings Section */}
        <SettingSection
          title="Code-Aware Quiz Settings"
          description="Configure the AI models for code-aware quizzes that can explore student repositories."
        >
          <Form.Item
            label="Agent Model"
            name="code_aware_model"
            extra={
              hasAnthropicKey
                ? 'Uses Anthropic API Key configured above'
                : 'Provide Anthropic API Key above to enable'
            }
          >
            <Select
              disabled={!hasAnthropicKey}
              placeholder={hasAnthropicKey ? 'Select a Claude model' : 'Anthropic API Key required'}
            >
              {anthropicModels.map((model: { value: string; label: string }) => (
                <Option key={model.value} value={model.value}>
                  {model.label}
                </Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            label="Exploration Model"
            name="exploration_model"
            extra={
              hasAnthropicKey
                ? "Picks the files and lines of the student's code the quiz agent sees. Runs on the Classmoji platform key, not the key above."
                : 'Provide Anthropic API Key above to enable'
            }
          >
            <Select
              allowClear
              disabled={!hasAnthropicKey}
              placeholder={
                hasAnthropicKey ? 'Default: Claude Sonnet 5' : 'Anthropic API Key required'
              }
            >
              {anthropicModels.map((model: { value: string; label: string }) => (
                <Option key={model.value} value={model.value}>
                  {model.label}
                </Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            label="Exploration effort"
            name="exploration_effort"
            extra="How much the exploration model reasons when it picks the lines of code to show; models that don't support effort ignore it. Runs on the Classmoji platform key, not the key above."
          >
            <Select allowClear disabled={!hasAnthropicKey} placeholder="Default: Low">
              {EXPLORATION_EFFORT_OPTIONS.map(option => (
                <Option key={option.value} value={option.value}>
                  {option.label}
                </Option>
              ))}
            </Select>
          </Form.Item>

          <Button type="primary" htmlType="submit">
            Save
          </Button>
        </SettingSection>
      </Form>

      {/* Clear All Settings Section */}
      {!usingSystemDefaults && (
        <>
          <Divider />
          <SettingSection
            title="Reset Configuration"
            description="Remove all custom LLM configuration and revert to system defaults."
          >
            <Button type="primary" onClick={handleClearSettings}>
              Clear All Settings
            </Button>
          </SettingSection>
        </>
      )}
    </div>
  );
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const classSlug = params.class!;

  // Authorize: only OWNER can modify quiz settings
  const { classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'QUIZ_SETTINGS',
    attemptedAction: 'modify',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();

  // Get current settings server-side (needed to check API key existence)
  const currentSettings = await ClassmojiService.classroom.getClassroomSettingsForServer(
    classroom.id
  );

  // Create FormData with the action from the JSON
  const formData = new FormData();
  if (data._action) {
    formData.append('_action', data._action);
  }

  return namedAction(formData, {
    async saveQuizSettings() {
      // Only the field the toggle owns; model fields go through saveLLMSettings.
      await ClassmojiService.classroom.updateSettings(classroom.id, {
        quizzes_enabled: Boolean(data.quizzes_enabled),
      });
      return {
        success: 'Quiz settings updated',
        action: ActionTypes.SAVE_QUIZ_SETTINGS,
      };
    },

    async saveLLMSettings() {
      const { anthropic_api_key } = data;

      // Only the fields this form owns. A stale client may still send
      // llm_temperature / llm_max_tokens; nothing sends those to a model, so
      // they are not written.
      const updateData: {
        anthropic_api_key?: string;
        llm_model?: string | null;
        code_aware_model?: string | null;
        exploration_model?: string | null;
        question_effort?: string | null;
        grading_effort?: string | null;
        exploration_effort?: string | null;
      } = {};
      for (const field of MODEL_FIELDS) {
        if (!(field in data)) continue;
        const value = data[field];
        // '' and null both mean "platform default", stored as null.
        updateData[field] = typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
      }
      for (const field of EFFORT_FIELDS) {
        if (!(field in data)) continue;
        const value = data[field];
        if (value === null || value === '') {
          updateData[field] = null;
          continue;
        }
        // The ai-agent passes the stored value to the model, so only a level
        // this field offers is written (exploration stops at high). Anything
        // else fails the save rather than being dropped quietly.
        const levels = EFFORT_LEVELS[field];
        if (typeof value !== 'string' || !levels.includes(value)) {
          return {
            error: `${EFFORT_LABELS[field]} must be one of ${levels.join(', ')}, or empty for the default.`,
            action: ActionTypes.SAVE_QUIZ_SETTINGS,
          };
        }
        updateData[field] = value;
      }

      // Only update API key if provided (non-empty)
      if (typeof anthropic_api_key === 'string' && anthropic_api_key.trim() !== '') {
        updateData.anthropic_api_key = anthropic_api_key;
      }

      // Validation: choosing ANY model or effort requires a key. The disabled
      // Selects are not the gate; this is.
      const willHaveKey = Boolean(
        updateData.anthropic_api_key || currentSettings?.anthropic_api_key
      );

      if ([...MODEL_FIELDS, ...EFFORT_FIELDS].some(field => updateData[field]) && !willHaveKey) {
        return {
          error:
            'Custom model or effort selection requires an API key. Leave fields empty to use system defaults.',
          action: ActionTypes.SAVE_QUIZ_SETTINGS,
        };
      }

      await ClassmojiService.classroom.updateSettings(classroom.id, updateData);
      return {
        success: 'LLM settings saved successfully',
        action: ActionTypes.SAVE_QUIZ_SETTINGS,
      };
    },

    async clearLLMSettings() {
      // Clear all LLM-related settings
      await ClassmojiService.classroom.updateSettings(classroom.id, {
        llm_provider: null,
        llm_model: null,
        llm_temperature: null,
        llm_max_tokens: null,
        anthropic_api_key: null,
        code_aware_model: null,
        exploration_model: null,
        question_effort: null,
        grading_effort: null,
        exploration_effort: null,
      });
      return {
        success: 'LLM settings cleared. Using system defaults.',
        action: ActionTypes.SAVE_QUIZ_SETTINGS,
      };
    },
  });
};

export default SettingsQuizzes;
