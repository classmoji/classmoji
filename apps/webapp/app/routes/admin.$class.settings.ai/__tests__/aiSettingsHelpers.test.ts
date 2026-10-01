/**
 * The two pure pieces of the AI settings page: the platform defaults behind
 * each "Default: X" (the quiz runtimes' resolver for the quiz models, the
 * shared FALLBACK_MODEL for Ask Moji, a mirror of the ai-agent's fallbacks for
 * the efforts), and the request the form sends on Save.
 */

import { describe, expect, it } from 'vitest';
import { FALLBACK_MODEL } from '@classmoji/utils/ai-models';
import { buildLLMSettingsPayload } from '../llmSettingsPayload';
import { getPlatformAIDefaults } from '../platformDefaults.server';

describe('getPlatformAIDefaults', () => {
  it('uses the code defaults when no env var is set: Sonnet 5.5 for quizzes and Ask Moji', () => {
    expect(getPlatformAIDefaults({})).toEqual({
      llm_model: 'claude-sonnet-5-5',
      code_aware_model: 'claude-sonnet-5-5',
      exploration_model: 'claude-sonnet-5-5',
      syllabus_bot_model: 'claude-sonnet-5-5',
      question_effort: 'medium',
      grading_effort: 'high',
      exploration_effort: 'low',
      syllabus_bot_effort: 'low',
    });
  });

  // One constant: the quiz runtimes and Ask Moji fall back to FALLBACK_MODEL,
  // and the page names the same one.
  it('names FALLBACK_MODEL for the three quiz models and Ask Moji', () => {
    const defaults = getPlatformAIDefaults({});
    expect(defaults.llm_model).toBe(FALLBACK_MODEL);
    expect(defaults.code_aware_model).toBe(FALLBACK_MODEL);
    expect(defaults.exploration_model).toBe(FALLBACK_MODEL);
    expect(defaults.syllabus_bot_model).toBe(FALLBACK_MODEL);
  });

  it('reads the platform env vars', () => {
    expect(
      getPlatformAIDefaults({
        LLM_MODEL: 'claude-opus-5-5',
        EXPLORATION_MODEL: 'claude-fable-5',
        SYLLABUS_BOT_MODEL: 'claude-sonnet-5',
        QUIZ_QUESTION_EFFORT: 'low',
        QUIZ_GRADING_EFFORT: 'xhigh',
        EXPLORATION_EFFORT: 'medium',
        SYLLABUS_BOT_EFFORT: 'high',
      })
    ).toEqual({
      llm_model: 'claude-opus-5-5',
      code_aware_model: 'claude-opus-5-5',
      exploration_model: 'claude-fable-5',
      syllabus_bot_model: 'claude-sonnet-5',
      question_effort: 'low',
      grading_effort: 'xhigh',
      exploration_effort: 'medium',
      syllabus_bot_effort: 'high',
    });
  });

  // Both quiz runtimes ignore a platform model off the allow-list and run
  // FALLBACK_MODEL; Ask Moji has no allow-list and takes it as is.
  it('names FALLBACK_MODEL for a quiz env model off the allow-list, not for Ask Moji', () => {
    const defaults = getPlatformAIDefaults({
      LLM_MODEL: 'claude-haiku-4-5-20251001',
      EXPLORATION_MODEL: 'claude-haiku-4-5',
    });
    expect(defaults.llm_model).toBe(FALLBACK_MODEL);
    expect(defaults.code_aware_model).toBe(FALLBACK_MODEL);
    expect(defaults.exploration_model).toBe(FALLBACK_MODEL);
    expect(defaults.syllabus_bot_model).toBe('claude-haiku-4-5-20251001');
  });

  it('trims a quiz env model, as the quiz runtimes do', () => {
    expect(getPlatformAIDefaults({ LLM_MODEL: ' claude-opus-5 ' }).llm_model).toBe('claude-opus-5');
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
