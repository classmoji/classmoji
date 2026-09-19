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
  batchSend: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  warn: vi.fn(),
}));

// `task()` normally returns a wrapped trigger handle; return the config itself
// so the test can invoke `run` directly.
vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), error: vi.fn(), warn: (...a: unknown[]) => mocks.warn(...a) },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: (...a: unknown[]) => mocks.send(...a) };
    batch = { send: (...a: unknown[]) => mocks.batchSend(...a) };
  },
}));

/**
 * Prisma, for the two write-backs onto `form_magic_tokens`.
 *
 * Mocked rather than run against a database because what is worth pinning here
 * is the SHAPE of the write — which row, guarded by what — not that Postgres
 * can store a string. The reuse rule that consumes this column is proved
 * end-to-end against real Postgres in the services integration suite.
 */
vi.mock('@classmoji/database', () => ({
  default: () => ({
    formMagicToken: {
      updateMany: (...a: unknown[]) => mocks.updateMany(...a),
      update: (...a: unknown[]) => mocks.update(...a),
    },
  }),
}));

const { sendEmailTask, sendBatchEmailTask } = await import('../email.ts');

const CTX = { ctx: { run: { id: 'run_abc123' } } };
const PAYLOAD = { to: 'student@school.edu', subject: 'Hi', html: '<p>Hi</p>' };

const run = (input: unknown) =>
  (sendEmailTask as unknown as { run: (i: unknown, c: unknown) => Promise<unknown> }).run(
    input,
    CTX
  );

/** Invoke the task's final-failure hook exactly as Trigger.dev would. */
const fail = (input: unknown, error: unknown) =>
  (
    sendEmailTask as unknown as {
      onFailure: (a: { payload: unknown; error: unknown }) => Promise<void>;
    }
  ).onFailure({ payload: input, error });

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

/**
 * ── The send that never happened ────────────────────────────────────────────
 *
 * A verification mail is dispatched fire-and-forget, so the page that asked for
 * it has already answered the browser by the time Resend refuses. Nothing on
 * the request path can learn that the send failed — which meant a failed send
 * left a token looking pristine, and the reuse rule then concluded "a live link
 * already covers this address" and sent nothing, forever.
 *
 * `onFailure` is the hook that closes it, and the hook matters: it fires ONCE,
 * after the retries are exhausted. Recording the failure inline in `run` would
 * mark a token dead while attempt two was about to deliver it.
 */
describe('sendEmailTask.onFailure', () => {
  const TOKEN = 'tok_9f3c';

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it('marks the token FAILED with the reason, so reuse cannot hand it back', async () => {
    await fail(
      { ...PAYLOAD, formMagicTokenId: TOKEN },
      new Error('Resend send failed: Template not found')
    );

    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    const [args] = mocks.updateMany.mock.calls[0];
    expect(args.where.id).toBe(TOKEN);
    expect(args.data.delivery_state).toBe('FAILED');
    expect(args.data.delivery_detail).toContain('Template not found');
  });

  it('refuses to claim FAILED for a message Resend already accepted', async () => {
    // The interlock. A token carrying a provider id was accepted, so the mail
    // is out in the world whatever became of the run afterwards — telling the
    // person it is not coming would be false, and would spend a fresh link
    // mailing them a duplicate.
    await fail({ ...PAYLOAD, formMagicTokenId: TOKEN }, new Error('boom'));

    expect(mocks.updateMany.mock.calls[0][0].where.provider_message_id).toBeNull();
  });

  it('finds the token id through the wrapped { payload } shape too', async () => {
    // `batchTrigger` call sites pass the batch-item shape. Reading `payload`
    // directly here would silently never find `formMagicTokenId` and the whole
    // fix would be a no-op for those.
    await fail({ payload: { ...PAYLOAD, formMagicTokenId: TOKEN } }, new Error('boom'));

    expect(mocks.updateMany.mock.calls[0][0].where.id).toBe(TOKEN);
  });

  it('writes nothing for a send that carries no token', async () => {
    // Most mail in this system is not a form link. A failure there has no row
    // to write to and must not invent one.
    await fail(PAYLOAD, new Error('boom'));

    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('truncates the reason, which renders in the staff drawer', async () => {
    await fail({ ...PAYLOAD, formMagicTokenId: TOKEN }, new Error('x'.repeat(5_000)));

    expect(mocks.updateMany.mock.calls[0][0].data.delivery_detail.length).toBeLessThanOrEqual(200);
  });

  it('records something even when the error is not an Error', async () => {
    await fail({ ...PAYLOAD, formMagicTokenId: TOKEN }, undefined);

    expect(mocks.updateMany.mock.calls[0][0].data.delivery_detail).toBeTruthy();
  });

  it('swallows a database fault rather than masking the original failure', async () => {
    // The run has already failed for a real reason. A bookkeeping error thrown
    // out of here would replace that reason in the dashboard with a Prisma
    // complaint, and there is nothing left to retry into.
    mocks.updateMany.mockRejectedValue(new Error('connection reset'));

    await expect(
      fail({ ...PAYLOAD, formMagicTokenId: TOKEN }, new Error('boom'))
    ).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalled();
  });

  it('is registered as a hook, not called from run — so retries are not pre-empted', async () => {
    // A failing attempt must leave the token untouched: four more attempts may
    // yet deliver it, and a token marked FAILED in between would mint a second
    // link for a message that is still going out.
    mocks.send.mockResolvedValue({ data: null, error: { message: 'rate limited' } });

    await expect(run({ ...PAYLOAD, formMagicTokenId: TOKEN })).rejects.toThrow('rate limited');
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

describe('sendBatchEmailTask', () => {
  const runBatch = (input: unknown) =>
    (sendBatchEmailTask as unknown as { run: (i: unknown, c: unknown) => Promise<unknown> }).run(
      input,
      CTX
    );

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = 're_test_key';
    delete process.env.EMAIL_FROM;
    delete process.env.EMAIL_REPLY_TO;
  });

  it('collapses many recipients into a single request', async () => {
    mocks.batchSend.mockResolvedValue({ data: [{ id: 'a' }, { id: 'b' }], error: null });

    await runBatch({
      emails: [
        { to: 'a@x.edu', template: { id: 'roster-added' } },
        { to: 'b@x.edu', template: { id: 'roster-added' } },
      ],
    });

    expect(mocks.batchSend).toHaveBeenCalledTimes(1);
    expect(mocks.batchSend.mock.calls[0][0]).toHaveLength(2);
    // Single-send endpoint must not be touched — that was the whole point.
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('chunks at 100, since Resend rejects larger batches', async () => {
    mocks.batchSend.mockResolvedValue({ data: [], error: null });

    const emails = Array.from({ length: 250 }, (_, i) => ({
      to: `s${i}@x.edu`,
      template: { id: 'notification' },
    }));
    await runBatch({ emails });

    expect(mocks.batchSend).toHaveBeenCalledTimes(3);
    expect(mocks.batchSend.mock.calls[0][0]).toHaveLength(100);
    expect(mocks.batchSend.mock.calls[2][0]).toHaveLength(50);
  });

  it('gives each chunk its own idempotency key', async () => {
    // One key across chunks would 409, since the payloads differ.
    mocks.batchSend.mockResolvedValue({ data: [], error: null });

    await runBatch({
      emails: Array.from({ length: 150 }, (_, i) => ({ to: `s${i}@x.edu`, html: 'h', subject: 's' })),
    });

    const keys = mocks.batchSend.mock.calls.map(c => c[1].idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('throws when a batch errors rather than reporting success', async () => {
    mocks.batchSend.mockResolvedValue({ data: null, error: { message: 'rate_limit_exceeded' } });

    await expect(
      runBatch({ emails: [{ to: 'a@x.edu', template: { id: 'roster-added' } }] })
    ).rejects.toThrow('rate_limit_exceeded');
  });

  it('is a no-op on an empty list', async () => {
    await expect(runBatch({ emails: [] })).resolves.toEqual([]);
    expect(mocks.batchSend).not.toHaveBeenCalled();
  });

  it('unwraps the wrapped payload form', async () => {
    mocks.batchSend.mockResolvedValue({ data: [], error: null });

    await runBatch({ payload: { emails: [{ to: 'a@x.edu', html: 'h', subject: 's' }] } });

    expect(mocks.batchSend).toHaveBeenCalledTimes(1);
  });
});
