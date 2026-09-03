import crypto from 'crypto';

import { ClassmojiService, getGitProvider, describeTokenMintError } from '@classmoji/services';

import type { Route } from './+types/route';

/**
 * POST /api/content/token — the content Worker's only way to reach a private
 * content repo.
 *
 * ── The shape of the system this sits in ───────────────────────────────────
 * The content delivery Worker serves course assets from the edge. On a cache
 * miss it has to read the file out of the classroom's content repo, and that
 * repo may be private. It cannot hold a GitHub credential of its own: there is
 * no single credential that would be correct — access is per-installation, one
 * per git organization, and which one applies is a fact only this database
 * knows. So the Worker asks here, naming a classroom, and gets back a
 * short-lived installation token scoped to exactly that org.
 *
 * That makes this endpoint a credential vending machine, and the rest of the
 * design follows from taking that seriously.
 *
 * ── Why the secret is read INSIDE the handler ──────────────────────────────
 * The same discipline `apps/hook-station/src/routes/resend.ts` spells out at
 * length: a route added AHEAD of its configuration must not be able to take the
 * app down. Reading `CONTENT_WORKER_SHARED_SECRET` at module load would make an
 * unset secret a boot failure for the entire webapp — every route, for every
 * user — over a feature nobody is using yet. Read here, an unconfigured
 * deployment answers 503 to this one path and changes nothing else: content
 * still renders through the legacy path, and the feature switches itself on
 * when the secret is set, with no code change.
 *
 * ── No session, no audit, no rate limit ────────────────────────────────────
 * This is service-to-service. There is no user to authorize, so the shared
 * secret IS the authorization and the constant-time compare below is the whole
 * gate. There is deliberately no audit row: an audit log records what a PERSON
 * did, and filling it with one row per edge cache miss would bury the entries
 * that matter. There is deliberately no rate limit: the only caller is the
 * Worker, the call happens on cache misses, and throttling it would turn a
 * traffic spike into missing images on live course pages. An attacker who has
 * the secret is not slowed down by a rate limit — they are already inside.
 *
 * ── The token is never logged ──────────────────────────────────────────────
 * Log lines here carry the classroom id and the outcome. Never the token, never
 * a prefix of it, and never the raw error from a failed mint (git and Octokit
 * both echo credentials back in failure text — that is what
 * `describeTokenMintError` exists to launder).
 */

/**
 * Constant-time comparison that does not leak length.
 *
 * `timingSafeEqual` requires equal-length buffers and throws otherwise, so the
 * usual `a.length !== b.length` guard in front of it re-introduces exactly the
 * side channel it was meant to close. Hashing both sides first makes the
 * compared buffers always 32 bytes, so length never reaches the branch.
 */
function secureCompare(a: string, b: string): boolean {
  const digestA = crypto.createHash('sha256').update(a).digest();
  const digestB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

/**
 * Classroom ids are `@default(uuid())`, so they are always lowercase v4. Pinned
 * to lowercase deliberately: an uppercase variant would not match a stored id
 * anyway, so accepting it would only trade this 400 for a 404 one query later.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // A 200 here carries a live credential. POST responses are not normally
      // cached, but the webapp sits behind a CDN and the cost of saying so is
      // zero — applied to every response so no future branch can forget.
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * GET/HEAD land here. There is nothing to read at this path — it mints a
 * credential — so every non-POST method is refused the same way.
 */
export const loader = async () => json({ error: 'method not allowed' }, 405);

export const action = async ({ request }: Route.ActionArgs) => {
  if (request.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405);
  }

  const sharedSecret = process.env.CONTENT_WORKER_SHARED_SECRET;
  if (!sharedSecret) {
    console.warn('[api.content.token] CONTENT_WORKER_SHARED_SECRET is not set; refusing');
    return json({ error: 'not configured' }, 503);
  }

  const authorization = request.headers.get('Authorization') ?? '';
  const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';

  // An absent header is compared, not short-circuited, so "no header" and
  // "wrong secret" cost the same and answer the same.
  if (!secureCompare(presented, sharedSecret)) {
    console.warn('[api.content.token] Rejected a request with a missing or wrong shared secret');
    return json({ error: 'unauthorized' }, 401);
  }

  let classroomId: unknown;
  try {
    ({ classroomId } = await request.json());
  } catch {
    return json({ error: 'invalid request body' }, 400);
  }

  if (typeof classroomId !== 'string' || !classroomId) {
    return json({ error: 'classroomId is required' }, 400);
  }

  // Checked BEFORE the lookup, because Prisma does not treat a malformed uuid
  // as "no such row" — it rejects the query, which would surface here as an
  // unhandled 500 for what is plainly a bad request. Refusing on shape keeps
  // the contract honest: 400 means the Worker sent something wrong, 404 means
  // it sent something well-formed that does not exist.
  if (!UUID_PATTERN.test(classroomId)) {
    return json({ error: 'classroomId must be a uuid' }, 400);
  }

  const classroom = await ClassmojiService.classroom.findById(classroomId);

  // One 404 for "no such classroom" and for "it has no git organization". Both
  // mean the same thing to the Worker — there is nothing here it can fetch —
  // and a caller holding the shared secret gains nothing from the distinction.
  if (!classroom?.git_organization?.login || !classroom.content_repo) {
    console.warn(`[api.content.token] No content repo resolvable for classroom ${classroomId}`);
    return json({ error: 'not found' }, 404);
  }

  const org = classroom.git_organization.login;
  const repo = classroom.content_repo;

  try {
    const provider = getGitProvider(classroom.git_organization);

    // NARROWED AT THE SOURCE. The Worker needs to read one repo; an unscoped
    // installation token would carry every permission the app holds on every
    // repo in the org, student and grading repos included. GitHub mints this
    // one already limited, so the blast radius of a leaked token — or of a
    // leaked CONTENT_WORKER_SHARED_SECRET — is read-only on one content repo
    // for one hour, rather than write access across the org.
    const { token, expiresAt } = await provider.getInstallationToken({
      repositories: [repo],
      permissions: { contents: 'read' },
    });

    // Deliberately silent on success. This fires on every edge cache miss, so a
    // per-mint line would be pure volume — and the one thing worth never
    // writing down is in scope right here. Refusals and failures log; the happy
    // path does not.
    return json({ org, repo, token, expiresAt }, 200);
  } catch (error: unknown) {
    // Laundered before it is logged: raw mint failures echo credentials back.
    console.error(
      `[api.content.token] Mint failed for classroom ${classroomId}: ` +
        describeTokenMintError(org, error)
    );
    // The Worker gets no detail. It cannot act on the reason — its only move is
    // to fall back — and the reason is about this deployment's GitHub App, not
    // about the request.
    return json({ error: 'token mint failed' }, 502);
  }
};
