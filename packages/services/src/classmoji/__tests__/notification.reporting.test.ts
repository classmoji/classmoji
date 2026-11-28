/**
 * Notification failures are swallowed (a notification never breaks the action
 * it follows), so they are reported: `runSafely` as `notify.run`, the row
 * write as `notify.create`, the email enqueue as `notify.email_enqueue`. Each
 * once, with the same return value as before, and nothing without a reporter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setErrorReporter,
  type ErrorReporter,
  type ReportContext,
} from '@classmoji/utils/error-report';

const notificationCreateMany = vi.fn();
const userFindMany = vi.fn();
const classroomFindUnique = vi.fn();
const trigger = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    notification: { createMany: notificationCreateMany },
    user: { findMany: userFindMany },
    classroom: { findUnique: classroomFindUnique },
  }),
}));
vi.mock('@classmoji/database/client', () => ({ Prisma: { JsonNull: Symbol('JsonNull') } }));
vi.mock('@trigger.dev/sdk', () => ({ tasks: { trigger: (...a: unknown[]) => trigger(...a) } }));
vi.mock('../notificationEmails.ts', () => ({ renderEmail: () => ({ template: 'tpl' }) }));
vi.mock('../entitlement.service.ts', () => ({ quizzesVisible: vi.fn() }));

const notification = await import('../notification.service.ts');

let captured: Array<{ error: unknown; context: ReportContext }>;
const reporter: ErrorReporter = {
  capture: (error, context) => captured.push({ error, context }),
  flush: async () => true,
};

const input = {
  type: 'QUIZ_PUBLISHED' as const,
  classroomId: 'class-1',
  recipientUserIds: ['user-1', 'user-2'],
  resourceType: 'QUIZ',
  resourceId: 'quiz-1',
  title: 'Week 3 notes',
};

/** Let the fire-and-forget email enqueue run to its end. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  captured = [];
  setErrorReporter(reporter);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  notificationCreateMany.mockResolvedValue({ count: 2 });
  classroomFindUnique.mockResolvedValue({ name: 'Class', slug: 'class' });
  userFindMany.mockResolvedValue([
    { id: 'user-1', email: 'a@example.com', name: 'A', notification_preference: null },
  ]);
  trigger.mockResolvedValue({ id: 'run-1' });
});

afterEach(() => {
  setErrorReporter(null);
  vi.restoreAllMocks();
});

describe('runSafely', () => {
  it('reports a failure once as notify.run and still returns null', async () => {
    const failure = new Error('boom');
    const result = await notification.runSafely('page publish notification', async () => {
      throw failure;
    });

    expect(result).toBeNull();
    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBe(failure);
    expect(captured[0].context).toEqual({
      surface: 'notify.run',
      tags: { label: 'page publish notification' },
    });
  });

  it('returns the value and reports nothing when the work succeeds', async () => {
    expect(await notification.runSafely('x', async () => 42)).toBe(42);
    expect(captured).toHaveLength(0);
  });

  it('returns null and reports nothing without a reporter', async () => {
    setErrorReporter(null);
    const result = await notification.runSafely('x', async () => {
      throw new Error('boom');
    });
    expect(result).toBeNull();
    expect(captured).toHaveLength(0);
  });

  it('reports nothing more when the work swallowed and reported its own failure', async () => {
    notificationCreateMany.mockRejectedValueOnce(new Error('db down'));
    // createNotifications swallows its own failure, so runSafely sees none.
    const result = await notification.runSafely('x', () => notification.createNotifications(input));
    expect(result).toEqual({ count: 0 });
    expect(captured.map(c => c.context.surface)).toEqual(['notify.create']);
  });
});

describe('createNotifications', () => {
  it('reports a failed row write as notify.create and returns count 0', async () => {
    const failure = new Error('db down');
    notificationCreateMany.mockRejectedValueOnce(failure);

    expect(await notification.createNotifications(input)).toEqual({ count: 0 });
    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBe(failure);
    expect(captured[0].context).toEqual({
      surface: 'notify.create',
      tags: { type: 'QUIZ_PUBLISHED' },
      extra: { recipients: 2 },
    });
    // Nothing about the notification's text or its recipients' addresses.
    expect(JSON.stringify(captured[0].context)).not.toContain('Week 3');
  });

  it('reports a failed email enqueue as notify.email_enqueue, and still counts the rows', async () => {
    const failure = new Error('trigger unavailable');
    trigger.mockRejectedValueOnce(failure);

    expect(await notification.createNotifications(input)).toEqual({ count: 2 });
    await settle();

    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBe(failure);
    expect(captured[0].context).toEqual({
      surface: 'notify.email_enqueue',
      tags: { type: 'QUIZ_PUBLISHED' },
      extra: { emails: 1 },
    });
    expect(JSON.stringify(captured[0].context)).not.toContain('example.com');
  });

  it('reports a failed recipient lookup as notify.email_prepare', async () => {
    userFindMany.mockRejectedValueOnce(new Error('db down'));

    expect(await notification.createNotifications(input)).toEqual({ count: 2 });
    await settle();

    expect(captured.map(c => c.context.surface)).toEqual(['notify.email_prepare']);
  });

  it('reports nothing when everything succeeds', async () => {
    expect(await notification.createNotifications(input)).toEqual({ count: 2 });
    await settle();
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(0);
  });
});
