import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Form, Switch, Input, Select, Button, Modal, Badge, Alert, Divider } from 'antd';
import { IconInfoCircle } from '@tabler/icons-react';

import { namedAction } from 'remix-utils/named-action';

import {
  ClassmojiService,
  ClassroomSettingsEntitlementError,
  ClassroomSettingsValidationError,
} from '@classmoji/services';
import { ALLOWED_MODELS, isAllowedModel } from '@classmoji/utils/ai-models';
import { ASK_MOJI_AVAILABILITY_COPY } from '@classmoji/utils/ask-moji/copy';
import { INSTRUCTIONS_MAX_CHARS } from '@classmoji/utils/ask-moji/limits';
import { SettingSection } from '~/components';
import { ActionTypes } from '~/constants';
import { useGlobalFetcher } from '~/hooks';
import {
  addClassroomAuditLog,
  assertClassroomAccess,
  assertClassroomMutationAllowed,
} from '~/utils/helpers';
import { isAIAgentConfigured } from '~/utils/aiFeatures.server';
import { impersonationAuditFields } from '../admin.$class.ask-moji/impersonation.server';
import {
  AI_SETTINGS_AUDIT_TOOL,
  INSTRUCTIONS_ERROR_COPY,
  isInstructionsErrorCode,
} from './aiSettingsCopy';
import { buildLLMSettingsPayload } from './llmSettingsPayload';
import { getPlatformAIDefaults } from './platformDefaults.server';
import type { Route } from './+types/route';

const { Option } = Select;

/**
 * Per-classroom model choices: standard quizzes, code-aware quizzes, code
 * exploration, Ask Moji. Null (or unset) = the platform default.
 *
 * Every one is allow-listed. The chat agents (both quiz runtimes and the
 * Ask Moji agent) run only allow-listed models (isAllowedModel,
 * @classmoji/utils/ai-models) and fall back to the platform default for
 * anything else, so these selects offer only those models and the action
 * stores nothing else.
 */
const MODEL_FIELDS = [
  'llm_model',
  'code_aware_model',
  'exploration_model',
  'syllabus_bot_model',
] as const;

type ModelField = (typeof MODEL_FIELDS)[number];

const MODEL_LABELS: Record<ModelField, string> = {
  llm_model: 'Standard quiz model',
  code_aware_model: 'Code-aware quiz model',
  exploration_model: 'Code exploration model',
  syllabus_bot_model: 'Ask Moji model',
};

/**
 * Per-classroom reasoning effort, per quiz phase and for Ask Moji. Null (or
 * unset) = the ai-agent's platform default (see platformDefaults.server.ts).
 */
const EFFORT_FIELDS = [
  'question_effort',
  'grading_effort',
  'exploration_effort',
  'syllabus_bot_effort',
] as const;

type SelectField = ModelField | (typeof EFFORT_FIELDS)[number];

const isModelField = (field: string): field is ModelField =>
  (MODEL_FIELDS as readonly string[]).includes(field);

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
 * answers, which falls back to whole files. (The explore-repo task runs those
 * two as high anyway.)
 */
const EXPLORATION_EFFORT_OPTIONS = EFFORT_OPTIONS.filter(
  option => option.value !== 'xhigh' && option.value !== 'max'
);

/** The only values the action stores for each effort field (besides null). */
const EFFORT_LEVELS: Record<(typeof EFFORT_FIELDS)[number], readonly string[]> = {
  question_effort: EFFORT_OPTIONS.map(option => option.value),
  grading_effort: EFFORT_OPTIONS.map(option => option.value),
  exploration_effort: EXPLORATION_EFFORT_OPTIONS.map(option => option.value),
  syllabus_bot_effort: EFFORT_OPTIONS.map(option => option.value),
};

const EFFORT_LABELS: Record<(typeof EFFORT_FIELDS)[number], string> = {
  question_effort: 'Question effort',
  grading_effort: 'Grading effort',
  exploration_effort: 'Exploration effort',
  syllabus_bot_effort: 'Ask Moji effort',
};

const effortLabel = (level: string) =>
  EFFORT_OPTIONS.find(option => option.value === level)?.label ?? level;

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  // Authorize: only OWNER can access AI settings
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

  // AI Quizzes and Ask Moji are Pro-only; their toggles are disabled (not
  // hidden) on Free so owners can see the features exist and why they are
  // unavailable.
  const [quizzesEntitlement, askMojiEntitlement] = await Promise.all([
    ClassmojiService.entitlement.canUseQuizzes(classroom.id),
    ClassmojiService.entitlement.canUseSyllabusBot(classroom.id),
  ]);

  // Whether the Ask Moji switch can be used. On the Trigger runtime
  // (ASK_MOJI_RUNTIME=trigger) that is askMojiAvailable, where "switched off
  // for this class" is the one reason the switch itself fixes; on the AI agent
  // runtime it is the agent being configured.
  const aiAgentAvailable = isAIAgentConfigured();
  let askMojiToggleAvailable = aiAgentAvailable;
  let askMojiUnavailableLine: string | null = null;
  if (ClassmojiService.askMojiSession.askMojiRuntimeIsTrigger()) {
    const availability = await ClassmojiService.askMojiSession.askMojiAvailable({
      classroomId: classroom.id,
    });
    const reason = availability.available ? null : availability.reason;
    askMojiToggleAvailable = reason === null || reason === 'NOT_ENABLED';
    // PRO_REQUIRED has the upsell below; NOT_ENABLED is the switch's own state.
    askMojiUnavailableLine =
      reason && reason !== 'NOT_ENABLED' && reason !== 'PRO_REQUIRED'
        ? ASK_MOJI_AVAILABILITY_COPY[reason]
        : null;
  }

  // Dynamically fetch available models
  const { getAllModels, getModelLabel } = await import('@classmoji/services');

  let models: { anthropic: { value: string; label: string }[] } = {
    anthropic: [],
  };

  try {
    // Try to fetch models - use API key from server-side fetch
    models = await getAllModels({ anthropicApiKey: apiKey! });

    console.log('[AI Settings] Loaded models:', {
      anthropic: models.anthropic.length,
    });
  } catch (error: unknown) {
    console.error('[AI Settings] Error loading models:', error);
    // Fallback models are already handled in getAllModels
  }

  // The "Default: X" on each select: what runs when the classroom names
  // nothing, on whichever runtime serves it.
  const platformDefaults = getPlatformAIDefaults();
  const defaultLabels = {} as Record<SelectField, string>;
  for (const field of MODEL_FIELDS) {
    defaultLabels[field] = getModelLabel(platformDefaults[field], models.anthropic);
  }
  for (const field of EFFORT_FIELDS) {
    defaultLabels[field] = effortLabel(platformDefaults[field]);
  }

  // The model selects offer only the models the agents run.
  const allowedModels = models.anthropic.filter(model => isAllowedModel(model.value));

  // What the selects show. Without a classroom key every AI call runs on the
  // platform defaults, whatever is stored (a value left from before the key was
  // removed, or copied in by a config import), so the selects show the
  // defaults too. The stored values are kept and apply again once a key is
  // added. A stored model off the allow-list runs as the platform default as
  // well, so its select shows the default.
  const selectValues = {} as Record<SelectField, string | null>;
  for (const field of [...MODEL_FIELDS, ...EFFORT_FIELDS]) {
    const stored = apiKey ? (settings?.[field] ?? null) : null;
    selectValues[field] = stored && isModelField(field) && !isAllowedModel(stored) ? null : stored;
  }

  // What the page reads, field by field: the two switches, whether there is a
  // key (never the key), and the owner's Ask Moji instructions (this page is
  // owner-only). The model and effort choices go as selectValues.
  const pageSettings = {
    quizzes_enabled: settings?.quizzes_enabled ?? null,
    syllabus_bot_enabled: settings?.syllabus_bot_enabled ?? null,
    has_anthropic_key: Boolean(apiKey),
    syllabus_bot_instructions: settings?.syllabus_bot_instructions ?? null,
  };

  return {
    settings: pageSettings,
    allowedModels,
    aiAgentAvailable,
    askMojiToggleAvailable,
    askMojiUnavailableLine,
    quizzesProRequired: !quizzesEntitlement.allowed,
    askMojiProRequired: !askMojiEntitlement.allowed,
    defaultLabels,
    selectValues,
  };
};

const SettingsAI = ({ loaderData }: Route.ComponentProps) => {
  const {
    settings,
    allowedModels,
    aiAgentAvailable,
    askMojiToggleAvailable,
    askMojiUnavailableLine,
    quizzesProRequired,
    askMojiProRequired,
    defaultLabels,
    selectValues,
  } = loaderData;
  const { class: classSlug } = useParams();

  const { fetcher } = useGlobalFetcher();

  // Use the computed flag from the loader (API key is never sent to client)
  const hasAnthropicKey = Boolean(settings.has_anthropic_key);

  // The model selects offer the allow-listed models only.
  const modelOptions = allowedModels || [];

  const savedInstructions = settings.syllabus_bot_instructions ?? '';
  const [instructions, setInstructions] = useState(savedInstructions);
  // After a save the loader returns the stored (trimmed) text: show that.
  useEffect(() => setInstructions(savedInstructions), [savedInstructions]);

  const submit = (payload: Record<string, string | boolean | null>) => {
    fetcher!.submit(payload, {
      method: 'POST',
      encType: 'application/json',
      action: `/admin/${classSlug}/settings/ai`,
    });
  };

  const handleQuizzesToggle = (checked: boolean) => {
    submit({ _action: 'saveQuizSettings', quizzes_enabled: checked });
  };

  const handleAskMojiToggle = (checked: boolean) => {
    submit({ _action: 'saveAskMojiSettings', syllabus_bot_enabled: checked });
  };

  const handleSaveInstructions = () => {
    submit({ _action: 'saveAskMojiInstructions', syllabus_bot_instructions: instructions });
  };

  const handleSaveLLMSettings = (values: Record<string, unknown>) => {
    submit(buildLLMSettingsPayload(values, [...MODEL_FIELDS, ...EFFORT_FIELDS], hasAnthropicKey));
  };

  const handleClearSettings = () => {
    Modal.confirm({
      title: 'Clear all AI settings',
      content:
        "Removes the classroom's Anthropic API key and every model and effort choice on this page.",
      okText: 'Clear',
      okType: 'danger',
      onOk: () => {
        submit({ _action: 'clearLLMSettings' });
      },
    });
  };

  const modelSelect = (field: ModelField) => (
    <Select allowClear disabled={!hasAnthropicKey} placeholder={`Default: ${defaultLabels[field]}`}>
      {modelOptions.map((model: { value: string; label: string }) => (
        <Option key={model.value} value={model.value}>
          {model.label}
        </Option>
      ))}
    </Select>
  );

  const effortSelect = (
    field: (typeof EFFORT_FIELDS)[number],
    options: readonly { value: string; label: string }[] = EFFORT_OPTIONS
  ) => (
    <Select allowClear disabled={!hasAnthropicKey} placeholder={`Default: ${defaultLabels[field]}`}>
      {options.map(option => (
        <Option key={option.value} value={option.value}>
          {option.label}
        </Option>
      ))}
    </Select>
  );

  const proTitle = (feature: string) => (
    <span className="inline-flex items-center gap-2">
      {feature}
      <span className="rounded-sm bg-amber-50 px-1.5 py-0.5 text-xs font-medium text-amber-600 dark:bg-amber-900/30 dark:text-amber-400">
        Pro
      </span>
    </span>
  );

  const proUpsell = (feature: string) => (
    <div className="mb-6 flex items-start gap-2 rounded-lg bg-stone-50 p-3 text-sm text-gray-600 dark:bg-neutral-800 dark:text-gray-400">
      <IconInfoCircle size={16} className="mt-0.5 shrink-0" />
      <span>
        {feature} is available on the Pro plan.{' '}
        <a
          href="/settings/billing"
          className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
        >
          Upgrade to enable it
        </a>
        .
      </span>
    </div>
  );

  // The Enable switches show whether the feature is ON for this classroom:
  // without Pro that is off, whatever is stored. The stored flag is left alone
  // (entitlement is checked when serving, never written into settings), so it
  // applies again once the classroom is back on Pro. Unset quizzes_enabled is
  // the schema default, on; unset syllabus_bot_enabled is off.
  const quizzesOn = !quizzesProRequired && (settings.quizzes_enabled ?? true);
  const askMojiOn = !askMojiProRequired && (settings.syllabus_bot_enabled ?? false);

  const subheading = (text: string) => (
    <h3 className="mb-3 mt-2 text-sm font-semibold text-ink-1">{text}</h3>
  );

  const initialValues: Record<string, string | undefined> = { anthropic_api_key: '' };
  for (const field of [...MODEL_FIELDS, ...EFFORT_FIELDS]) {
    // undefined, not null, so an unset Select shows its placeholder.
    initialValues[field] = selectValues[field] ?? undefined;
  }

  return (
    <div className="">
      {!aiAgentAvailable && (
        <Alert
          message="AI features aren't available on this server"
          type="warning"
          showIcon={true}
          style={{ marginBottom: '16px' }}
        />
      )}

      <Form
        // Remount when the key comes or goes: initialValues apply only at
        // mount, and the selects switch between stored values and defaults.
        // No shared `form` instance: its store would outlive the remount, and
        // rc-field-form merges a surviving store OVER the new initialValues
        // (old choices after Clear; placeholders, then nulls on Save, when a
        // key is added). Each mount makes its own store.
        key={hasAnthropicKey ? 'keyed' : 'keyless'}
        layout="vertical"
        onFinish={handleSaveLLMSettings}
        initialValues={initialValues}
      >
        {/* API Key Section */}
        <SettingSection
          title="API Key"
          extra={
            hasAnthropicKey ? (
              <Badge
                count={
                  <span className="px-3 py-1 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300 rounded-full text-sm">
                    Using classroom key
                  </span>
                }
              />
            ) : (
              <Badge
                count={
                  <span className="px-3 py-1 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 rounded-full text-sm">
                    Using system defaults
                  </span>
                }
              />
            )
          }
        >
          <Form.Item
            label="Anthropic API key"
            extra="Models and effort below apply only when the classroom has its own key."
          >
            <div className="flex gap-2">
              <Form.Item name="anthropic_api_key" noStyle>
                <Input.Password placeholder="sk-ant-..." visibilityToggle />
              </Form.Item>
              <Button type="primary" htmlType="submit">
                Save
              </Button>
            </div>
          </Form.Item>
        </SettingSection>

        <Divider />

        {/* AI Quizzes Section */}
        <SettingSection title={proTitle('AI Quizzes')}>
          <Form.Item label="Enable quizzes">
            <Switch
              checked={quizzesOn}
              onChange={handleQuizzesToggle}
              disabled={!aiAgentAvailable || quizzesProRequired}
            />
          </Form.Item>

          {quizzesProRequired && proUpsell('AI Quizzes')}

          {subheading('Models')}
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2 xl:grid-cols-3">
            <Form.Item label="Standard quizzes" name="llm_model">
              {modelSelect('llm_model')}
            </Form.Item>
            <Form.Item label="Code-aware quizzes" name="code_aware_model">
              {modelSelect('code_aware_model')}
            </Form.Item>
            <Form.Item label="Code exploration" name="exploration_model">
              {modelSelect('exploration_model')}
            </Form.Item>
          </div>

          {subheading('Effort')}
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2 xl:grid-cols-3">
            <Form.Item label="Questions" name="question_effort">
              {effortSelect('question_effort')}
            </Form.Item>
            <Form.Item label="Grading" name="grading_effort">
              {effortSelect('grading_effort')}
            </Form.Item>
            <Form.Item label="Code exploration" name="exploration_effort">
              {effortSelect('exploration_effort', EXPLORATION_EFFORT_OPTIONS)}
            </Form.Item>
          </div>

          {/* Without a key the selects are disabled and a Save sends nothing. */}
          <Button type="primary" htmlType="submit" disabled={!hasAnthropicKey}>
            Save
          </Button>
        </SettingSection>

        <Divider />

        {/* Ask Moji Section */}
        <SettingSection title={proTitle('Ask Moji')}>
          <Form.Item label="Enable Ask Moji">
            <Switch
              checked={askMojiOn}
              onChange={handleAskMojiToggle}
              disabled={!askMojiToggleAvailable || askMojiProRequired}
            />
          </Form.Item>

          {askMojiProRequired && proUpsell('Ask Moji')}

          {askMojiUnavailableLine && (
            <div className="mb-6 flex items-start gap-2 rounded-lg bg-stone-50 p-3 text-sm text-gray-600 dark:bg-neutral-800 dark:text-gray-400">
              <IconInfoCircle size={16} className="mt-0.5 shrink-0" />
              <span>{askMojiUnavailableLine}</span>
            </div>
          )}

          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2 xl:grid-cols-3">
            <Form.Item label="Model" name="syllabus_bot_model">
              {modelSelect('syllabus_bot_model')}
            </Form.Item>
            <Form.Item label="Effort" name="syllabus_bot_effort">
              {effortSelect('syllabus_bot_effort')}
            </Form.Item>
          </div>

          <Button type="primary" htmlType="submit" disabled={!hasAnthropicKey}>
            Save
          </Button>

          {/* Not a Form.Item: the instructions save on their own, never with
              the model and effort choices above. */}
          <div className="mt-8">
            {subheading('Instructions')}
            <label htmlFor="syllabus_bot_instructions" className="mb-2 block text-sm text-ink-2">
              Classroom instructions for Ask Moji
            </label>
            <Input.TextArea
              id="syllabus_bot_instructions"
              value={instructions}
              onChange={event => setInstructions(event.target.value)}
              maxLength={INSTRUCTIONS_MAX_CHARS}
              showCount
              autoSize={{ minRows: 4, maxRows: 14 }}
            />
            <p className="mt-6 mb-3 text-xs text-ink-3">Only owners of this class see these.</p>
            <Button
              type="primary"
              htmlType="button"
              onClick={handleSaveInstructions}
              disabled={instructions === savedInstructions}
            >
              Save instructions
            </Button>
          </div>
        </SettingSection>
      </Form>

      {/* Clear All Settings Section */}
      {hasAnthropicKey && (
        <>
          <Divider />
          <SettingSection title="Reset">
            <Button type="primary" onClick={handleClearSettings}>
              Clear all AI settings
            </Button>
          </SettingSection>
        </>
      )}
    </div>
  );
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const classSlug = params.class!;

  // Authorize: only OWNER can modify AI settings
  const { userId, classroom, membership } = await assertClassroomAccess({
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

  // Every save is audited once it has been written: the field names only
  // (never a value: the key is a secret, the instructions are owner-only), and
  // for the instructions their length.
  const audit = async (fields: string[], extra: Record<string, unknown> = {}) =>
    addClassroomAuditLog({
      classroomId: classroom.id,
      userId,
      role: membership!.role,
      action: 'UPDATE',
      resourceType: 'SETTINGS',
      resourceId: classroom.id,
      metadata: {
        tool: AI_SETTINGS_AUDIT_TOOL,
        fields,
        ...extra,
        ...(await impersonationAuditFields(request)),
      },
    });

  // Create FormData with the action from the JSON
  const formData = new FormData();
  if (data._action) {
    formData.append('_action', data._action);
  }

  return namedAction(formData, {
    async saveQuizSettings() {
      // Only the field the toggle owns; model fields go through saveLLMSettings.
      // updateSettings is the hard Pro gate (it refuses only turning quizzes
      // ON); catching here only turns the refusal into a readable message.
      try {
        await ClassmojiService.classroom.updateSettings(classroom.id, {
          quizzes_enabled: Boolean(data.quizzes_enabled),
        });
      } catch (error: unknown) {
        if (error instanceof ClassroomSettingsEntitlementError) {
          return {
            error: error.message,
            action: ActionTypes.SAVE_QUIZ_SETTINGS,
          };
        }
        throw error;
      }
      await audit(['quizzes_enabled']);
      return {
        success: 'Quiz settings updated',
        action: ActionTypes.SAVE_QUIZ_SETTINGS,
      };
    },

    async saveAskMojiSettings() {
      // Only the field the toggle owns; Ask Moji's model and effort go through
      // saveLLMSettings. updateSettings is the hard Pro gate (it refuses only
      // turning Ask Moji ON); catching here only turns the refusal into a
      // readable message instead of a 500.
      try {
        await ClassmojiService.classroom.updateSettings(classroom.id, {
          syllabus_bot_enabled: Boolean(data.syllabus_bot_enabled),
        });
      } catch (error: unknown) {
        if (error instanceof ClassroomSettingsEntitlementError) {
          return {
            error: error.message,
            action: ActionTypes.SAVE_QUIZ_SETTINGS,
          };
        }
        throw error;
      }
      await audit(['syllabus_bot_enabled']);
      return {
        success: 'Ask Moji settings updated',
        action: ActionTypes.SAVE_QUIZ_SETTINGS,
      };
    },

    async saveAskMojiInstructions() {
      // Only this field. Validated by updateSettings (trimmed, blank clears,
      // at most INSTRUCTIONS_MAX_CHARS); a refusal is a fixed line by code.
      const value = data.syllabus_bot_instructions;
      if (value !== null && typeof value !== 'string') {
        return {
          error: INSTRUCTIONS_ERROR_COPY.INSTRUCTIONS_INVALID,
          action: ActionTypes.SAVE_QUIZ_SETTINGS,
        };
      }
      try {
        await ClassmojiService.classroom.updateSettings(classroom.id, {
          syllabus_bot_instructions: value,
        });
      } catch (error: unknown) {
        if (
          error instanceof ClassroomSettingsValidationError &&
          isInstructionsErrorCode(error.code)
        ) {
          return {
            error: INSTRUCTIONS_ERROR_COPY[error.code],
            action: ActionTypes.SAVE_QUIZ_SETTINGS,
          };
        }
        throw error;
      }
      await audit(['syllabus_bot_instructions'], {
        instructions_length: typeof value === 'string' ? value.trim().length : 0,
      });
      return {
        success: 'Ask Moji instructions saved',
        action: ActionTypes.SAVE_QUIZ_SETTINGS,
      };
    },

    async saveLLMSettings() {
      const { anthropic_api_key } = data;

      // Only the fields this form owns. A stale client may still send
      // llm_temperature / llm_max_tokens; nothing sends those to a model, so
      // they are not written.
      const updateData: { anthropic_api_key?: string } & Partial<
        Record<SelectField, string | null>
      > = {};
      for (const field of MODEL_FIELDS) {
        if (!(field in data)) continue;
        const value = data[field];
        // '' and null both mean "platform default", stored as null.
        const model = typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
        // The agents fall back to the platform default for a model off the
        // allow-list, so one is refused rather than stored and ignored.
        if (model && !isAllowedModel(model)) {
          return {
            error: `${MODEL_LABELS[field]} must be one of ${ALLOWED_MODELS.join(', ')}, or empty for the default.`,
            action: ActionTypes.SAVE_QUIZ_SETTINGS,
          };
        }
        updateData[field] = model;
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
          error: 'Choosing a model or effort requires a classroom API key.',
          action: ActionTypes.SAVE_QUIZ_SETTINGS,
        };
      }

      await ClassmojiService.classroom.updateSettings(classroom.id, updateData);
      await audit(Object.keys(updateData));
      return {
        success: 'AI settings saved',
        action: ActionTypes.SAVE_QUIZ_SETTINGS,
      };
    },

    async clearLLMSettings() {
      // Clear the key and every model and effort choice. Not the Enable
      // switches: quizzes_enabled and syllabus_bot_enabled stay as they are.
      const cleared = {
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
        syllabus_bot_model: null,
        syllabus_bot_effort: null,
      };
      await ClassmojiService.classroom.updateSettings(classroom.id, cleared);
      await audit(Object.keys(cleared));
      return {
        success: 'AI settings cleared. Using system defaults.',
        action: ActionTypes.SAVE_QUIZ_SETTINGS,
      };
    },
  });
};

export default SettingsAI;
