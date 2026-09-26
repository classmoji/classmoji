/**
 * The two pure pieces of the AI settings page: the platform defaults behind
 * each "Default: X" (a mirror of the ai-agent's fallbacks), and the request
 * the form sends on Save.
 */

import { describe, expect, it } from 'vitest';
import { buildLLMSettingsPayload } from '../llmSettingsPayload';
import { getPlatformAIDefaults } from '../platformDefaults.server';

describe('getPlatformAIDefaults', () => {
  it("uses the ai-agent's code fallbacks when no env var is set", () => {
    expect(getPlatformAIDefaults({})).toEqual({
      llm_model: 'claude-sonnet-4-5-20250929',
      code_aware_model: 'claude-sonnet-4-5-20250929',
      exploration_model: 'claude-sonnet-5',
      syllabus_bot_model: 'claude-sonnet-4-5-20250929',
      question_effort: 'medium',
      grading_effort: 'high',
      exploration_effort: 'low',
      syllabus_bot_effort: 'low',
    });
  });

  it('reads the env vars the ai-agent reads', () => {
    expect(
      getPlatformAIDefaults({
        LLM_MODEL: 'claude-opus-5-5',
        EXPLORATION_MODEL: 'claude-haiku-4-5-20251001',
        SYLLABUS_BOT_MODEL: 'claude-sonnet-5',
        QUIZ_QUESTION_EFFORT: 'low',
        QUIZ_GRADING_EFFORT: 'xhigh',
        EXPLORATION_EFFORT: 'medium',
        SYLLABUS_BOT_EFFORT: 'high',
      })
    ).toEqual({
      llm_model: 'claude-opus-5-5',
      code_aware_model: 'claude-opus-5-5',
      exploration_model: 'claude-haiku-4-5-20251001',
      syllabus_bot_model: 'claude-sonnet-5',
      question_effort: 'low',
      grading_effort: 'xhigh',
      exploration_effort: 'medium',
      syllabus_bot_effort: 'high',
    });
  });

  it("falls back from SYLLABUS_BOT_MODEL to LLM_MODEL, as Ask Moji's service does", () => {
    expect(getPlatformAIDefaults({ LLM_MODEL: 'claude-opus-5-5' }).syllabus_bot_model).toBe(
      'claude-opus-5-5'
    );
  });

  it('forgives case and whitespace in an effort, and ignores one that is not a level', () => {
    const defaults = getPlatformAIDefaults({
      QUIZ_QUESTION_EFFORT: ' HIGH ',
      QUIZ_GRADING_EFFORT: 'hgih',
      SYLLABUS_BOT_EFFORT: '',
    });
    expect(defaults.question_effort).toBe('high');
    expect(defaults.grading_effort).toBe('high');
    expect(defaults.syllabus_bot_effort).toBe('low');
  });

  it.each([['xhigh'], ['max']])('caps an exploration effort of %s at high', level => {
    expect(getPlatformAIDefaults({ EXPLORATION_EFFORT: level }).exploration_effort).toBe('high');
  });
});

describe('buildLLMSettingsPayload', () => {
  const FIELDS = ['llm_model', 'syllabus_bot_effort'];

  it('sends every field with a key, a cleared one as null', () => {
    expect(
      buildLLMSettingsPayload(
        { anthropic_api_key: '', llm_model: 'claude-sonnet-5', syllabus_bot_effort: undefined },
        FIELDS,
        true
      )
    ).toEqual({
      _action: 'saveLLMSettings',
      anthropic_api_key: '',
      llm_model: 'claude-sonnet-5',
      syllabus_bot_effort: null,
    });
  });

  // The keyless selects show the defaults, not what is stored; sending their
  // empty values would null every stored choice.
  it('sends only the key without one', () => {
    expect(
      buildLLMSettingsPayload(
        { anthropic_api_key: 'sk-ant-new', llm_model: undefined, syllabus_bot_effort: undefined },
        FIELDS,
        false
      )
    ).toEqual({ _action: 'saveLLMSettings', anthropic_api_key: 'sk-ant-new' });
  });
});
