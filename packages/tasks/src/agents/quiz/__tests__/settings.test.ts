import { describe, expect, it } from 'vitest';
import { resolveQuizRunSettings } from '../settings.ts';

const env = {
  ANTHROPIC_API_KEY: 'platform-key',
  LLM_MODEL: 'claude-sonnet-5',
  EXPLORATION_MODEL: 'claude-sonnet-5',
};

describe('resolveQuizRunSettings', () => {
  it('uses the platform key and models when the classroom has no key', () => {
    const s = resolveQuizRunSettings(
      { llm_model: 'claude-opus-5-5', question_effort: 'max', anthropic_api_key: '  ' },
      { isCodeAware: false },
      env
    );
    expect(s.apiKey).toBe('platform-key');
    expect(s.keySource).toBe('platform');
    expect(s.model).toBe('claude-sonnet-5');
    expect(s.questionEffort).toBe('medium');
    expect(s.gradingEffort).toBe('high');
    expect(s.fallbacks).toContain('classroom_choices_without_key');
  });

  it('uses the classroom key and choices when it has a key', () => {
    const s = resolveQuizRunSettings(
      {
        anthropic_api_key: 'classroom-key',
        llm_model: 'claude-opus-5-5',
        question_effort: 'low',
        grading_effort: 'xhigh',
      },
      { isCodeAware: false },
      env
    );
    expect(s.apiKey).toBe('classroom-key');
    expect(s.keySource).toBe('classroom');
    expect(s.model).toBe('claude-opus-5-5');
    expect(s.questionEffort).toBe('low');
    expect(s.gradingEffort).toBe('xhigh');
  });

  it('reads code_aware_model for code-aware quizzes', () => {
    const s = resolveQuizRunSettings(
      { anthropic_api_key: 'k', llm_model: 'claude-opus-5', code_aware_model: 'claude-fable-5-1' },
      { isCodeAware: true },
      env
    );
    expect(s.model).toBe('claude-fable-5-1');
  });

  it('falls back to the platform default for a model outside the allowlist', () => {
    const s = resolveQuizRunSettings(
      { anthropic_api_key: 'k', llm_model: 'claude-haiku-4-5' },
      { isCodeAware: false },
      env
    );
    expect(s.model).toBe('claude-sonnet-5');
    expect(s.fallbacks).toContain('llm_model');
  });

  it('does not admit a longer model id by prefix', () => {
    const s = resolveQuizRunSettings(
      { anthropic_api_key: 'k', llm_model: 'claude-opus-5-9' },
      { isCodeAware: false },
      env
    );
    expect(s.model).toBe('claude-sonnet-5');
  });

  it('falls back to the code default when the platform default is not allowed', () => {
    const s = resolveQuizRunSettings({}, { isCodeAware: false }, { ...env, LLM_MODEL: 'claude-3-haiku' });
    expect(s.model).toBe('claude-sonnet-5');
    expect(s.fallbacks).toContain('LLM_MODEL');
  });

  it('caps exploration effort at high and skips invalid values', () => {
    const s = resolveQuizRunSettings(
      { anthropic_api_key: 'k', exploration_effort: 'max', question_effort: 'hgih' },
      { isCodeAware: true },
      { ...env, QUIZ_QUESTION_EFFORT: 'LOW' }
    );
    expect(s.exploration.effort).toBe('high');
    expect(s.questionEffort).toBe('low');
  });

  it('uses the classroom exploration model only with a key', () => {
    const keyed = resolveQuizRunSettings(
      { anthropic_api_key: 'k', exploration_model: 'claude-opus-5' },
      { isCodeAware: true },
      env
    );
    const keyless = resolveQuizRunSettings({ exploration_model: 'claude-opus-5' }, { isCodeAware: true }, env);
    expect(keyed.exploration.model).toBe('claude-opus-5');
    expect(keyless.exploration.model).toBe('claude-sonnet-5');
  });

  it('refuses to run with no key at all', () => {
    expect(() => resolveQuizRunSettings({}, { isCodeAware: false }, {})).toThrow();
  });
});
