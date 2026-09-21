/**
 * Issue #391: the generated workflow pointed at platform.internal.trigger.dev,
 * the address the platform hands a deployed worker in TRIGGER_API_URL. The
 * workflow must use a PUBLIC Trigger.dev address, and never an internal one.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  auth: { createTriggerPublicToken: vi.fn() },
}));
vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {},
  getGitProvider: vi.fn(),
  generateClassroomWorkflow: vi.fn(),
  signAutogradeCallbackToken: vi.fn(),
  verifyAutogradeCallbackToken: vi.fn(),
}));

const { publicTriggerApiBase } = await import('../autograde.ts');

describe('publicTriggerApiBase', () => {
  it('defaults to the Trigger.dev cloud', () => {
    expect(publicTriggerApiBase({})).toBe('https://api.trigger.dev');
  });

  it('ignores the worker-internal TRIGGER_API_URL entirely', () => {
    expect(
      publicTriggerApiBase({ TRIGGER_API_URL: 'http://platform.internal.trigger.dev:44330' })
    ).toBe('https://api.trigger.dev');
  });

  it('takes a self-hosted public address, without a trailing slash', () => {
    expect(publicTriggerApiBase({ TRIGGER_PUBLIC_API_URL: 'https://trigger.school.edu/' })).toBe(
      'https://trigger.school.edu'
    );
  });

  it('refuses an address GitHub Actions cannot reach', () => {
    expect(() =>
      publicTriggerApiBase({ TRIGGER_PUBLIC_API_URL: 'http://platform.internal.trigger.dev:44330' })
    ).toThrow(/reachable from GitHub Actions/);
    expect(() => publicTriggerApiBase({ TRIGGER_PUBLIC_API_URL: 'http://localhost:3030' })).toThrow(
      /reachable/
    );
  });
});
