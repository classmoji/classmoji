import { logger, task } from '@trigger.dev/sdk';
import { Resend } from 'resend';
import getPrisma from '@classmoji/database';

/**
 * Correlate this send back to the thing that asked for it.
 *
 * ── Why the id has to travel with the payload ──────────────────────────────
 * The provider's message id exists only INSIDE this run. Mail is dispatched
 * fire-and-forget (`sendEmailTask.trigger(...)`), so the route that asked for it
 * has already answered the browser by the time Resend replies. The only place
 * that can write the id down is here, and the only way this task can know WHICH
 * row to write it onto is if the caller says so.
 *
 * Optional everywhere, and read by nothing else. A send without it behaves
 * exactly as every send did before this field existed — which is what lets the
 * correlation ship ahead of the webhook that eventually consumes it.
 */
interface SendEmailCorrelation {
  /**
   * The `form_magic_tokens` row this message carries the link for.
   *
   * One token is one send, so the mapping is exact. Named for the table rather
   * than something generic because it IS specific: another caller wanting
   * correlation should add its own field and its own write-back rather than
   * overloading this one into meaning "some row somewhere".
   */
  formMagicTokenId?: string;
}

export interface SendEmailTaskPayload extends SendEmailCorrelation {
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
export interface SendEmailTaskTemplatePayload extends SendEmailCorrelation {
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

const isTemplatePayload = (payload: SendEmailTaskBody): payload is SendEmailTaskTemplatePayload =>
  'template' in payload;

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

/**
 * Build the Resend request body. `template` is mutually exclusive with `html`,
 * so the two branches must never merge their arguments.
 */
const buildBody = (payload: SendEmailTaskBody) => {
  const common = {
    from: process.env.EMAIL_FROM || DEFAULT_FROM,
    to: payload.to,
    ...(process.env.EMAIL_REPLY_TO ? { replyTo: process.env.EMAIL_REPLY_TO } : {}),
  };

  return isTemplatePayload(payload)
    ? {
        ...common,
        template: payload.template,
        ...(payload.subject ? { subject: payload.subject } : {}),
      }
    : { ...common, subject: payload.subject, html: payload.html };
};

/** Log context that never includes the message body. */
const describe = (payload: SendEmailTaskBody) => ({
  to: payload.to,
  ...(isTemplatePayload(payload)
    ? { template: payload.template.id }
    : { subject: payload.subject }),
});

export const sendEmailTask = task({
  id: 'send_email',
  /**
   * Resend allows 10 requests/second per team, shared across every API key, so
   * concurrent fan-out can still hit 429. The global default in
   * trigger.config.js is `maxAttempts: 1`, so without this override a 429
   * silently drops an email — silently because notification.service.ts
   * deliberately swallows enqueue failures.
   *
   * Prefer sendBatchEmailTask for any fan-out; this task is for single sends.
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

    // The Resend SDK does NOT throw on API errors — it resolves with
    // `{ data, error }`. Returning without inspecting `error` would mark every
    // failed send as a successful run.
    const { data, error } = await resend.emails.send(buildBody(payload), {
      idempotencyKey: `send-email/${ctx.run.id}`,
    });

    const logCtx = describe(payload);

    if (error) {
      logger.error('Resend send failed', { ...logCtx, error });
      throw new Error(`Resend send failed: ${error.message}`);
    }

    logger.info('Email sent', { ...logCtx, emailId: data?.id });

    await recordProviderMessageId(payload, data?.id);

    return data;
  },
});

/**
 * Write the provider's message id onto the row that asked for the send.
 *
 * ── Why every failure here is swallowed ────────────────────────────────────
 * THE MAIL HAS ALREADY GONE OUT by the time this runs. Throwing would fail a
 * run whose side effect already happened, and this task retries five times — so
 * a database blip would not "fix" the correlation, it would send the person up
 * to five copies of the same verification link. Losing the id costs a bounce we
 * cannot attribute; throwing costs the recipient their inbox. The trade is not
 * close.
 *
 * A RETRY IS SAFE FOR THE OPPOSITE REASON. The send carries an idempotency key
 * derived from the run id, so a retried attempt gets the SAME message id back
 * from Resend and this write is byte-for-byte the one that already happened.
 *
 * `delivery_state` starts at 'SENT' — meaning "the provider accepted it", which
 * is genuinely all that is known at this point. Delivery, bouncing and delay are
 * later facts, and only the webhook can report them.
 */
async function recordProviderMessageId(
  payload: SendEmailTaskBody,
  messageId: string | undefined
): Promise<void> {
  if (!payload.formMagicTokenId || !messageId) return;

  try {
    await getPrisma().formMagicToken.update({
      where: { id: payload.formMagicTokenId },
      data: { provider_message_id: messageId, delivery_state: 'SENT' },
    });
  } catch (error) {
    // A token can legitimately be gone: the response it belonged to may have
    // been deleted between the dispatch and the send. Warn, never throw.
    logger.warn('Could not record provider message id', {
      formMagicTokenId: payload.formMagicTokenId,
      error: (error as Error).message,
    });
  }
}

/** Resend caps a batch at 100 messages per request. */
const RESEND_BATCH_LIMIT = 100;

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export interface SendBatchEmailTaskPayload {
  emails: SendEmailTaskBody[];
}

type SendBatchEmailTaskInput = SendBatchEmailTaskPayload | { payload: SendBatchEmailTaskPayload };

/**
 * Send many messages in as few API requests as possible.
 *
 * Resend allows 10 requests/second per team, shared across every API key, so
 * fanning out one request per recipient burns the whole budget on a roster
 * import and starves anything else running. The batch endpoint collapses up to
 * 100 messages into a single request: a 250-student import goes from 250
 * requests to 3.
 *
 * Batch supports `template`, so every email type can use this path. It does not
 * support attachments, which nothing here sends.
 */
export const sendBatchEmailTask = task({
  id: 'send_batch_email',
  retry: {
    maxAttempts: 5,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 30000,
    factor: 2,
    randomize: true,
  },
  run: async (input: SendBatchEmailTaskInput, { ctx }: SendEmailTaskContext) => {
    if (typeof window !== 'undefined') {
      throw new Error('sendBatchEmailTask must run on the server');
    }

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error('RESEND_API_KEY env var not set in Trigger.dev environment');
    }

    const { emails } = 'payload' in input ? input.payload : input;
    if (!emails?.length) {
      logger.info('No emails to send, skipping batch');
      return [];
    }

    const resend = new Resend(apiKey);
    const sent: unknown[] = [];
    const batches = chunk(emails, RESEND_BATCH_LIMIT);

    for (const [index, batch] of batches.entries()) {
      const { data, error } = await resend.batch.send(batch.map(buildBody), {
        // Scoped per chunk: a retry of the same run must reuse the same key, but
        // two chunks in one run are different payloads and would 409 if they
        // shared one.
        idempotencyKey: `send-batch-email/${ctx.run.id}/${index}`,
      });

      if (error) {
        logger.error('Resend batch send failed', {
          batch: index,
          size: batch.length,
          error,
        });
        throw new Error(`Resend batch send failed: ${error.message}`);
      }

      logger.info('Batch sent', { batch: index, size: batch.length });
      sent.push(data);
    }

    return sent;
  },
});
