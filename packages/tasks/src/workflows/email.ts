import { logger, task } from '@trigger.dev/sdk';
import { Resend } from 'resend';

export interface SendEmailTaskPayload {
  to: string;
  subject: string;
  html: string;
}

/**
 * Send via a template hosted in Resend instead of inline HTML. `id` is the
 * template alias (e.g. 'verify-email'), which is stable across edits — unlike
 * the generated tmpl_ id, it needs no config entry.
 *
 * `subject` is optional because the template carries its own; pass it only to
 * override per-send.
 */
export interface SendEmailTaskTemplatePayload {
  to: string;
  template: {
    id: string;
    variables?: Record<string, string | number>;
  };
  subject?: string;
}

type SendEmailTaskBody = SendEmailTaskPayload | SendEmailTaskTemplatePayload;

interface SendEmailTaskWrappedPayload {
  payload: SendEmailTaskBody;
}

type SendEmailTaskInput = SendEmailTaskBody | SendEmailTaskWrappedPayload;

const isTemplatePayload = (
  payload: SendEmailTaskBody
): payload is SendEmailTaskTemplatePayload => 'template' in payload;

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
const extractPayload = (input: SendEmailTaskInput): SendEmailTaskBody => {
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

    const payload = extractPayload(input);
    const resend = new Resend(apiKey);

    const common = {
      from: process.env.EMAIL_FROM || DEFAULT_FROM,
      to: payload.to,
      ...(process.env.EMAIL_REPLY_TO ? { replyTo: process.env.EMAIL_REPLY_TO } : {}),
    };

    // `template` is mutually exclusive with `html` in the Resend API, so the two
    // branches must not merge their arguments.
    const body = isTemplatePayload(payload)
      ? {
          ...common,
          template: payload.template,
          ...(payload.subject ? { subject: payload.subject } : {}),
        }
      : { ...common, subject: payload.subject, html: payload.html };

    // The Resend SDK does NOT throw on API errors — it resolves with
    // `{ data, error }`. Returning without inspecting `error` would mark every
    // failed send as a successful run.
    const { data, error } = await resend.emails.send(body, {
      idempotencyKey: `send-email/${ctx.run.id}`,
    });

    const logCtx = {
      to: payload.to,
      ...(isTemplatePayload(payload)
        ? { template: payload.template.id }
        : { subject: payload.subject }),
    };

    if (error) {
      logger.error('Resend send failed', { ...logCtx, error });
      throw new Error(`Resend send failed: ${error.message}`);
    }

    logger.info('Email sent', { ...logCtx, emailId: data?.id });

    return data;
  },
});
