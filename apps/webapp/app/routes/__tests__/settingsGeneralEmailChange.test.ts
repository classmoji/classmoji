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
  isViewingAs: vi.fn(),
  setPassword: vi.fn(),
  userFindFirst: vi.fn(),
  userUpdate: vi.fn(),
  sendCode: vi.fn(),
  consumeCode: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({
  requireAuth: (...a: unknown[]) => mocks.requireAuth(...a),
  isViewingAsAnotherUser: (...a: unknown[]) => mocks.isViewingAs(...a),
  auth: { api: { setPassword: (...a: unknown[]) => mocks.setPassword(...a) } },
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
const { ACCOUNT_DETAILS_IMPERSONATION_MESSAGE } = await import('~/utils/impersonationSession');

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
  mocks.isViewingAs.mockResolvedValue(false);
  mocks.setPassword.mockResolvedValue({ status: true });
  mocks.userFindFirst.mockResolvedValue(null);
  mocks.consumeCode.mockResolvedValue(true);
  mocks.sendCode.mockResolvedValue({ sent: true });
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
    // The address is normalized to lower case before it is looked up or stored.
    expect(mocks.userFindFirst.mock.calls[0][0].where).toEqual({
      email: { equals: 'taken@school.edu', mode: 'insensitive' },
      NOT: { id: 'me' },
    });
    expect(mocks.sendCode).not.toHaveBeenCalled();
  });

  it('sends a code to the trimmed new address', async () => {
    expect(await post({ intent: 'send-code', email: '  new@school.edu ' })).toEqual({
      codeSent: true,
    });
    expect(mocks.sendCode).toHaveBeenCalledWith('new@school.edu', 'me');
  });

  it('turns a throttled send into the friendly error, keeping the code step when one is live', async () => {
    mocks.sendCode.mockResolvedValue({
      sent: false,
      reason: 'cooldown',
      error: 'Please wait a minute before requesting another code.',
      codePending: true,
    });
    expect(await post({ intent: 'send-code', email: 'new@school.edu' })).toEqual({
      error: 'Please wait a minute before requesting another code.',
      codeSent: true,
    });

    mocks.sendCode.mockResolvedValue({
      sent: false,
      reason: 'user-cap',
      error: 'Too many verification codes requested. Please try again in an hour.',
      codePending: false,
    });
    expect(await post({ intent: 'send-code', email: 'other@school.edu' })).toEqual({
      error: 'Too many verification codes requested. Please try again in an hour.',
    });
    expect(mocks.userUpdate).not.toHaveBeenCalled();
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

describe('settings.general action: set password', () => {
  it('adds a password through better-auth with the request headers', async () => {
    expect(await post({ intent: 'set-password', password: 'long-enough' })).toEqual({
      passwordSet: true,
    });
    expect(mocks.setPassword).toHaveBeenCalledTimes(1);
    expect(mocks.setPassword.mock.calls[0][0].body).toEqual({ newPassword: 'long-enough' });
  });
});

describe('settings.general action: while viewing as another user', () => {
  beforeEach(() => {
    mocks.isViewingAs.mockResolvedValue(true);
  });

  it.each([
    { intent: 'set-password', password: 'long-enough' },
    { intent: 'send-code', email: 'new@school.edu' },
    { intent: 'change-email', email: 'new@school.edu', code: '123456' },
    { intent: 'update-school-id', school_id: 'F004567' },
  ])('refuses $intent and changes nothing', async body => {
    expect(await post(body)).toEqual({ error: ACCOUNT_DETAILS_IMPERSONATION_MESSAGE });
    expect(mocks.setPassword).not.toHaveBeenCalled();
    expect(mocks.sendCode).not.toHaveBeenCalled();
    expect(mocks.consumeCode).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
    expect(mocks.userFindFirst).not.toHaveBeenCalled();
  });

  it('asks with the request headers, after the session check', async () => {
    await post({ intent: 'send-code', email: 'new@school.edu' });
    const [headers] = mocks.isViewingAs.mock.calls[0];
    expect(headers).toBeInstanceOf(Headers);
    expect(mocks.requireAuth).toHaveBeenCalledTimes(1);
  });
});
