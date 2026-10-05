import type { APIRoute } from 'astro';

// The one route on this site that runs on the server; every page is still static.
export const prerender = false;

const TO = 'hello@classmoji.io';
const FROM = 'Classmoji <hello@classmoji.io>';

const LIMITS = { name: 120, email: 254, school: 160, message: 5000 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A few messages per address per hour. In memory, so it resets on deploy and is
// per machine; the site runs on one, and this only has to stop casual floods.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const recent = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter(t => now - t < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) {
    recent.set(ip, hits);
    return true;
  }
  hits.push(now);
  recent.set(ip, hits);
  return false;
}

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
  let form: FormData;
  try {
    form = await request.formData();
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

  const ip = request.headers.get('fly-client-ip') ?? clientAddress ?? 'unknown';
  if (rateLimited(ip)) {
    return reply(request, 429, { ok: false, error: 'Too many messages. Try again in an hour.' });
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
