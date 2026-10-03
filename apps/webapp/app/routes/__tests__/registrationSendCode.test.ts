/**
 * Issue #396: `send-code` mailed a verification code to whatever string was
 * posted, with no format check anywhere on the server path. An obviously
 * malformed address (no @, no domain) still queued a send, which burns the
 * email task's retry budget against a destination that can never deliver and
 * leaves the user stuck with no code and no visible error. This mirrors the
 * same guard already proven in settings/general
 * (settingsGeneralEmailChange.test.ts): reject before calling
 * sendEmailVerificationCode, only for a shape that cannot possibly be an
 * email.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAuthSession: vi.fn(),
  sendCode: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: (...a: unknown[]) => mocks.getAuthSession(...a),
}));
vi.mock('@classmoji/database', () => ({
  default: () => ({}),
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
  isEmailVerificationCodeValid: vi.fn(),
  consumeEmailVerificationCode: vi.fn(),
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
  } as never) as Promise<Record<string, unknown>>;

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
  mocks.getAuthSession.mockResolvedValue({ userId: 'me' });
});

describe('registration action: send-code', () => {
  it('rejects a malformed address before mailing anything', async () => {
    expect(await post({ intent: 'send-code', email: 'not-an-email' })).toEqual({
      error: 'Please enter a valid email address.',
    });
    expect(mocks.sendCode).not.toHaveBeenCalled();
  });

  it('rejects a missing/non-string email the same way', async () => {
    expect(await post({ intent: 'send-code' })).toEqual({
      error: 'Please enter a valid email address.',
    });
    expect(mocks.sendCode).not.toHaveBeenCalled();
  });

  it('tolerates incidental surrounding whitespace rather than false-rejecting it', async () => {
    expect(await post({ intent: 'send-code', email: '  student@school.edu  ' })).toEqual({
      codeSent: true,
    });
    // Sent exactly as typed (untrimmed) so the later consume-code lookup,
    // which re-reads the same raw form value, still matches it.
    expect(mocks.sendCode).toHaveBeenCalledWith('  student@school.edu  ');
  });

  it('sends a code for a well-formed address', async () => {
    expect(await post({ intent: 'send-code', email: 'student@school.edu' })).toEqual({
      codeSent: true,
    });
    expect(mocks.sendCode).toHaveBeenCalledWith('student@school.edu');
  });
});
