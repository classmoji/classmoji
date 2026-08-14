/**
 * Unit tests for the send_email task's Resend transport.
 *
 * Focus: the Resend SDK does NOT throw on API errors, it resolves with
 * `{ data, error }`. If the task ignores `error`, every failed send is recorded
 * as a successful run — and extension.ts awaits this task via triggerAndWait,
 * so a false success propagates. These tests pin that behavior, plus the
 * bare/wrapped payload shim that seven inconsistent call sites depend on.
 * `resend` and `@trigger.dev/sdk` are mocked — no real emails.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
}));

// `task()` normally returns a wrapped trigger handle; return the config itself
// so the test can invoke `run` directly.
vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: (...a: unknown[]) => mocks.send(...a) };
  },
}));

const { sendEmailTask } = await import('../email.ts');

const CTX = { ctx: { run: { id: 'run_abc123' } } };
const PAYLOAD = { to: 'student@school.edu', subject: 'Hi', html: '<p>Hi</p>' };

const run = (input: unknown) =>
  (sendEmailTask as unknown as { run: (i: unknown, c: unknown) => Promise<unknown> }).run(
    input,
    CTX
  );

describe('sendEmailTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = 're_test_key';
    delete process.env.EMAIL_FROM;
    delete process.env.EMAIL_REPLY_TO;
  });

  it('sends via Resend and returns the email id', async () => {
    mocks.send.mockResolvedValue({ data: { id: 'email-1' }, error: null });

    await expect(run(PAYLOAD)).resolves.toEqual({ id: 'email-1' });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('throws when Resend returns an error instead of resolving successfully', async () => {
    mocks.send.mockResolvedValue({ data: null, error: { message: 'domain not verified' } });

    await expect(run(PAYLOAD)).rejects.toThrow('domain not verified');
  });

  it('unwraps the batchTrigger { payload } shape', async () => {
    mocks.send.mockResolvedValue({ data: { id: 'email-2' }, error: null });

    await run({ payload: PAYLOAD });

    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      to: PAYLOAD.to,
      subject: PAYLOAD.subject,
      html: PAYLOAD.html,
    });
  });

  it('defaults the sender and omits replyTo when unset', async () => {
    mocks.send.mockResolvedValue({ data: { id: 'email-3' }, error: null });

    await run(PAYLOAD);

    const [body] = mocks.send.mock.calls[0];
    expect(body.from).toBe('Classmoji <hello@classmoji.io>');
    expect(body).not.toHaveProperty('replyTo');
  });

  it('honors EMAIL_FROM and EMAIL_REPLY_TO overrides', async () => {
    process.env.EMAIL_FROM = 'Classmoji <noreply@classmoji.io>';
    process.env.EMAIL_REPLY_TO = 'support@classmoji.io';
    mocks.send.mockResolvedValue({ data: { id: 'email-4' }, error: null });

    await run(PAYLOAD);

    const [body] = mocks.send.mock.calls[0];
    expect(body.from).toBe('Classmoji <noreply@classmoji.io>');
    expect(body.replyTo).toBe('support@classmoji.io');
  });

  it('passes a run-scoped idempotency key so replays do not double-send', async () => {
    mocks.send.mockResolvedValue({ data: { id: 'email-5' }, error: null });

    await run(PAYLOAD);

    expect(mocks.send.mock.calls[0][1]).toEqual({ idempotencyKey: 'send-email/run_abc123' });
  });

  it('throws a named error when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY;

    await expect(run(PAYLOAD)).rejects.toThrow('RESEND_API_KEY');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('sends via a hosted template and never alongside html', async () => {
    mocks.send.mockResolvedValue({ data: { id: 'email-6' }, error: null });

    await run({ to: 'student@school.edu', template: { id: 'verify-email', variables: { CODE: '123456' } } });

    const [body] = mocks.send.mock.calls[0];
    expect(body.template).toEqual({ id: 'verify-email', variables: { CODE: '123456' } });
    // Mutually exclusive in the Resend API — sending both is a 422.
    expect(body).not.toHaveProperty('html');
    expect(body).not.toHaveProperty('subject');
  });

  it('lets a template send override the template subject when asked', async () => {
    mocks.send.mockResolvedValue({ data: { id: 'email-7' }, error: null });

    await run({ to: 'student@school.edu', subject: 'Override', template: { id: 'verify-email' } });

    expect(mocks.send.mock.calls[0][0].subject).toBe('Override');
  });

  it('unwraps a batchTrigger-wrapped template payload', async () => {
    mocks.send.mockResolvedValue({ data: { id: 'email-8' }, error: null });

    await run({ payload: { to: 'student@school.edu', template: { id: 'verify-email' } } });

    expect(mocks.send.mock.calls[0][0].template).toEqual({ id: 'verify-email' });
  });

  it('throws when a template send errors, same as the html path', async () => {
    mocks.send.mockResolvedValue({ data: null, error: { message: 'template not found' } });

    await expect(
      run({ to: 'student@school.edu', template: { id: 'nope' } })
    ).rejects.toThrow('template not found');
  });

  it('still sends html without a template field when given html', async () => {
    mocks.send.mockResolvedValue({ data: { id: 'email-9' }, error: null });

    await run(PAYLOAD);

    expect(mocks.send.mock.calls[0][0]).not.toHaveProperty('template');
  });

  it('retries enough times to survive Resend rate limiting', async () => {
    // trigger.config.js defaults to maxAttempts: 1, which would silently drop
    // 429s during a roster import. The per-task override is the guard.
    const { retry } = sendEmailTask as unknown as { retry: { maxAttempts: number } };
    expect(retry.maxAttempts).toBeGreaterThan(1);
  });
});
