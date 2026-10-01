import { describe, expect, it } from 'vitest';
import { isLegacyRuntimeAttempt, isTriggerChatAttempt, runtimeFor } from '../quizRuntime.server';

const STANDARD = { repository_id: null, include_code_context: false };
const CODE_AWARE = { repository_id: 'repo-1', include_code_context: true };
const REPO_WITHOUT_CODE = { repository_id: 'repo-1', include_code_context: false };

const env = (value?: string) =>
  (value === undefined ? {} : { QUIZ_TRIGGER_RUNTIME: value }) as NodeJS.ProcessEnv;

describe('runtimeFor', () => {
  it('answers ai_agent for every quiz when the switch is unset or off', () => {
    for (const value of [undefined, '', 'off', 'OFF']) {
      expect(runtimeFor(STANDARD, env(value))).toBe('ai_agent');
      expect(runtimeFor(CODE_AWARE, env(value))).toBe('ai_agent');
    }
  });

  it('answers ai_agent for a value it does not know', () => {
    for (const value of ['on', 'true', 'code-aware', 'trigger_chat']) {
      expect(runtimeFor(CODE_AWARE, env(value))).toBe('ai_agent');
    }
  });

  it('moves only code-aware quizzes when the switch is code_aware', () => {
    expect(runtimeFor(CODE_AWARE, env('code_aware'))).toBe('trigger_chat');
    expect(runtimeFor(STANDARD, env('code_aware'))).toBe('ai_agent');
    expect(runtimeFor(REPO_WITHOUT_CODE, env('code_aware'))).toBe('ai_agent');
    expect(runtimeFor(null, env('code_aware'))).toBe('ai_agent');
  });

  it('moves every quiz when the switch is all', () => {
    expect(runtimeFor(STANDARD, env('all'))).toBe('trigger_chat');
    expect(runtimeFor(CODE_AWARE, env(' All '))).toBe('trigger_chat');
  });
});

describe('the attempt stamp', () => {
  it('lets the legacy actions act on ai_agent attempts and rows without the column', () => {
    expect(isLegacyRuntimeAttempt({ agent_runtime: 'ai_agent' })).toBe(true);
    expect(isLegacyRuntimeAttempt({})).toBe(true);
    expect(isLegacyRuntimeAttempt({ agent_runtime: 'trigger_chat' })).toBe(false);
    expect(isLegacyRuntimeAttempt({ agent_runtime: 'something_else' })).toBe(false);
  });

  it('names a chat-runtime attempt only by its exact stamp', () => {
    expect(isTriggerChatAttempt({ agent_runtime: 'trigger_chat' })).toBe(true);
    expect(isTriggerChatAttempt({ agent_runtime: 'ai_agent' })).toBe(false);
    expect(isTriggerChatAttempt({})).toBe(false);
    expect(isTriggerChatAttempt(null)).toBe(false);
  });
});
