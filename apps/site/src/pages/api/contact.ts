import type { APIRoute } from 'astro';
// On Cloudflare the Worker's bindings; the Node build aliases this module to
// an empty stub (astro.config.mjs), so `env` is {} there and unused.
import { env } from 'cloudflare:workers';
import {
  clientIp,
  createMemoryLimiter,
  limiterKey,
  overLimit,
  parseForm,
  readCappedBody,
  type ContactBindings,
  type Runtime,
} from '../../lib/contactGuard';

// The one route on this site that runs on the server; every page is still static.
export const prerender = false;

// Fixed at build time (astro.config.mjs): Fly's Node server or a Cloudflare Worker.
const RUNTIME: Runtime = __CF_BUILD__ ? 'workerd' : 'node';

const TO = 'hello@classmoji.io';
const FROM = 'Classmoji <hello@classmoji.io>';

const LIMITS = { name: 120, email: 254, school: 160, message: 5000 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A few messages per address per hour, in memory (per machine on Fly, per
// isolate on Workers, where the rate-limit bindings add per-minute limits).
const memory = createMemoryLimiter({ max: 5, windowMs: 60 * 60 * 1000 });

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const field = (form: FormData, key: string) => String(form.get(key) ?? '').trim();

/** JSON for the page's script; a redirect back for a plain form post without JavaScript. */
function reply(request: Request, status: number, body: { ok: boolean; error?: string }) {
  const wantsJson = request.headers.get('accept')?.includes('application/json');
  if (wantsJson) return Response.json(body, { status });
  const target = body.ok ? '/contact?sent=1#form' : '/contact?error=1#form';
  return new Response(null, { status: 303, headers: { Location: target } });
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  // Capped before parsing, on both runtimes (the Node adapter's bodySizeLimit
  // is the same size; Workers has no such limit of its own).
  const body = await readCappedBody(request).catch(() => null);
  if (body === 'too-large') {
    return reply(request, 413, { ok: false, error: 'That message is too long.' });
  }
  let form: FormData;
  try {
    if (!body) throw new Error('unreadable body');
    form = await parseForm(body, request.headers.get('content-type'));
  } catch {
    return reply(request, 400, { ok: false, error: 'Could not read the form.' });
  }

  // Honeypot: people never see this field, bots fill it in. Pretend it worked.
  if (field(form, 'website')) return reply(request, 200, { ok: true });

  const name = field(form, 'name');
  const email = field(form, 'email');
  const school = field(form, 'school');
  const message = field(form, 'message');

  if (!name || !email || !message) {
    return reply(request, 400, { ok: false, error: 'Fill in your name, email, and message.' });
  }
  if (!EMAIL.test(email)) {
    return reply(request, 400, { ok: false, error: 'Enter a valid email, like you@school.edu.' });
  }
  if (
    name.length > LIMITS.name ||
    email.length > LIMITS.email ||
    school.length > LIMITS.school ||
    message.length > LIMITS.message
  ) {
    return reply(request, 400, { ok: false, error: 'That message is too long.' });
  }

  const key = limiterKey(clientIp(RUNTIME, request.headers, () => clientAddress));
  const limited = await overLimit({
    runtime: RUNTIME,
    key,
    memory,
    bindings: env as ContactBindings,
  });
  if (limited) {
    return reply(request, 429, { ok: false, error: 'Too many messages. Try again later.' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[contact] RESEND_API_KEY is not set; the message was not sent.');
    return reply(request, 503, {
      ok: false,
      error: `The form is not available right now. Email ${TO} instead.`,
    });
  }

  // The `contact-message` template in Resend (Contact — Message) carries the
  // layout and subject. Its variables are inserted as raw HTML, so everything a
  // visitor typed is escaped first; the message keeps its line breaks.
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM,
      to: [TO],
      reply_to: email,
      template: {
        id: 'contact-message',
        variables: {
          SENDER_NAME: escapeHtml(name),
          SENDER_EMAIL: escapeHtml(email),
          ...(school ? { SCHOOL: escapeHtml(school) } : {}),
          MESSAGE: escapeHtml(message).replace(/\r?\n/g, '<br />'),
        },
      },
    }),
  }).catch(() => null);

  if (!response?.ok) {
    console.error('[contact] Resend rejected the message:', response?.status, await response?.text());
    return reply(request, 502, {
      ok: false,
      error: `Could not send your message. Email ${TO} instead.`,
    });
  }

  return reply(request, 200, { ok: true });
};
