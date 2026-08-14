import { logger, task } from '@trigger.dev/sdk';
import { Resend } from 'resend';

export interface SendEmailTaskPayload {
  to: string;
  subject: string;
  html: string;
}

interface SendEmailTaskWrappedPayload {
  payload: SendEmailTaskPayload;
}

type SendEmailTaskInput = SendEmailTaskPayload | SendEmailTaskWrappedPayload;

interface SendEmailTaskContext {
  ctx: {
    run: {
      id: string;
    };
  };
}

/**
 * Callers are inconsistent: `batchTrigger` sites pass the wrapped
 * `{ payload: {...} }` batch-item shape, while `trigger` / `triggerAndWait`
 * sites pass the bare object. Normalize both rather than touching seven call
 * sites — one of which (notification.service.ts) triggers by string id and so
 * gets no type checking at all.
 */
const extractPayload = (input: SendEmailTaskInput): SendEmailTaskPayload => {
  return 'payload' in input ? input.payload : input;
};

const DEFAULT_FROM = 'Classmoji <hello@classmoji.io>';

export const sendEmailTask = task({
  id: 'send_email',
  /**
   * Resend's default rate limit is 2 requests/second, and three call sites use
   * `batchTrigger` (one run per recipient). A roster import will burst well past
   * that. The global default in trigger.config.js is `maxAttempts: 1`, so without
   * this override a 429 silently drops an invitation email — silently because
   * notification.service.ts deliberately swallows enqueue failures.
   */
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 30000,
    factor: 2,
    randomize: true,
  },
  run: async (input: SendEmailTaskInput, { ctx }: SendEmailTaskContext) => {
    if (typeof window !== 'undefined') {
      throw new Error('sendEmailTask must run on the server');
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error('RESEND_API_KEY env var not set in Trigger.dev environment');
    }

    const { to, subject, html } = extractPayload(input);
    const resend = new Resend(apiKey);

    // The Resend SDK does NOT throw on API errors — it resolves with
    // `{ data, error }`. Returning without inspecting `error` would mark every
    // failed send as a successful run.
    const { data, error } = await resend.emails.send(
      {
        from: process.env.EMAIL_FROM || DEFAULT_FROM,
        to,
        subject,
        html,
        ...(process.env.EMAIL_REPLY_TO ? { replyTo: process.env.EMAIL_REPLY_TO } : {}),
      },
      { idempotencyKey: `send-email/${ctx.run.id}` }
    );

    if (error) {
      logger.error('Resend send failed', { to, subject, error });
      throw new Error(`Resend send failed: ${error.message}`);
    }

    logger.info('Email sent', { to, subject, emailId: data?.id });

    return data;
  },
});
