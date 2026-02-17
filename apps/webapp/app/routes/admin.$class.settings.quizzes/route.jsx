import { useState } from 'react';
import { useParams } from 'react-router';
import {
  Form,
  Switch,
  Input,
  Select,
  Slider,
  InputNumber,
  Button,
  Modal,
  Badge,
  Alert,
  Divider,
} from 'antd';

import { namedAction } from 'remix-utils/named-action';

import { ClassmojiService } from '@classmoji/services';
import { SettingSection } from '~/components';
import { ActionTypes } from '~/constants';
import { useGlobalFetcher } from '~/hooks';
import { assertClassroomAccess } from '~/utils/helpers';
import { isAIAgentConfigured } from '~/utils/aiFeatures.server';

const { Option } = Select;

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;

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

  let models = {
    anthropic: [],
  };

  try {
    // Try to fetch models - use API key from server-side fetch
    models = await getAllModels({
      anthropicApiKey: apiKey,
    });

    console.log('[Quiz Settings] Loaded models:', {
      anthropic: models.anthropic.length,
    });
  } catch (error) {
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

const SettingsQuizzes = ({ loaderData }) => {
  const { organization, availableModels, aiAgentAvailable } = loaderData;
  const { class: classSlug } = useParams();
  const [form] = Form.useForm();

  const { notify, fetcher } = useGlobalFetcher();

  const settings = organization.settings || {};
  // Use the computed flag from getOrgForUI (API key is never sent to client)
  const hasAnthropicKey = settings.has_anthropic_key;
  const usingSystemDefaults = !hasAnthropicKey;

  // Get model lists from loader data
  const anthropicModels = availableModels?.anthropic || [];

  const handleQuizzesToggle = checked => {
    notify(ActionTypes.SAVE_QUIZ_SETTINGS, 'Saving quiz settings...');

    fetcher.submit(
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

  const handleSaveLLMSettings = values => {
    notify(ActionTypes.SAVE_QUIZ_SETTINGS, 'Saving LLM settings...');

    fetcher.submit(
      {
        _action: 'saveLLMSettings',
        ...values,
      },
      {
        method: 'POST',
        encType: 'application/json',
        action: `/admin/${classSlug}/settings/quizzes`,
      }
    );
  };

  const handleClearSettings = () => {
    Modal.confirm({
      title: 'Clear LLM Settings',
      content:
        'This will remove all custom LLM configuration and revert to system defaults. Are you sure?',
      okText: 'Clear',
      okType: 'danger',
      onOk: () => {
        notify(ActionTypes.SAVE_QUIZ_SETTINGS, 'Clearing LLM settings...');

        fetcher.submit(
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
          llm_model: settings.llm_model || '',
          llm_temperature: settings.llm_temperature ?? 0.7,
          llm_max_tokens: settings.llm_max_tokens ?? 1000,
          code_aware_model: settings.code_aware_model || '',
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
              message="Provide an Anthropic API key below to configure custom model settings."
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

          <Button type="primary" htmlType="submit">Save</Button>
        </SettingSection>

        <Divider />

        {/* Standard Quiz Settings Section */}
        <SettingSection
          title="Standard Quiz Settings"
          description="Configure the AI model and parameters for standard quizzes."
        >
          <Form.Item label="Model" name="llm_model">
            <Select disabled={usingSystemDefaults} placeholder="Select a model">
              {anthropicModels.map(model => (
                <Option key={model.value} value={model.value}>
                  {model.label}
                </Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            label={`Temperature: ${form.getFieldValue('llm_temperature') ?? 0.7}`}
            name="llm_temperature"
          >
            <Slider
              min={0}
              max={2}
              step={0.1}
              disabled={usingSystemDefaults}
              marks={{
                0: '0',
                0.7: '0.7',
                1: '1',
                2: '2',
              }}
            />
          </Form.Item>

          <Form.Item label="Max Tokens" name="llm_max_tokens">
            <InputNumber
              min={100}
              max={8000}
              disabled={usingSystemDefaults}
              style={{ width: '100%' }}
            />
          </Form.Item>

          <Button type="primary" htmlType="submit">Save</Button>
        </SettingSection>

        <Divider />

        {/* Code-Aware Quiz Settings Section */}
        <SettingSection
          title="Code-Aware Quiz Settings"
          description="Configure the AI agent model for code-aware quizzes that can explore student repositories."
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
              {anthropicModels.map(model => (
                <Option key={model.value} value={model.value}>
                  {model.label}
                </Option>
              ))}
            </Select>
          </Form.Item>

          <Button type="primary" htmlType="submit">Save</Button>
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
            <Button type="primary" onClick={handleClearSettings}>Clear All Settings</Button>
          </SettingSection>
        </>
      )}
    </div>
  );
};

export const action = async ({ params, request }) => {
  const { class: classSlug } = params;

  // Authorize: only OWNER can modify quiz settings
  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER'],
    resourceType: 'QUIZ_SETTINGS',
    attemptedAction: 'modify',
  });

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
      const { _action, ...updateData } = data;
      await ClassmojiService.classroom.updateSettings(classroom.id, updateData);
      return {
        success: 'Quiz settings updated',
        action: ActionTypes.SAVE_QUIZ_SETTINGS,
      };
    },

    async saveLLMSettings() {
      const { _action, anthropic_api_key, ...otherSettings } = data;

      // Prepare update data
      const updateData = { ...otherSettings };

      // Only update API key if provided (non-empty)
      if (anthropic_api_key && anthropic_api_key.trim() !== '') {
        updateData.anthropic_api_key = anthropic_api_key;
      }

      // Validation: if trying to set model settings, ensure key exists
      const willHaveKey =
        (anthropic_api_key && anthropic_api_key.trim()) || currentSettings?.anthropic_api_key;

      if (updateData.llm_model && !willHaveKey) {
        return {
          error:
            'Custom model selection requires an API key. Leave fields empty to use system defaults.',
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
      });
      return {
        success: 'LLM settings cleared. Using system defaults.',
        action: ActionTypes.SAVE_QUIZ_SETTINGS,
      };
    },
  });
};

export default SettingsQuizzes;
