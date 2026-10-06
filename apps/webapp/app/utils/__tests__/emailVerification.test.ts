/**
 * sendEmailVerificationCode guards itself (#396): whatever a caller passes, an
 * address the mailer can never deliver to is refused before a verification
 * row is written or the email task is enqueued. It also throttles itself: one
 * send per address a minute, and a cap per user an hour, both kept in the
 * `verification` table (faked here in memory) so they hold across machines.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
  id: string;
  identifier: string;
  value: string;
  expires_at: Date;
  created_at: Date;
}

type Where = {
  identifier?: string;
  value?: string;
  expires_at?: { gt?: Date; lte?: Date };
};

const db = vi.hoisted(() => ({ rows: [] as Row[], seq: 0 }));
const mocks = vi.hoisted(() => ({ trigger: vi.fn() }));

const matches = (r: Row, w: Where = {}) =>
  (w.identifier === undefined || r.identifier === w.identifier) &&
  (w.value === undefined || r.value === w.value) &&
  (w.expires_at?.gt === undefined || r.expires_at > w.expires_at.gt) &&
  (w.expires_at?.lte === undefined || r.expires_at <= w.expires_at.lte);

vi.mock('@classmoji/database', () => ({
  default: () => ({
    verification: {
      findFirst: async ({ where }: { where: Where }) =>
        db.rows
          .filter(r => matches(r, where))
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0] ?? null,
      count: async ({ where }: { where: Where }) => db.rows.filter(r => matches(r, where)).length,
      deleteMany: async ({ where }: { where: Where }) => {
        const before = db.rows.length;
        db.rows = db.rows.filter(r => !matches(r, where));
        return { count: before - db.rows.length };
      },
      create: async ({ data }: { data: Omit<Row, 'id' | 'created_at'> }) => {
        const row = { ...data, id: String(++db.seq), created_at: new Date() };
        db.rows.push(row);
        return row;
      },
    },
  }),
}));
vi.mock('@classmoji/tasks', () => ({
  default: { sendEmailTask: { trigger: (...a: unknown[]) => mocks.trigger(...a) } },
}));

const {
  sendEmailVerificationCode,
  consumeEmailVerificationCode,
  CODE_RESEND_COOLDOWN_MS,
  CODE_SENDS_PER_USER,
  CODE_SENDS_PER_USER_WINDOW_MS,
  CODE_COOLDOWN_MESSAGE,
  CODE_USER_CAP_MESSAGE,
} = await import('../emailVerification.server');

const codeFor = (email: string) => db.rows.find(r => r.identifier === email)?.value;

beforeEach(() => {
  db.rows = [];
  mocks.trigger.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('sendEmailVerificationCode', () => {
  it.each(['1234567', 'jdoe', 'a@b@school.edu', 'Jane <jane@school.edu>', ''])(
    'refuses %j without writing a row or enqueueing a send',
    async email => {
      await expect(sendEmailVerificationCode(email, 'me')).rejects.toThrow(/invalid address/);
      expect(db.rows).toEqual([]);
      expect(mocks.trigger).not.toHaveBeenCalled();
    }
  );

  it('stores a code keyed by the address and mails it', async () => {
    expect(await sendEmailVerificationCode('student+cs52@mail.dartmouth.edu', 'me')).toEqual({
      sent: true,
    });
    const code = codeFor('student+cs52@mail.dartmouth.edu');
    expect(code).toMatch(/^\d{6}$/);
    expect(mocks.trigger).toHaveBeenCalledTimes(1);
    expect(mocks.trigger.mock.calls[0][0]).toEqual({
      to: 'student+cs52@mail.dartmouth.edu',
      template: { id: 'verify-email', variables: { CODE: code } },
    });
  });
});

describe('sendEmailVerificationCode: per-address cooldown', () => {
  it('refuses a second send inside the cooldown and keeps the first code', async () => {
    await sendEmailVerificationCode('a@school.edu', 'me');
    const first = codeFor('a@school.edu');
    vi.advanceTimersByTime(CODE_RESEND_COOLDOWN_MS - 1000);

    expect(await sendEmailVerificationCode('a@school.edu', 'me')).toEqual({
      sent: false,
      reason: 'cooldown',
      error: CODE_COOLDOWN_MESSAGE,
      codePending: true,
    });
    expect(mocks.trigger).toHaveBeenCalledTimes(1);
    expect(codeFor('a@school.edu')).toBe(first);
    expect(await consumeEmailVerificationCode('a@school.edu', first!)).toBe(true);
  });

  it('applies whoever asks, so accounts cannot take turns on one inbox', async () => {
    await sendEmailVerificationCode('a@school.edu', 'me');
    const res = await sendEmailVerificationCode('a@school.edu', 'someone-else');
    expect(res).toMatchObject({ sent: false, reason: 'cooldown' });
    expect(mocks.trigger).toHaveBeenCalledTimes(1);
  });

  it('allows a resend once the cooldown has passed, replacing the code', async () => {
    await sendEmailVerificationCode('a@school.edu', 'me');
    vi.advanceTimersByTime(CODE_RESEND_COOLDOWN_MS);

    expect(await sendEmailVerificationCode('a@school.edu', 'me')).toEqual({ sent: true });
    expect(mocks.trigger).toHaveBeenCalledTimes(2);
    expect(db.rows.filter(r => r.identifier === 'a@school.edu')).toHaveLength(1);
  });

  it('does not hold a cooldown on an address whose code was consumed', async () => {
    await sendEmailVerificationCode('a@school.edu', 'me');
    await consumeEmailVerificationCode('a@school.edu', codeFor('a@school.edu')!);
    expect(await sendEmailVerificationCode('a@school.edu', 'me')).toEqual({ sent: true });
  });
});

describe('sendEmailVerificationCode: per-user cap', () => {
  const sendMany = async (userId: string, n: number) => {
    for (let i = 0; i < n; i++) {
      expect(await sendEmailVerificationCode(`addr${i}-${userId}@school.edu`, userId)).toEqual({
        sent: true,
      });
    }
  };

  it(`refuses send ${CODE_SENDS_PER_USER + 1} within the window, across addresses`, async () => {
    await sendMany('me', CODE_SENDS_PER_USER);
    expect(await sendEmailVerificationCode('fresh@school.edu', 'me')).toEqual({
      sent: false,
      reason: 'user-cap',
      error: CODE_USER_CAP_MESSAGE,
      codePending: false,
    });
    expect(mocks.trigger).toHaveBeenCalledTimes(CODE_SENDS_PER_USER);
    expect(codeFor('fresh@school.edu')).toBeUndefined();
  });

  it('reports a pending code when the capped address already has a live one', async () => {
    await sendMany('me', CODE_SENDS_PER_USER);
    vi.advanceTimersByTime(CODE_RESEND_COOLDOWN_MS);
    const res = await sendEmailVerificationCode('addr0-me@school.edu', 'me');
    expect(res).toMatchObject({ sent: false, reason: 'user-cap', codePending: true });
  });

  it('frees up once the window has passed, and prunes the old markers', async () => {
    await sendMany('me', CODE_SENDS_PER_USER);
    vi.advanceTimersByTime(CODE_SENDS_PER_USER_WINDOW_MS);
    expect(await sendEmailVerificationCode('fresh@school.edu', 'me')).toEqual({ sent: true });
    expect(db.rows.filter(r => r.identifier === 'email-code-send:me')).toHaveLength(1);
  });

  it('counts each user separately', async () => {
    await sendMany('me', CODE_SENDS_PER_USER);
    expect(await sendEmailVerificationCode('fresh@school.edu', 'me')).toMatchObject({
      sent: false,
    });
    expect(await sendEmailVerificationCode('fresh@school.edu', 'someone-else')).toEqual({
      sent: true,
    });
  });

  it('does not count refused sends against the cap', async () => {
    await sendEmailVerificationCode('a@school.edu', 'me');
    for (let i = 0; i < 10; i++) await sendEmailVerificationCode('a@school.edu', 'me');
    await sendMany('me', CODE_SENDS_PER_USER - 1);
  });
});
