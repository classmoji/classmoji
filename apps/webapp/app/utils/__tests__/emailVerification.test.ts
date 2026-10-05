/**
 * sendEmailVerificationCode guards itself (#396): whatever a caller passes, an
 * address the mailer can never deliver to is refused before a verification
 * row is written or the email task is enqueued.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteMany: vi.fn(),
  create: vi.fn(),
  trigger: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    verification: {
      deleteMany: (...a: unknown[]) => mocks.deleteMany(...a),
      create: (...a: unknown[]) => mocks.create(...a),
    },
  }),
}));
vi.mock('@classmoji/tasks', () => ({
  default: { sendEmailTask: { trigger: (...a: unknown[]) => mocks.trigger(...a) } },
}));

const { sendEmailVerificationCode } = await import('../emailVerification.server');

beforeEach(() => {
  Object.values(mocks).forEach(m => m.mockReset());
});

describe('sendEmailVerificationCode', () => {
  it.each(['1234567', 'jdoe', 'a@b@school.edu', 'Jane <jane@school.edu>', ''])(
    'refuses %j without writing a row or enqueueing a send',
    async email => {
      await expect(sendEmailVerificationCode(email)).rejects.toThrow(/invalid address/);
      expect(mocks.deleteMany).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.trigger).not.toHaveBeenCalled();
    }
  );

  it('stores a code keyed by the address and mails it', async () => {
    await sendEmailVerificationCode('student+cs52@mail.dartmouth.edu');
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { identifier: 'student+cs52@mail.dartmouth.edu' },
    });
    expect(mocks.create.mock.calls[0][0].data.identifier).toBe('student+cs52@mail.dartmouth.edu');
    expect(mocks.trigger).toHaveBeenCalledTimes(1);
    expect(mocks.trigger.mock.calls[0][0].to).toBe('student+cs52@mail.dartmouth.edu');
  });
});
