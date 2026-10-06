/**
 * Issue #396: the registration action mailed a verification code to whatever
 * string was posted. These pin the fix: the address is normalized once
 * (trimmed, lower-cased) and validated before any code is created or sent, the
 * same normalized value is what verify-code and the register step look up, and
 * every intent requires the signed-in session the page itself requires (an
 * anonymous POST could otherwise mail codes to arbitrary addresses).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  sendCode: vi.fn(),
  isCodeValid: vi.fn(),
  consumeCode: vi.fn(),
  userFindFirst: vi.fn(),
  userUpdate: vi.fn(),
  subscriptionCount: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => mocks.getAuthSession(...a),
}));
vi.mock('@classmoji/database', () => ({
  default: () => ({
    user: {
      findFirst: (...a: unknown[]) => mocks.userFindFirst(...a),
      update: (...a: unknown[]) => mocks.userUpdate(...a),
    },
    subscription: { count: (...a: unknown[]) => mocks.subscriptionCount(...a) },
  }),
  GIT_IDENTITY: {},
  whereGitUsername: vi.fn(),
}));
vi.mock('@classmoji/utils', () => ({
  generateId: vi.fn(() => 1),
  gitUsername: vi.fn(() => null),
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: { classroomInvite: { claimPendingInvites: vi.fn() } },
}));
vi.mock('@classmoji/auth/invite-token', () => ({
  verifyInviteToken: vi.fn(() => null),
  inviteTokenMatchesEmail: vi.fn(() => false),
}));
vi.mock('~/utils/emailVerification.server', () => ({
  sendEmailVerificationCode: (...a: unknown[]) => mocks.sendCode(...a),
  isEmailVerificationCodeValid: (...a: unknown[]) => mocks.isCodeValid(...a),
  consumeEmailVerificationCode: (...a: unknown[]) => mocks.consumeCode(...a),
}));

const { action } = await import('../registration/route');

const post = (body: Record<string, unknown>) =>
  action({
    request: new Request('http://localhost/registration', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: {},
    context: {},
  } as never) as Promise<unknown>;

const INVALID = { error: 'Please enter a valid email address.' };

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.getAuthSession.mockResolvedValue({ userId: 'me' });
  mocks.isCodeValid.mockResolvedValue(true);
  mocks.consumeCode.mockResolvedValue(true);
  mocks.userFindFirst.mockResolvedValue(null);
  mocks.userUpdate.mockResolvedValue({ id: 'me' });
  mocks.subscriptionCount.mockResolvedValue(1);
  mocks.sendCode.mockResolvedValue({ sent: true });
});

describe('registration action: send-code', () => {
  it.each([
    ['a number (the issue example)', '1234567'],
    ['a bare username', 'jdoe'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['a comma-separated list', 'a@school.edu,b@school.edu'],
    ['a display name', 'Jane <jane@school.edu>'],
    ['consecutive dots', 'jane..doe@school.edu'],
    ['a hyphen-edged domain label', 'jane@-school.edu'],
  ])('rejects %s before mailing anything', async (_label, email) => {
    expect(await post({ intent: 'send-code', email })).toEqual(INVALID);
    expect(mocks.sendCode).not.toHaveBeenCalled();
  });

  it('rejects a missing or non-string email the same way', async () => {
    expect(await post({ intent: 'send-code' })).toEqual(INVALID);
    expect(await post({ intent: 'send-code', email: 1234567 })).toEqual(INVALID);
    expect(mocks.sendCode).not.toHaveBeenCalled();
  });

  it('sends to the trimmed, lower-cased address', async () => {
    expect(await post({ intent: 'send-code', email: '  Student@School.EDU \n' })).toEqual({
      codeSent: true,
    });
    expect(mocks.sendCode).toHaveBeenCalledWith('student@school.edu', 'me');
  });

  it.each(['student+cs52@school.edu', 'jane@mail.dartmouth.edu', 'j.doe@cs.ox.ac.uk'])(
    'accepts %s',
    async email => {
      expect(await post({ intent: 'send-code', email })).toEqual({ codeSent: true });
      expect(mocks.sendCode).toHaveBeenCalledWith(email, 'me');
    }
  );
});

describe('registration action: send-code throttling', () => {
  it('turns a cooldown into the friendly error and keeps the code step open', async () => {
    mocks.sendCode.mockResolvedValue({
      sent: false,
      reason: 'cooldown',
      error: 'Please wait a minute before requesting another code.',
      codePending: true,
    });
    expect(await post({ intent: 'send-code', email: 'student@school.edu' })).toEqual({
      error: 'Please wait a minute before requesting another code.',
      codeSent: true,
    });
  });

  it('turns the per-user cap into an error, without codeSent when no code is live', async () => {
    mocks.sendCode.mockResolvedValue({
      sent: false,
      reason: 'user-cap',
      error: 'Too many verification codes requested. Please try again in an hour.',
      codePending: false,
    });
    expect(await post({ intent: 'send-code', email: 'student@school.edu' })).toEqual({
      error: 'Too many verification codes requested. Please try again in an hour.',
    });
  });
});

describe('registration action: verify-code and register use the same normalized address', () => {
  it('verify-code looks up the normalized address and trimmed code', async () => {
    expect(
      await post({ intent: 'verify-code', email: ' Student@School.edu ', code: ' 123456 ' })
    ).toEqual({ verified: true });
    expect(mocks.isCodeValid).toHaveBeenCalledWith('student@school.edu', '123456');
  });

  it('verify-code refuses an invalid address without a lookup', async () => {
    expect(await post({ intent: 'verify-code', email: 'jdoe', code: '123456' })).toEqual({
      verifyError: 'Invalid or expired code. Try resending.',
    });
    expect(mocks.isCodeValid).not.toHaveBeenCalled();
  });

  it('verify-code never passes an absent code through as undefined', async () => {
    mocks.isCodeValid.mockResolvedValue(false);
    await post({ intent: 'verify-code', email: 'student@school.edu' });
    expect(mocks.isCodeValid).toHaveBeenCalledWith('student@school.edu', '');
  });

  it('register consumes and stores the normalized address', async () => {
    const res = await post({
      intent: 'register',
      email: ' Student@School.edu ',
      code: '123456',
      name: 'Student',
    });
    expect(res).toBeInstanceOf(Response);
    expect(mocks.consumeCode).toHaveBeenCalledWith('student@school.edu', '123456');
    expect(mocks.userUpdate.mock.calls[0][0].data.email).toBe('student@school.edu');
  });

  it('register refuses an invalid address before consuming anything', async () => {
    expect(await post({ intent: 'register', email: 'jdoe', code: '123456' })).toEqual(INVALID);
    expect(mocks.consumeCode).not.toHaveBeenCalled();
    expect(mocks.userUpdate).not.toHaveBeenCalled();
  });
});

describe('registration action: session', () => {
  it.each(['send-code', 'verify-code', 'register'])(
    'redirects an anonymous %s to / without touching codes',
    async intent => {
      mocks.getAuthSession.mockResolvedValue(null);
      const res = await post({ intent, email: 'student@school.edu', code: '123456' });
      expect(res).toBeInstanceOf(Response);
      expect((res as Response).headers.get('Location')).toBe('/');
      expect(mocks.sendCode).not.toHaveBeenCalled();
      expect(mocks.isCodeValid).not.toHaveBeenCalled();
      expect(mocks.consumeCode).not.toHaveBeenCalled();
    }
  );
});
