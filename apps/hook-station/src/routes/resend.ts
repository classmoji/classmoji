import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPrisma } from '@classmoji/database';

/**
 * Resend delivery webhooks — the only place this system learns that a
 * verification email did not arrive.
 *
 * ── Why it matters here more than for most mail ────────────────────────────
 * A public form response is authenticated by a magic link and nothing else. If
 * the link does not reach the mailbox, the response sits at
 * PENDING_VERIFICATION forever and looks, to staff, exactly like somebody who
 * changed their mind. A bounce is the difference between "they never finished"
 * and "we could never reach them", and only the provider knows which.
 *
 * ── Verify BEFORE anything ─────────────────────────────────────────────────
 * Same discipline as `github.ts`: the signature is checked in a `preHandler`,
 * against the RAW body, before the payload is parsed or a query is run. An
 * unverified delivery is refused on a header at no cost and never becomes work
 * that a stranger can make this process do.
 *
 * ── DEGRADING BEFORE IT IS CONFIGURED ──────────────────────────────────────
 * `github.ts` throws at MODULE LOAD when its secret is missing. That is exactly
 * wrong for a route being added ahead of its configuration: hook-station would
 * fail to boot on the next deploy — taking the GitHub and Stripe webhooks down
 * with it — because a Resend secret nobody has set yet was absent.
 *
 * So the secret is read INSIDE the handler, and an unconfigured deployment
 * answers 503 and logs once. Nothing else in the app changes: sends keep
 * working, the fill page keeps polling and keeps being told `pending`, and the
 * staff row simply shows no delivery information. The feature switches itself
 * on when Tim adds the secret, with no code change and no redeploy of anything
 * else.
 */

const SIGNATURE_HEADER = 'svix-signature';
const ID_HEADER = 'svix-id';
const TIMESTAMP_HEADER = 'svix-timestamp';

/**
 * How far out of step a delivery's timestamp may be.
 *
 * Five minutes each way, which is Svix's own default. This is the replay bound:
 * a captured delivery re-sent later fails on the clock even though its
 * signature is still perfectly valid, because the timestamp is part of the
 * signed content and therefore cannot be adjusted without breaking it.
 */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export interface VerificationInput {
  rawBody: string;
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  secret: string;
  nowSeconds?: number;
}

/**
 * Is this delivery genuinely from Resend, and recent?
 *
 * Exported so the signature seam can be tested against real HMACs rather than
 * through a mocked route — the same reason `stripe.signature.test.ts` exists.
 *
 * The scheme (Svix, which is what Resend signs with):
 *   signed content = `${svix-id}.${svix-timestamp}.${raw body}`
 *   key            = base64-decode(secret after the `whsec_` prefix)
 *   signature      = base64(HMAC-SHA256(key, signed content))
 * and `svix-signature` carries space-delimited `v1,<sig>` entries, of which ANY
 * may match — that is how the provider rotates secrets without dropping
 * deliveries.
 */
export function verifyResendSignature({
  rawBody,
  id,
  timestamp,
  signature,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
}: VerificationInput): boolean {
  if (!id || !timestamp || !signature || !secret) return false;

  /**
   * The clock, checked FIRST and on its own.
   *
   * The timestamp is inside the signed content, so a replayed delivery carries
   * a genuine signature over a stale time — the maths cannot catch it and only
   * this comparison can.
   */
  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return false;
  if (Math.abs(nowSeconds - sent) > TIMESTAMP_TOLERANCE_SECONDS) return false;

  // `whsec_` is a human-facing prefix, not part of the key material.
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  if (key.length === 0) return false;

  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();

  /**
   * Any offered version may match, and each is compared in CONSTANT TIME.
   *
   * `timingSafeEqual` throws on a length mismatch, so the lengths are checked
   * first — a difference in length is not secret (it is a property of the
   * encoding, identical for every valid signature) and leaking it reveals
   * nothing about the key.
   */
  let matched = false;
  for (const entry of signature.split(' ')) {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) continue;

    const offered = Buffer.from(value, 'base64');
    if (offered.length !== expected.length) continue;
    // NOT short-circuited: comparing every candidate keeps the work done
    // independent of which one matches.
    if (timingSafeEqual(offered, expected)) matched = true;
  }

  return matched;
}

/** The delivery states this route is prepared to write. */
type DeliveryState = 'DELIVERED' | 'BOUNCED' | 'DELAYED' | 'COMPLAINED';

interface ResendEvent {
  type?: string;
  data?: {
    email_id?: string;
    bounce?: { type?: string; subType?: string; message?: string };
  };
}

/**
 * What one event means for the token it names, or null to ignore it.
 *
 * Unknown types return null and are answered 200. A provider adds event types
 * whenever it likes, and a webhook that 4xx'd on an unfamiliar one would look
 * broken to Resend and eventually be disabled — taking the events we DO care
 * about with it.
 */
function interpret(event: ResendEvent): { state: DeliveryState; detail: string | null } | null {
  switch (event.type) {
    case 'email.bounced': {
      const bounce = event.data?.bounce;
      /**
       * Hard and soft are both recorded, and the distinction is kept in the
       * detail rather than collapsed. Resend reports it as `type`:
       * "Permanent" is a hard bounce (the address is wrong or gone — the case
       * this feature exists for), "Transient" is a full mailbox or a server
       * having a bad day. Staff need to tell them apart; the person on the form
       * only needs to know it did not arrive.
       */
      const kind = bounce?.type
        ? `${bounce.type}${bounce.subType ? `/${bounce.subType}` : ''}`
        : null;
      const detail = [kind, bounce?.message].filter(Boolean).join(': ') || null;
      return { state: 'BOUNCED', detail };
    }

    case 'email.delivery_delayed':
      return { state: 'DELAYED', detail: 'The provider is still trying to deliver this message.' };

    case 'email.complained':
      return { state: 'COMPLAINED', detail: 'The recipient marked this message as spam.' };

    case 'email.delivered':
      /**
       * Recorded for the STAFF row, which is the one surface that benefits from
       * knowing a link genuinely landed and was still never clicked. The public
       * `/delivery` endpoint deliberately never reports it — see that module for
       * why "delivered" would turn a bounce check into an address-validity
       * probe.
       */
      return { state: 'DELIVERED', detail: null };

    default:
      return null;
  }
}

export default async function resendRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/resend', {
    config: { rawBody: true },
    preHandler: async function handler(request: FastifyRequest, reply: FastifyReply) {
      const secret = process.env.RESEND_WEBHOOK_SECRET;
      if (!secret) {
        /**
         * Not configured yet. 503 rather than 401: this is OUR state, not a bad
         * delivery, and Resend retries a 5xx — so the first real bounce after
         * Tim adds the secret still lands rather than being lost to a 4xx that
         * says "never send this again".
         */
        request.log.warn('RESEND_WEBHOOK_SECRET is not set; refusing delivery');
        reply.status(503).send('Webhook not configured');
        return;
      }

      const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody;
      if (typeof rawBody !== 'string') {
        reply.status(401).send('Unauthorized');
        return;
      }

      const headers = request.headers;
      const ok = verifyResendSignature({
        rawBody,
        id: headers[ID_HEADER] as string | undefined,
        timestamp: headers[TIMESTAMP_HEADER] as string | undefined,
        signature: headers[SIGNATURE_HEADER] as string | undefined,
        secret,
      });

      if (!ok) {
        reply.status(401).send('Unauthorized');
        return;
      }
    },
    handler: async function handler(request: FastifyRequest, reply: FastifyReply) {
      const event = request.body as ResendEvent;
      const outcome = interpret(event);
      const emailId = event.data?.email_id;

      // An event type we do not act on, or one with no message to act on.
      // Both are ordinary; both are 200.
      if (!outcome || !emailId) return reply.status(200).send({ received: true });

      /**
       * ── An unknown message id is a NO-OP, never an error ─────────────────
       *
       * This endpoint receives EVERY email event for the whole Resend account —
       * roster invitations, notifications, grade mails, all of it. Almost none
       * of them correspond to a form magic token, and a bounce for one of those
       * must be answered 200 and forgotten. Throwing would make Resend retry a
       * delivery that will never match, for days, and eventually mark the
       * endpoint unhealthy.
       *
       * `updateMany` is what makes that free: no match updates no rows and
       * raises nothing, where `update` would throw P2025. It is also what makes
       * a REDELIVERY idempotent — the provider retries, the same terminal state
       * is written again, and nothing observable changes.
       */
      try {
        const { count } = await getPrisma().formMagicToken.updateMany({
          where: { provider_message_id: emailId },
          data: { delivery_state: outcome.state, delivery_detail: outcome.detail },
        });

        if (count > 0) {
          request.log.info(
            { emailId, state: outcome.state, tokens: count },
            'recorded form link delivery state'
          );
        }
      } catch (error) {
        /**
         * A database fault IS worth a 5xx: the event was genuine and Resend's
         * retry is the recovery path. Distinguished from the no-match case
         * above precisely so that "not ours" and "we broke" do not share an
         * answer.
         */
        request.log.error({ emailId, error }, 'failed to record delivery state');
        return reply.status(500).send({ error: 'could not record delivery state' });
      }

      return reply.status(200).send({ received: true });
    },
  });
}
