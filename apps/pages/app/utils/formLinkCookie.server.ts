/**
 * The browser-side half of "this person has already proved they own this
 * address".
 *
 * ── What is stored, and why it is the token itself ─────────────────────────
 * When somebody opens their verification link BEFORE they have finished the
 * form, the verify page proves the address and sends them back to finish. The
 * submit that follows has to be able to say "the person pressing this button is
 * the one who opened that mailbox" — and it has to say it in a way a crafted
 * request cannot.
 *
 * So the cookie holds the RAW MAGIC TOKEN: the same 256-bit value that was
 * mailed, stored in the database only as a sha256 digest. That makes the cookie
 * self-authenticating — there is no flag to flip, no id to swap, and nothing to
 * sign, because the server resolves the token to a response row and then
 * requires that row's address to equal the address being submitted
 * (`submitVerifiedPublic`). A forged cookie resolves to nothing; a stolen one
 * is a stolen magic link, which is the credential the whole flow already rests
 * on.
 *
 * ── Scoping: the name carries the form, the path carries the classroom ─────
 * The obvious scoping — `Path=/{class}/forms/{slug}` — is WRONG, and quietly
 * so. React Router's single fetch asks for `/{class}/forms/{slug}.data`, and
 * RFC 6265 path matching requires the character after the prefix to be `/`; a
 * request for `…/waitlist.data` therefore does not match a cookie scoped to
 * `…/waitlist`. The cookie is sent on the document request and silently absent
 * from every client-side navigation and every fetcher POST — which is to say,
 * absent from the entire flow it exists for.
 *
 * So the path is the classroom's forms subtree, which does match both, and the
 * FORM is carried in the cookie's NAME instead. That keeps two forms in one
 * classroom from overwriting each other (same name + same path would be one
 * cookie) while still never offering a token to another classroom or to the
 * rest of the pages host. A cookie that reaches a route it does not belong to
 * costs a failed lookup: the server resolves it to a response row and checks
 * the form and the address before it means anything.
 *
 * `HttpOnly` because no script has any business reading it: the page never
 * needs the token, only the server does. `SameSite=Lax` because the cookie must
 * survive the arrival from the email client (a top-level GET) and must not ride
 * along on a cross-site POST — the fill action checks the origin as well, so
 * this is the belt beside that brace.
 *
 * ── Lifetime ───────────────────────────────────────────────────────────────
 * The token's own remaining life, and no longer. A cookie that outlived its
 * token would be a shortcut that silently stopped working; one that died first
 * would send somebody back to their inbox for no reason.
 */

/**
 * One cookie name per form.
 *
 * Slugs are `[a-z0-9-]` (RESERVED_FORM_SLUGS and the create path both enforce
 * it), which is a subset of the RFC 6265 token characters — so this is a legal
 * cookie name without escaping. Sanitised anyway rather than trusted: a name
 * that could carry a `;` would let a slug write its own cookie attributes.
 */
const cookieNameFor = (formSlug: string): string =>
  `forms_link_${formSlug.replace(/[^a-zA-Z0-9-]/g, '')}`;

/** The subtree a classroom's form cookies are scoped to. */
const pathFor = (classroomSlug: string): string => `/${encodeURIComponent(classroomSlug)}/forms`;

/**
 * Is this request already on a secure origin?
 *
 * `Secure` cannot be set unconditionally: a cookie marked Secure is dropped by
 * the browser over plain http, which is what local development runs on, and the
 * one-round-trip path would silently never engage on a laptop. Behind Fly the
 * scheme in `request.url` is the forwarded one, which is the same value
 * `checkOrigin` compares against — so the two agree by construction.
 */
const isSecure = (request: Request): boolean => {
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * The raw token this browser holds for this form, or null.
 *
 * Reads the LAST matching value. A browser can in principle offer more than one
 * cookie of the same name (different paths), and the more specific one is sent
 * last; either way the server verifies the token against the form and the
 * address, so a wrong one costs a failed lookup and falls back to the ordinary
 * flow rather than becoming an error.
 */
export function readFormLinkCookie(request: Request, formSlug: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;

  const wanted = cookieNameFor(formSlug);
  let found: string | null = null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== wanted) continue;
    const value = rest.join('=').trim();
    if (value) found = value;
  }
  return found;
}

/**
 * How long this browser keeps its copy of the edit link after a submission.
 *
 * The token behind it now lives as long as the form does, so the cookie is the
 * shorter promise of the two and that is the right way round — a stale cookie
 * costs one round trip through the inbox, never access. Two hundred days sits
 * under the 400-day ceiling browsers cap `Max-Age` at, so the number the server
 * asks for is the number the browser actually keeps.
 */
export const EDIT_LINK_COOKIE_MAX_AGE_SECONDS = 200 * 24 * 60 * 60;

/** `Set-Cookie` that hands this browser the verified link for one form. */
export function formLinkCookie({
  request,
  classroomSlug,
  formSlug,
  rawToken,
  maxAgeSeconds,
}: {
  request: Request;
  classroomSlug: string;
  formSlug: string;
  rawToken: string;
  maxAgeSeconds: number;
}): string {
  const attributes = [
    `${cookieNameFor(formSlug)}=${rawToken}`,
    `Path=${pathFor(classroomSlug)}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isSecure(request)) attributes.push('Secure');
  return attributes.join('; ');
}

/*
 * `clearFormLinkCookie` used to live here, sent "the moment the token is
 * spent". A submission extends its token now instead of spending it, so that
 * moment no longer exists and the cookie is deliberately kept — see the submit
 * branch in `forms/fill/fill.tsx`. Removed rather than left unused, because a
 * helper whose whole rationale has stopped being true is a trap for whoever
 * reaches for it next.
 */

// ─── The WATCH cookie ───────────────────────────────────────────────────────

/**
 * "Did the message this browser just caused bounce?" — and nothing else.
 *
 * ── This is NOT the cookie above, and the difference is the whole design ───
 * The verified-link cookie holds the RAW MAGIC TOKEN and means "the person here
 * has proved they can read that mailbox". This one is set at BLUR, before
 * anybody has proved anything, so it must not carry that token or anything like
 * it — HttpOnly keeps a value away from scripts, not from the person at the
 * keyboard with devtools open, and handing an unverified browser the mailbox
 * credential would be exactly the wrong direction.
 *
 * So it holds a `form_magic_tokens` ROW ID. Nothing in this system
 * authenticates with a row id: it opens no link, submits no response and proves
 * no address. The single question it can answer is the one its holder already
 * knows the context for — "the send I just triggered, how did it go?"
 *
 * A DIFFERENT NAME, deliberately. `readFormLinkCookie` matches on the name, so
 * these two can never be confused for one another by accident; the submit path
 * has no way to read this one even if a future edit forgot the distinction.
 *
 * ── Why it is ALWAYS set ───────────────────────────────────────────────────
 * A cookie that appeared only when mail actually went out would answer "has
 * this address already responded?" through the presence of a `Set-Cookie`
 * header — the membership oracle the entire flow is built to avoid, rebuilt in
 * a response header. The fill action therefore sets one on EVERY early-send
 * reply, substituting an opaque id of its own when there is no real send to
 * point at, and the status endpoint answers `pending` for an id it cannot find
 * rather than 404ing. A watcher cannot tell the two apart.
 */
const watchCookieNameFor = (formSlug: string): string =>
  `forms_watch_${formSlug.replace(/[^a-zA-Z0-9-]/g, '')}`;

/**
 * How long a browser may keep asking about one send.
 *
 * Short: the page polls for a bounce for a bounded window while somebody is
 * actually on the form. A bounce that lands after they have gone is what the
 * STAFF surfacing is for — this cookie is not trying to be a mailbox.
 */
export const WATCH_COOKIE_MAX_AGE_SECONDS = 30 * 60;

/** The watch id this browser holds for one form, or null. */
export function readFormWatchCookie(request: Request, formSlug: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;

  const wanted = watchCookieNameFor(formSlug);
  let found: string | null = null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== wanted) continue;
    const value = rest.join('=').trim();
    if (value) found = value;
  }
  return found;
}

/**
 * `Set-Cookie` naming the send this browser may ask about.
 *
 * Same scoping as the link cookie — the form in the NAME, the classroom's forms
 * subtree in the path — for the same RFC 6265 reason documented above: a cookie
 * scoped to the form's own path is silently absent from React Router's
 * `.data` requests, which is the entire flow it exists for.
 */
export function formWatchCookie({
  request,
  classroomSlug,
  formSlug,
  watchId,
}: {
  request: Request;
  classroomSlug: string;
  formSlug: string;
  /**
   * The send to watch, or NULL when there is none to point at.
   *
   * Null mints a random stand-in rather than omitting the cookie, and that
   * substitution is the whole reason this parameter is nullable instead of the
   * caller being trusted to remember. A caller that skipped the header when it
   * had nothing real would be answering "did this address already respond?" and
   * "did the honeypot spring?" in a response header. The stand-in resolves to
   * no row, and `/delivery` reports `pending` for exactly that — the same word
   * it uses for a send in flight and for one that arrived.
   */
  watchId: string | null;
}): string {
  const attributes = [
    `${watchCookieNameFor(formSlug)}=${encodeURIComponent(watchId ?? crypto.randomUUID())}`,
    `Path=${pathFor(classroomSlug)}`,
    `Max-Age=${WATCH_COOKIE_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (isSecure(request)) attributes.push('Secure');
  return attributes.join('; ');
}
