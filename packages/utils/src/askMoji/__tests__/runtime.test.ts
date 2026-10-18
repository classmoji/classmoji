/** `askMojiRuntime`: one parse of `ASK_MOJI_RUNTIME` for every app. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ASK_MOJI_RUNTIMES,
  askMojiRuntime,
  isAskMojiTriggerRuntime,
  resetAskMojiRuntimeWarning,
} from '../index.ts';

afterEach(() => {
  resetAskMojiRuntimeWarning();
  vi.restoreAllMocks();
});

describe('askMojiRuntime', () => {
  it('is trigger only for exactly "trigger"', () => {
    expect(askMojiRuntime({ ASK_MOJI_RUNTIME: 'trigger' })).toBe('trigger');
    expect(isAskMojiTriggerRuntime({ ASK_MOJI_RUNTIME: 'trigger' })).toBe(true);
    expect(isAskMojiTriggerRuntime({ ASK_MOJI_RUNTIME: 'ai_agent' })).toBe(false);
    expect(ASK_MOJI_RUNTIMES).toEqual(['trigger', 'ai_agent']);
  });

  it('is ai_agent when unset, empty or ai_agent, without a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(askMojiRuntime({})).toBe('ai_agent');
    expect(askMojiRuntime({ ASK_MOJI_RUNTIME: '' })).toBe('ai_agent');
    expect(askMojiRuntime({ ASK_MOJI_RUNTIME: 'ai_agent' })).toBe('ai_agent');
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads an unknown value as ai_agent and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(askMojiRuntime({ ASK_MOJI_RUNTIME: 'Trigger' })).toBe('ai_agent');
    expect(askMojiRuntime({ ASK_MOJI_RUNTIME: ' trigger' })).toBe('ai_agent');
    expect(isAskMojiTriggerRuntime({ ASK_MOJI_RUNTIME: 'yes' })).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('"Trigger"');
  });

  it('reads process.env by default', () => {
    const before = process.env.ASK_MOJI_RUNTIME;
    try {
      process.env.ASK_MOJI_RUNTIME = 'trigger';
      expect(askMojiRuntime()).toBe('trigger');
      expect(isAskMojiTriggerRuntime()).toBe(true);
      delete process.env.ASK_MOJI_RUNTIME;
      expect(askMojiRuntime()).toBe('ai_agent');
    } finally {
      if (before === undefined) delete process.env.ASK_MOJI_RUNTIME;
      else process.env.ASK_MOJI_RUNTIME = before;
    }
  });
});
