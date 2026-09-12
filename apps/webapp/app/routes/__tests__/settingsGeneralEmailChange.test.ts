/**
 * Unit tests for the account email change (issue #343). Pins the contract the
 * stuck-student fix depends on: only the signed-in user's own row is written,
 * only after a verified code, never to an address another account holds, and
 * through ClassmojiService.user.update (which is what claims pending invites).
 * `provider_email` is never part of the write.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  userFindFirst: vi.fn(),
  userUpdate: vi.fn(),
  sendCode: vi.fn(),
  consumeCode: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({
  requireAuth: (...a: unknown[]) => mocks.requireAuth(...a),
}));
vi.mock('@classmoji/database', () => ({
  default: () => ({
    user: { findFirst: (...a: unknown[]) => mocks.userFindFirst(...a) },
  }),
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: { user: { update: (...a: unknown[]) => mocks.userUpdate(...a) } },
}));
vi.mock('~/utils/emailVerification.server', () => ({
  sendEmailVerificationCode: (...a: unknown[]) => mocks.sendCode(...a),
  consumeEmailVerificationCode: (...a: unknown[]) => mocks.consumeCode(...a),
}));
vi.mock('~/store', () => ({ default: () => ({ user: null }) }));

const { action } = await import('../_user.settings.general/route');

const post = (body: Record<string, unknown>) =>
  action({
    request: new Request('http://localhost/settings/general', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: {},
    context: {},
  } as never) as Promise<Record<string, unknown>>;

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.requireAuth.mockResolvedValue({ userId: 'me' });
  mocks.userFindFirst.mockResolvedValue(null);
  mocks.consumeCode.mockResolvedValue(true);
});

describe('settings.general action: change email', () => {
  it('rejects a malformed address before doing anything', async () => {
    expect(await post({ intent: 'send-code', email: 'not-an-email' })).toEqual({
      error: 'Please enter a valid email address.',
    });
    expect(mocks.sendCode).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('refuses an address held by another account, case-insensitively, excluding self', async () => {
    mocks.userFindFirst.mockResolvedValue({ id: 'someone-else' });
    const result = await post({ intent: 'send-code', email: 'Taken@School.edu' });
    expect(result.error).toMatch(/already in use/);
    expect(mocks.userFindFirst.mock.calls[0][0].where).toEqual({
      email: { equals: 'Taken@School.edu', mode: 'insensitive' },
      NOT: { id: 'me' },
    });
    expect(mocks.sendCode).not.toHaveBeenCalled();
  });

  it('sends a code to the trimmed new address', async () => {
    expect(await post({ intent: 'send-code', email: '  new@school.edu ' })).toEqual({
      codeSent: true,
    });
    expect(mocks.sendCode).toHaveBeenCalledWith('new@school.edu');
  });

  it('does not write without a valid code', async () => {
    mocks.consumeCode.mockResolvedValue(false);
    const result = await post({ intent: 'change-email', email: 'new@school.edu', code: '000000' });
    expect(result.error).toMatch(/Invalid or expired/);
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('writes only email (and emailVerified) on the signed-in user, via the service', async () => {
    const result = await post({ intent: 'change-email', email: 'new@school.edu', code: '123456' });
    expect(result).toEqual({ changed: true });
    expect(mocks.consumeCode).toHaveBeenCalledWith('new@school.edu', '123456');
    expect(mocks.userUpdate).toHaveBeenCalledTimes(1);
    const [userId, data] = mocks.userUpdate.mock.calls[0];
    expect(userId).toBe('me');
    expect(data).toEqual({ email: 'new@school.edu', emailVerified: true });
    expect(data).not.toHaveProperty('provider_email');
  });

  it('saves a trimmed School ID on the signed-in user, and clears it when emptied', async () => {
    expect(await post({ intent: 'update-school-id', school_id: '  F004567 ' })).toEqual({
      schoolIdSaved: true,
    });
    expect(mocks.userUpdate).toHaveBeenCalledWith('me', { school_id: 'F004567' });

    expect(await post({ intent: 'update-school-id', school_id: '   ' })).toEqual({
      schoolIdSaved: true,
    });
    expect(mocks.userUpdate).toHaveBeenLastCalledWith('me', { school_id: null });
  });

  it('refuses an over-long School ID without writing', async () => {
    const result = await post({ intent: 'update-school-id', school_id: 'x'.repeat(65) });
    expect(result.error).toMatch(/64 characters/);
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });

  it('requires a session', async () => {
    mocks.requireAuth.mockRejectedValue(new Response(null, { status: 401 }));
    await expect(post({ intent: 'send-code', email: 'new@school.edu' })).rejects.toBeInstanceOf(
      Response
    );
  });
});
