/**
 * The Extensions tab's save: OWNER-gated, and it writes only the field its form
 * sends (`default_tokens_per_hour`), never anything else in the body.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: { updateSettings: (...a: unknown[]) => mocks.updateSettings(...a) },
  },
}));

vi.mock('~/components', () => ({ SettingSection: () => null }));
vi.mock('~/hooks', () => ({ useGlobalFetcher: () => ({ fetcher: null }) }));

const { action } = await import('../route');

const save = (body: unknown) =>
  action({
    params: { class: 'cs52' },
    request: new Request('http://x/admin/cs52/settings/extension?/saveExtensionSettings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never) as Promise<{ success?: string; error?: string }>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertClassroomAccess.mockResolvedValue({
    classroom: { id: 'c1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  });
  mocks.updateSettings.mockResolvedValue({});
});

describe('saveExtensionSettings', () => {
  it('is gated to OWNER', async () => {
    await save({ default_tokens_per_hour: 2 });
    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ allowedRoles: ['OWNER'], classroomSlug: 'cs52' })
    );
  });

  it('writes the tokens-per-hour price', async () => {
    const result = await save({ default_tokens_per_hour: 3 });
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', { default_tokens_per_hour: 3 });
    expect(result.success).toBe('Extension settings updated');
  });

  it('writes 0 (extensions off)', async () => {
    await save({ default_tokens_per_hour: 0 });
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', { default_tokens_per_hour: 0 });
  });

  it('ignores every other settings field in the body', async () => {
    await save({
      default_tokens_per_hour: 2,
      show_grades_to_students: true,
      anthropic_api_key: 'sk-x',
      syllabus_bot_enabled: true,
    });
    expect(mocks.updateSettings).toHaveBeenCalledWith('c1', { default_tokens_per_hour: 2 });
  });
});
