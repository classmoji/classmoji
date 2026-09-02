import { createHash, randomBytes } from 'node:crypto';
import getPrisma from '@classmoji/database';
import {
  answersByteSize,
  parseAnswers,
  requiresResolvedContext,
  FORM_ANSWERS_TOO_LARGE,
  FORM_LIMITS,
  type ResolvedTargetRef,
} from './formContract.ts';
import {
  buildResolvedContext,
  isBlockingRepeatState,
  newTargetsSince,
  resolveRepeatGroups,
  schemaContextFor,
  type RepeatResolution,
} from './formTeamResolver.ts';
import { escapeVars, pagesUrl } from '../emails/escape.ts';
import { fieldsOf } from './form.service.ts';
import type { Prisma, SubmissionState } from '@prisma/client';

/**
 * Form Response Service
 *
 * Everything that writes or reads a submitted answer set. Carries NO
 * authorization: the caller (a pages loader/action, an MCP tool) runs its own
 * membership and Pro checks first.
 *
 * ── ISOLATION INVARIANT ─────────────────────────────────────────────────────
 * No read path here may hand one person another person's response to a
 * non-staff caller. That is enforced by shape, not by discipline: the self-read
 * functions (`findOwnResponse`, `findOwnResponseByDraftToken`) take an EXPLICIT
 * identity argument and scope the query to it, and `listByFormId` — the only
 * function that returns every row and the staff-only columns — is documented
 * staff-only and must never be reachable from a student or public route.
 *
 * Routes must derive the identity they pass to a self-read from the SESSION (or
 * from a verified magic token), never from a request parameter. `findOwnResponse
 * (formId, req.query.userId)` would be an enumeration hole with a service that
 * did exactly what it was told.
 */

// ─── Error codes ────────────────────────────────────────────────────────────

export const FORM_NOT_FOUND = 'FORM_NOT_FOUND';
export const FORM_NOT_OPEN = 'FORM_NOT_OPEN';
export const FORM_CLOSED = 'FORM_CLOSED';
/** The response cap is full (counting VERIFIED responses only). */
export const FORM_CAP_REACHED = 'FORM_CAP_REACHED';
/** Submitted against a revision that is no longer the form's current one. */
export const FORM_REVISION_STALE = 'FORM_REVISION_STALE';
/** The form's access mode does not match the submission path used. */
export const FORM_ACCESS_MISMATCH = 'FORM_ACCESS_MISMATCH';
/** A single-response form already has a submitted response for this identity. */
export const FORM_ALREADY_SUBMITTED = 'FORM_ALREADY_SUBMITTED';
export const FORM_RESPONSE_NOT_FOUND = 'FORM_RESPONSE_NOT_FOUND';
/** Server-side partials are off for this form. */
export const FORM_PARTIALS_DISABLED = 'FORM_PARTIALS_DISABLED';
/**
 * A teammate JOINED the filler's team between the page rendering and the
 * submit. Refused rather than half-accepted: `require_all_targets` is a
 * promise about a team, and quietly recording a review set that misses its
 * newest member would break it silently. The route re-renders with a notice and
 * the answers intact — the same shape as FORM_REVISION_STALE.
 */
export const FORM_TEAM_CHANGED = 'FORM_TEAM_CHANGED';
/**
 * The filler cannot be resolved to a reviewable team (no team, an untagged one,
 * or more than one). The loader normally catches this and renders the form's
 * error state instead of the form; this is the submit-path backstop.
 */
export const FORM_TEAM_UNRESOLVED = 'FORM_TEAM_UNRESOLVED';

/**
 * A confirm arrived for a row that holds an address and no answers — the state
 * `beginAddressVerification` leaves behind. There is nothing to confirm yet;
 * the route says so and points back at the form.
 */
export const FORM_NOT_SUBMITTED_YET = 'FORM_NOT_SUBMITTED_YET';
/**
 * The credential offered for a one-round-trip submit does not bind to the
 * address being submitted (missing, spent, expired, another form's, another
 * address's, or never verified). NOT AN ERROR the filler ever sees: the route
 * falls back to the ordinary check-your-email flow, which is why the early
 * send is an optimisation and never a requirement.
 */
export const MAGIC_LINK_NOT_BOUND = 'MAGIC_LINK_NOT_BOUND';

export const MAGIC_LINK_INVALID = 'MAGIC_LINK_INVALID';
export const MAGIC_LINK_EXPIRED = 'MAGIC_LINK_EXPIRED';
export const MAGIC_LINK_USED = 'MAGIC_LINK_USED';
/** Too many links requested for one response inside the rolling window. */
export const MAGIC_LINK_COOLDOWN = 'MAGIC_LINK_COOLDOWN';

const serviceError = (code: string, message: string) => Object.assign(new Error(message), { code });

// ─── Magic-link policy ──────────────────────────────────────────────────────

/**
 * A link lives as long as its form does. There is no second clock.
 *
 * It used to be minted with 48 hours on it, and that number then had to mean
 * two different things at once — a deadline to verify, and the life of the
 * handle somebody keeps on their own response. Every surface that tried to
 * explain it got one of the two wrong, and the flow grew reminders to chase a
 * deadline that only existed because the number did.
 *
 * `assertAccepting` is what actually decides whether a response can still be
 * written; this only decides how long the link keeps opening it. On a form with
 * no close date that is a long backstop rather than forever — an unbounded
 * bearer credential is worth avoiding even when nothing is enforcing it.
 */
export const LINK_OPEN_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

/** When a link minted now should stop working: the form's life, not a TTL. */
const linkExpiresAt = (form: { closes_at: Date | null }, now: Date): Date =>
  form.closes_at ?? new Date(now.getTime() + LINK_OPEN_HORIZON_MS);
/**
 * Links per response inside the rolling window.
 *
 * THREE, and it stayed three because an honest interaction costs ONE link.
 *
 * It briefly went to five, when moving the verification mail to blur time made
 * an ordinary journey cost two — typing the address minted one, submitting
 * minted another — and three then refused somebody their second attempt inside
 * the hour. Reuse (see `findLiveLink`) removed the second link instead of
 * paying for it, so the reason for the loosening is gone and the ceiling on
 * what one mailbox can be sent goes back to where it was. Three now buys the
 * link itself plus two resends the person explicitly asked for, which is more
 * headroom than five bought when every step minted.
 *
 * It matters MORE than it did. Reuse is scoped to a browser now, so a caller
 * that cannot show the link it holds is mailed rather than quietly refused —
 * and this is what bounds how many times that can happen to one mailbox.
 *
 * The per-CLIENT limit in the pages app is the primary defence against a mail
 * relay; this one bounds what can be aimed at a single mailbox.
 */
export const MAGIC_TOKEN_MAX_PER_WINDOW = 3;
export const MAGIC_TOKEN_WINDOW_MS = 60 * 60 * 1000;
/**
 * The `delivery_state` meaning "we never managed to hand this message to the
 * provider at all".
 *
 * Not one of the provider's own states — those are reported by the Resend
 * webhook ('SENT', 'DELIVERED', 'BOUNCED', 'DELAYED', 'COMPLAINED') and all
 * describe a message that at least left. This one is written by
 * `sendEmailTask`'s `onFailure` hook, after its retries are exhausted, and
 * describes the opposite: nothing was sent, so there is nothing to bounce.
 *
 * It shares the column because it answers the same question every other value
 * there answers — "did the mail carrying this link reach them?" — and because
 * the column is deliberately a plain string so a new value costs no migration.
 * Named here because the reuse rule turns on it; the writer (packages/tasks)
 * and the readers (the `/delivery` endpoint, the staff row) spell the same
 * literal, exactly as they already do for 'SENT' and 'BOUNCED'.
 */
export const MAGIC_LINK_SEND_FAILED = 'FAILED';

/**
 * The raw token is returned to the caller ONCE and never stored; only its
 * sha256 digest lives in the database, so a database read cannot mint a working
 * link. 32 bytes is 256 bits of entropy — the link is the entire authentication
 * for a public submission.
 */
function mintMagicToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Lower + trim. The identity key the partial unique index enforces. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ─── Shared submission guards ───────────────────────────────────────────────

interface LockedFormRow {
  id: string;
  status: 'DRAFT' | 'OPEN' | 'CLOSED';
  closes_at: Date | null;
  response_cap: number | null;
  allow_multiple: boolean;
  current_revision_id: string | null;
}

/**
 * Take the form's row lock and return its live state.
 *
 * Everything that decides whether a submission is allowed — status, close time,
 * cap — is read under this lock and acted on in the same transaction, which is
 * what makes the cap exact under concurrency. The pattern (and the raw
 * `FOR UPDATE`, which Prisma has no first-class expression for) is the one
 * quizAttempt.service.ts uses.
 *
 * Callers that also need to lock a magic token MUST take this lock FIRST, so
 * every writer acquires locks in the same order and cannot deadlock.
 */
async function lockForm(tx: Prisma.TransactionClient, formId: string): Promise<LockedFormRow> {
  const rows = await tx.$queryRaw<LockedFormRow[]>`
    SELECT id, status, closes_at, response_cap, allow_multiple, current_revision_id
    FROM forms
    WHERE id = ${formId}
    FOR UPDATE
  `;
  const form = rows[0];
  if (!form) throw serviceError(FORM_NOT_FOUND, `Form ${formId} not found`);
  return form;
}

/** OPEN, and not past its close time. Read under the row lock. */
function assertAccepting(form: LockedFormRow, now: Date): void {
  if (form.status !== 'OPEN') {
    throw serviceError(FORM_NOT_OPEN, 'This form is not accepting responses.');
  }
  if (form.closes_at && form.closes_at.getTime() <= now.getTime()) {
    throw serviceError(FORM_CLOSED, 'This form is closed.');
  }
}

/** True for `{}` — a row that holds an address and no answers. */
const answersAreEmpty = (answers: unknown): boolean =>
  !answers || typeof answers !== 'object' || Object.keys(answers as object).length === 0;

/**
 * Refuse if the cap is already full. A place is taken when the link is clicked.
 *
 * ── What is counted, and why it is only one thing ──────────────────────────
 * Confirmed responses. Nothing else.
 *
 * This used to also count unverified submissions as RESERVATIONS, so that two
 * people submitting a second apart against the last slot were ranked by
 * submission time rather than by whose mail server was quicker. That fairness
 * was real, and it cost a second clock: a reservation has to expire, or one
 * abandoned submission holds a slot for ever — which is where the forty-eight
 * hours came from, and the reminders that existed to chase it, and the copy on
 * four screens trying to explain a deadline nobody could see.
 *
 * The rule is now the one a person would guess: your place is when you click.
 * A link never expires while its form is open, so nobody is racing a deadline
 * to claim one — the tie it used to break can only happen on a capped form, at
 * the exact boundary, between two people who submitted seconds apart, and the
 * loser can still confirm the moment a place frees up.
 *
 * ── Why it stays exact under concurrency ───────────────────────────────────
 * Every writer holds the form's row lock (see `lockForm`), so these counts are
 * taken in a serialized order: N simultaneous confirmations against a cap of K
 * admit exactly K.
 */
async function assertCapAvailable(
  tx: Prisma.TransactionClient,
  form: LockedFormRow,
  { excludeResponseId }: { excludeResponseId?: string } = {}
): Promise<void> {
  if (form.response_cap === null) return;

  const taken = await tx.formResponse.count({
    where: {
      form_id: form.id,
      submission_state: 'SUBMITTED',
      verified_at: { not: null },
      ...(excludeResponseId ? { id: { not: excludeResponseId } } : {}),
    },
  });

  if (taken >= form.response_cap) {
    throw serviceError(FORM_CAP_REACHED, 'This form has reached its response limit.');
  }
}

/**
 * Is this row already inside the cap?
 *
 * NOT `verified_at !== null`, which is the reading that used to be safe and no
 * longer is. Since the address can be verified BEFORE the answers are
 * submitted, a row can carry `verified_at` while still being a
 * PENDING_VERIFICATION placeholder that has never taken a slot — and treating
 * that as "already counted" would let it walk past both the cap and the
 * open/closed check on its way in. Counted means SUBMITTED and verified,
 * which is exactly what `assertCapAvailable` counts.
 */
const alreadyCounted = (response: {
  submission_state: SubmissionState;
  verified_at: Date | null;
}): boolean => response.submission_state === 'SUBMITTED' && response.verified_at !== null;

/** The revision a submission claims to have rendered against must still be current. */
function assertRevisionCurrent(form: LockedFormRow, revisionId: string): void {
  if (form.current_revision_id !== revisionId) {
    throw serviceError(
      FORM_REVISION_STALE,
      'This form changed while you were filling it in — reload to see the current version.'
    );
  }
}

/**
 * Load a form + the revision the caller claims, and validate the answers.
 *
 * PUBLIC path only. The classroom path validates INSIDE its transaction
 * instead, because its answer schema depends on a teammate resolution that has
 * to happen under the form's row lock — and because no caller may hand this
 * function a `resolved` context: the one place review targets come from is the
 * server-side resolver.
 */
async function validateAgainstRevision({
  formId,
  revisionId,
  answers,
  expectedAccess,
}: {
  formId: string;
  revisionId: string;
  /** `undefined` means "no answers to check" — the address-verification path. */
  answers: unknown;
  expectedAccess: 'PUBLIC' | 'CLASSROOM';
}) {
  const form = await getPrisma().form.findUnique({
    where: { id: formId },
    include: { classroom: { select: { slug: true, name: true } } },
  });
  if (!form) throw serviceError(FORM_NOT_FOUND, `Form ${formId} not found`);
  if (form.access !== expectedAccess) {
    throw serviceError(
      FORM_ACCESS_MISMATCH,
      `This form is ${form.access} — it cannot be submitted through the ${expectedAccess} path.`
    );
  }
  // Checked here for a clean error before any write; re-checked under the row
  // lock inside the transaction, which is what actually makes it safe.
  if (form.current_revision_id !== revisionId) {
    throw serviceError(
      FORM_REVISION_STALE,
      'This form changed while you were filling it in — reload to see the current version.'
    );
  }

  const revision = await getPrisma().formRevision.findUnique({ where: { id: revisionId } });
  if (!revision || revision.form_id !== formId) {
    throw serviceError(FORM_REVISION_STALE, 'Unknown form revision.');
  }

  const validated =
    answers === undefined ? undefined : parseAnswers(fieldsOf(revision.fields), answers);
  return { form, revision, validated };
}

// ─── Public submission: begin ───────────────────────────────────────────────

/**
 * A composed verify/edit-link mail, in the same shape roster.service's
 * `RosterEmail` uses. The template itself (`form-verify-link`) lands with the
 * public fill route; this shape is what the route hands to Tasks.sendEmailTask.
 */
export type FormEmailTemplateId = 'form-verify-link' | 'form-verify-reminder';

export interface FormVerifyEmail {
  payload: {
    to: string;
    /**
     * Correlation for the mail task — see `composeLinkEmail`. Absent when there
     * is nothing to correlate, which every caller must tolerate: the whole
     * bounce feature is additive, and a send without this behaves exactly as
     * sends did before it existed.
     */
    formMagicTokenId?: string;
    template: {
      id: FormEmailTemplateId;
      variables: Record<string, string | number>;
    };
  };
}

export interface BeginPublicSubmissionResult {
  responseId: string;
  /**
   * The raw link token, returned ONCE — never stored, never recoverable.
   *
   * NULL when a live link already covers this response and none was minted; see
   * `linkAlreadySentAt`. Null is not a failure and must never be reported as
   * one: it means the person already has a working link, and `emails` is empty
   * precisely so the caller's dispatch is a no-op rather than a decision.
   */
  rawToken: string | null;
  /** The full link. Also embedded in `emails`; exposed for dev-mode logging. */
  verifyUrl: string | null;
  /** 'existing' means this email already had a response; its answers are untouched. */
  mode: 'new' | 'existing';
  /**
   * When the link this submission is relying on was minted, if it was minted
   * earlier rather than now.
   *
   * FOR LOGGING AND TESTS ONLY, on exactly the terms `AddressVerificationResult.sent`
   * is. A route that rendered this would be telling anyone who can type an
   * address when that mailbox last asked for a link — the membership oracle in a
   * helpful-looking sentence. The check-email screen says "already sent" from
   * what the BROWSER itself did, never from this.
   */
  linkAlreadySentAt: Date | null;
  /**
   * The send this browser may ask about later — see the identical field on
   * `AddressVerificationResult`, including why a null here must never be
   * allowed to show through as a missing cookie.
   */
  watchTokenId: string | null;
  /**
   * Composed mail for the CALLER to send — EMPTY when a live link already
   * covers this response. Services must not import @classmoji/tasks (tasks
   * already depends on services — that would be circular), so composition lives
   * here and the trigger stays with the route, exactly as
   * roster.service.addStudents does it.
   */
  emails: FormVerifyEmail[];
}

/** The link a verification mail carries: the pages host owns the forms subtree. */
export function verifyUrlFor({
  classroomSlug,
  formSlug,
  rawToken,
}: {
  classroomSlug: string;
  formSlug: string;
  rawToken: string;
}): string {
  return `${pagesUrl()}/${classroomSlug}/forms/${formSlug}/verify?token=${rawToken}`;
}

/**
 * Compose one link mail.
 *
 * Every variable here is user-authored — a form title, a classroom name, a name
 * the filler typed about themselves — and Resend substitutes variables RAW, so
 * they are escaped before they reach the template. Keys are UPPERCASE to match
 * what `templates.mjs` declares.
 */
function composeLinkEmail({
  to,
  name,
  formTitle,
  classroomName,
  verifyUrl,
  template,
  formMagicTokenId,
}: {
  to: string;
  name?: string | null;
  formTitle: string;
  classroomName: string;
  verifyUrl: string;
  template: FormEmailTemplateId;
  /**
   * The token row this message carries the link for, so the mail task can write
   * the provider's message id back onto it and a later bounce can be traced to
   * a person. Carried in the ENVELOPE, never in the template variables: it is
   * plumbing for the sender, not something a recipient should ever see.
   */
  formMagicTokenId?: string;
}): FormVerifyEmail {
  return {
    payload: {
      to,
      ...(formMagicTokenId ? { formMagicTokenId } : {}),
      template: {
        id: template,
        variables: escapeVars({
          RECIPIENT_NAME: name || 'there',
          FORM_TITLE: formTitle,
          CLASSROOM_NAME: classroomName,
          VERIFY_URL: verifyUrl,
        }),
      },
    },
  };
}

/**
 * Mint a link for one response, under the per-response send cooldown.
 *
 * DB-backed so the limit holds across machines, and counted per RESPONSE —
 * which is per (form, email), the unit a mail bomb aimed at one mailbox would
 * target. Every path that can cause mail to be sent goes through here: the
 * blur-time address verification, the submit, the resend button, and the
 * reminder sweep. There is deliberately no way to mint a token that skips it.
 *
 * @throws MAGIC_LINK_COOLDOWN
 */
async function mintLinkFor(
  tx: Prisma.TransactionClient,
  responseId: string,
  form: { closes_at: Date | null },
  now: Date
): Promise<{ raw: string; tokenId: string }> {
  const recentTokens = await tx.formMagicToken.count({
    where: {
      response_id: responseId,
      created_at: { gt: new Date(now.getTime() - MAGIC_TOKEN_WINDOW_MS) },
    },
  });
  if (recentTokens >= MAGIC_TOKEN_MAX_PER_WINDOW) {
    throw serviceError(
      MAGIC_LINK_COOLDOWN,
      'Too many links requested for this address. Try again in an hour.'
    );
  }

  const { raw, hash } = mintMagicToken();
  /**
   * The row id comes back beside the raw token because both are needed and only
   * one of them may ever leave the building. The RAW TOKEN is the credential —
   * mailed, stored as a digest, and the whole authentication for a public
   * response. The ROW ID is a bare handle: nothing in this system authenticates
   * with it, so it is safe to hand to a mail task (to write the provider's
   * message id back) and to a browser (to ask "did my send bounce?").
   */
  const created = await tx.formMagicToken.create({
    data: {
      response_id: responseId,
      token_hash: hash,
      expires_at: linkExpiresAt(form, now),
    },
    select: { id: true },
  });
  return { raw, tokenId: created.id };
}

/**
 * The link THIS BROWSER can prove it already received for this response, or
 * null.
 *
 * ── Why there is a reuse rule at all ───────────────────────────────────────
 * Typing an address mints a link, and submitting would mint another. Two mails
 * for one action reads as broken to the person receiving them, and the second
 * makes the first ambiguous: which one do I click? Both work, so it was never
 * incorrect — just noisy, and noisy on the one surface where a stranger can
 * make us send mail. The link is already in their inbox; the right thing to do
 * with it is point at it.
 *
 * ── Why the caller has to PRESENT the link, and time is not enough ─────────
 * This used to ask "was a link for this address minted recently?", and the
 * window was a day. A day silently refused people: somebody who came back the
 * next morning, or tried from their phone, or filled in a republished version,
 * typed their address, was told to check their mail, and got nothing — because
 * reuse had decided a link they could no longer find already covered them.
 *
 * Shortening the window does not fix that, it only moves it. Two minutes was
 * the obvious answer and it is wrong in the other direction: anybody who takes
 * longer than two minutes to fill a form in gets both mails, which is the exact
 * noise this rule exists to remove. There is no length that is both long enough
 * for a slow form and short enough for a return visit, because TIME IS NOT THE
 * QUESTION. The question is "is this the same browser, still in the middle of
 * the same fill?" — and a clock is a bad proxy for it in both directions.
 *
 * So the caller must NAME the link it holds. `heldTokenId` comes from the watch
 * cookie the fill page set on the reply that sent it (see `formWatchCookie` in
 * the pages app), so presenting one is a demonstration that this browser was
 * the one we mailed. Same browser, same fill — silence, however long they take.
 * A different device, a new tab after the cookie lapsed, a cleared jar, or
 * tomorrow — nothing is presented, so a fresh link is minted and sent, which is
 * what somebody with no link in reach actually needs.
 *
 * The id is a bare row handle and nothing authenticates with it, so a forged or
 * borrowed one buys nothing: the worst it can do is suppress a mail to an
 * address, which is exactly what its owner's own browser would have done, and
 * `response_id` below is what stops a cookie from one address suppressing the
 * mail for another.
 *
 * ── The conditions on the link itself ─────────────────────────────────────
 * Presenting an id is not sufficient — each of these is a way reuse could
 * otherwise strand somebody with a dead link and no mail:
 *
 *  - it names a token for THIS response — a browser that typed one address and
 *    then another is holding a link that opens the wrong row;
 *  - unspent (`used_at` null) — nothing sets this column any more, since a
 *    submission now EXTENDS its link rather than spending it, but rows written
 *    before that change still carry it and a spent link opens nothing;
 *  - unexpired — the obvious one;
 *  - NOT KNOWN TO HAVE FAILED TO SEND — see below.
 *
 * There is deliberately no condition on AGE. A link a browser can still point
 * at is one it demonstrably received; how long ago that was tells us nothing
 * further, and the old age check is what was refusing people.
 *
 * The RAW token is not recoverable (only its digest is stored), which is
 * exactly right: reuse means "send nothing", never "send the old link again".
 * The one already in their inbox is the copy.
 *
 * ── "A token exists" is not "mail reached them" ────────────────────────────
 * The first three conditions all describe the TOKEN. None of them describes the
 * MESSAGE, and that gap stranded people: a mail whose Trigger run failed (an
 * unsynced template, a rate limit, a provider outage) leaves a token that is
 * unspent, unexpired and freshly minted, so every check above passes and the
 * next blur or submit concludes a live link already covers the address and
 * sends nothing. Somebody who never received a link could then never get one —
 * the failure being asynchronous, the page that asked for the mail had already
 * answered the browser successfully.
 *
 * `delivery_state === 'FAILED'` is written by `sendEmailTask`'s `onFailure`
 * hook, which fires only once the retries are exhausted. So it means "this
 * message is never going out", not "an attempt went badly".
 *
 * ── Why only a KNOWN failure disqualifies ──────────────────────────────────
 * A NULL `delivery_state` is "nothing reported yet", and a send dispatched
 * seconds ago always looks exactly like that. Treating unknown as failed would
 * make every fresh token unreusable and bring back the double-send this rule
 * exists to prevent — two mails for one action, seconds apart. So the filter is
 * written as "null, or anything that is not FAILED" rather than as a whitelist
 * of good states: an unfamiliar state a future provider event introduces stays
 * reusable, which is the same conservative direction the column's own comment
 * takes. Spelled out as an explicit OR rather than a bare `not`, because
 * `not` against a NULL column is exactly the SQL three-valued-logic trap that
 * would silently exclude every unreported send.
 *
 * Called inside the form's row lock by every path that would otherwise mint, so
 * two concurrent sends for one address cannot both decide they are the first.
 */
async function findLiveLink(
  tx: Prisma.TransactionClient,
  responseId: string,
  heldTokenId: string | null | undefined,
  now: Date
): Promise<{ id: string; created_at: Date } | null> {
  // Nothing presented, nothing to reuse — and no query worth making. A caller
  // with no held link is a browser we have never mailed for this response, or
  // one that can no longer show us we did; either way it needs a link of its
  // own.
  if (!heldTokenId) return null;

  return tx.formMagicToken.findFirst({
    where: {
      id: heldTokenId,
      response_id: responseId,
      used_at: null,
      expires_at: { gt: now },
      OR: [{ delivery_state: null }, { delivery_state: { not: MAGIC_LINK_SEND_FAILED } }],
    },
    // The id comes back so a caller who sends NOTHING can still point a browser
    // at the send that is already outstanding — otherwise re-typing the same
    // address would replace a real bounce watch with a dead one. `created_at`
    // becomes `linkAlreadySentAt`, which the fill route deliberately drops on
    // the floor (it is a membership oracle if rendered) and the tests assert:
    // the true age of the link they hold, however old that is, never a
    // comfortable "just now".
    select: { id: true, created_at: true },
  });
}

/**
 * Store a public submission as PENDING_VERIFICATION and mint a magic link.
 *
 * Nothing counts until the link is clicked: the row holds the (form_id,
 * email_normalized) uniqueness slot but has no verified_at, so it is invisible
 * to the cap and to the FIFO ordering. When the email ALREADY has a response,
 * this returns mode:'existing' and DOES NOT overwrite its answers — the link is
 * then an edit link, and only the inbox owner gets to decide whether the stored
 * answers change. That is what closes the impersonation hole: anyone can type
 * anyone's address, and the worst they achieve is mailing that person a link.
 *
 * The caller composes and sends the mail (or logs the link in dev) — the same
 * "service prepares, route delivers" split roster.service uses for invites — so
 * this function stays testable and free of transport concerns. `emails` is
 * EMPTY, and `rawToken` null, when the caller presents a link this browser
 * already holds for this response; see `findLiveLink`.
 *
 * @throws MAGIC_LINK_COOLDOWN, FORM_NOT_OPEN, FORM_CLOSED, FORM_REVISION_STALE,
 *   FORM_ACCESS_MISMATCH, and the contract's answer-validation codes.
 */
export async function beginPublicSubmission({
  formId,
  email,
  name,
  answers,
  revisionId,
  heldTokenId,
}: {
  formId: string;
  email: string;
  name?: string | null;
  answers: unknown;
  revisionId: string;
  /**
   * The link this browser can show it already received for this response — the
   * watch cookie's id, forwarded by the fill route. Reuse turns on it and on
   * nothing else; see `findLiveLink`. Absent means "mint and send", which is
   * the right answer for a browser that cannot point at a link.
   */
  heldTokenId?: string | null;
}): Promise<BeginPublicSubmissionResult> {
  const emailNormalized = normalizeEmail(email);
  const { form: loadedForm, validated } = await validateAgainstRevision({
    formId,
    revisionId,
    answers,
    expectedAccess: 'PUBLIC',
  });

  const now = new Date();

  return getPrisma().$transaction(async tx => {
    const form = await lockForm(tx, formId);
    assertAccepting(form, now);
    assertRevisionCurrent(form, revisionId);

    // Select-then-insert is safe here only because of the row lock above: every
    // writer for this form is serialized, so the read cannot go stale before the
    // insert. Catch-P2002-and-retry would be wrong inside a transaction anyway
    // (Postgres 25P02 aborts it).
    const existing = await tx.formResponse.findFirst({
      where: { form_id: formId, user_id: null, email_normalized: emailNormalized },
      select: { id: true, submission_state: true, answers: true },
    });

    let responseId: string;

    if (!existing) {
      const created = await tx.formResponse.create({
        data: {
          form_id: formId,
          revision_id: revisionId,
          user_id: null,
          email: email.trim(),
          email_normalized: emailNormalized,
          name: name ?? null,
          answers: validated as unknown as Prisma.InputJsonValue,
          submission_state: 'PENDING_VERIFICATION',
          submitted_at: now,
        },
        select: { id: true },
      });
      responseId = created.id;
    } else {
      responseId = existing.id;

      /**
       * ── The one case where a submission may write over an existing row ────
       *
       * An ADDRESS PLACEHOLDER: PENDING_VERIFICATION with `{}` for answers, the
       * row `beginAddressVerification` leaves behind when somebody types their
       * address and the link goes out before they have finished typing. It
       * holds an address and nothing else, so there is no one's data in it to
       * protect — and refusing to write here would silently discard the answer
       * set the person just submitted, which is the worst outcome available.
       *
       * Everything else is left exactly as it was, which is the rule that
       * closes the impersonation hole: a SUBMITTED response, and an unverified
       * one that already carries somebody's answers, cannot be overwritten by
       * anyone who merely knows the address. They get a link, and only the
       * inbox owner decides whether the stored answers change.
       *
       * `submitted_at` moves to now along with the answers. It is the FIFO
       * position, and a placeholder's timestamp is when an address was typed,
       * not when a response was made — leaving it would let somebody who opened
       * the form at breakfast outrank a submission that actually arrived first.
       */
      if (
        existing.submission_state === 'PENDING_VERIFICATION' &&
        answersAreEmpty(existing.answers)
      ) {
        await tx.formResponse.update({
          where: { id: existing.id },
          data: {
            revision_id: revisionId,
            email: email.trim(),
            name: name ?? null,
            answers: validated as unknown as Prisma.InputJsonValue,
            submitted_at: now,
          },
        });
      }
    }

    /**
     * ── The second mail that is not worth sending ─────────────────────────
     *
     * Somebody who typed their address (which mailed a link) and then submitted
     * without opening it used to get a SECOND mail, seconds after the first.
     * Two mails for one action reads as broken, and the second one makes the
     * first ambiguous. The link minted on blur opens this very row — the
     * placeholder overwrite above has just put the real answers into it — so
     * there is nothing the new link would do that the old one does not.
     *
     * Only for the browser that HOLDS that link, though. A submit arriving with
     * no `heldTokenId` is a browser that cannot show us it was mailed — another
     * device, a lapsed cookie, a submit with no blur send behind it — and the
     * correct answer for all three is a link it can actually reach.
     *
     * Nobody is stranded either way. Reuse requires a link that is unspent,
     * unexpired and not known to have failed to send (`findLiveLink`), so the
     * alternative to a mail is always a working link rather than silence, and
     * the check-email screen's resend button force-mints for the person who
     * cannot find it.
     */
    const live = await findLiveLink(tx, responseId, heldTokenId, now);
    if (live) {
      return {
        responseId,
        rawToken: null,
        verifyUrl: null,
        mode: existing ? ('existing' as const) : ('new' as const),
        linkAlreadySentAt: live.created_at,
        // Nothing was sent, but a send IS outstanding — so the browser is
        // pointed at that one rather than at nothing.
        watchTokenId: live.id,
        emails: [],
      };
    }

    const { raw, tokenId } = await mintLinkFor(tx, responseId, form, now);
    const verifyUrl = verifyUrlFor({
      classroomSlug: loadedForm.classroom.slug,
      formSlug: loadedForm.slug,
      rawToken: raw,
    });

    return {
      responseId,
      rawToken: raw,
      verifyUrl,
      mode: existing ? ('existing' as const) : ('new' as const),
      linkAlreadySentAt: null,
      watchTokenId: tokenId,
      emails: [
        composeLinkEmail({
          to: email.trim(),
          name,
          formTitle: loadedForm.title,
          classroomName: loadedForm.classroom.name,
          verifyUrl,
          template: 'form-verify-link',
          formMagicTokenId: tokenId,
        }),
      ],
    };
  });
}

// ─── Public submission: verify the ADDRESS, early ───────────────────────────

export interface AddressVerificationResult {
  /**
   * Composed mail for the caller to send. EMPTY when nothing is to be sent —
   * see `sent`. The caller must render the identical view either way.
   */
  emails: FormVerifyEmail[];
  verifyUrl: string | null;
  /**
   * Whether a link was actually minted.
   *
   * FOR LOGGING AND TESTS ONLY. A route that rendered this would be handing
   * anyone who can type an address a "has this person already responded?"
   * oracle, which is the thing the whole flow is built to avoid.
   */
  sent: boolean;
  /**
   * The send this browser may ask about later, or null when there is none.
   *
   * A bare row handle, NOT a credential: nothing authenticates with it, and the
   * only thing it unlocks is "did the message for this one send bounce?" — a
   * question about something the asker themselves just caused.
   *
   * ── Null is not a signal, because the caller must not let it become one ───
   * This is null in exactly the case `sent: false` is interesting — an address
   * that has already verified — so a route that set a cookie when it is present
   * and no cookie when it is absent would have rebuilt the membership oracle out
   * of `Set-Cookie` headers. The fill action therefore ALWAYS sets a watch
   * cookie and substitutes an opaque id of its own when this is null. See the
   * note there; it is the reason this field can exist at all.
   */
  watchTokenId: string | null;
}

/**
 * Send the verification link when the respondent finishes typing their address,
 * rather than after they finish the whole form.
 *
 * ── What changes, and what does not ────────────────────────────────────────
 * The link has always proved one thing: that whoever holds it can read the
 * mailbox the response is filed under. Nothing about that changes here — only
 * WHEN it is sent. The row is stored exactly as `beginPublicSubmission` stores
 * one (PENDING_VERIFICATION, holding the (form_id, email_normalized) slot,
 * invisible to the cap and the queue) with `{}` where the answers will go, and
 * the token is minted through the same cooldown. By the time the person
 * presses Submit, the link is already in their inbox — and if they clicked it
 * on the way, the submit lands in one round trip instead of two.
 *
 * ── A browser that already holds a live link ───────────────────────────────
 * No mail either — for THAT BROWSER. One live link per address per fill is the
 * policy, and `heldTokenId` is how a caller shows this fill is the one we
 * already mailed: tabbing back past the address field, or submitting after
 * typing it, points at the link in the inbox rather than adding to it, however
 * long the form takes. A browser that presents nothing is one that cannot
 * reach that link — tomorrow's page load, a phone, a cleared cookie jar — and
 * it is mailed, because being told to check an inbox for a link you can no
 * longer find is the failure this used to have. See `findLiveLink`. `force` is
 * the one way past it regardless.
 *
 * ── An address that has already responded ──────────────────────────────────
 * No mail. Somebody typing their address into a form they filled in last week
 * should not be mailed for it, and a stranger typing SOMEBODY ELSE'S address
 * certainly should not be able to. They are not stuck: submitting still mails
 * the edit link exactly as it does today, and the check-email screen's resend
 * button is the "unless they ask" door.
 *
 * The RESULT IS INDISTINGUISHABLE either way — same shape, same rendered line,
 * no timing difference worth a probe. `sent` exists for the server log and the
 * tests; a route that branched on it would rebuild the membership oracle by
 * hand.
 *
 * @throws MAGIC_LINK_COOLDOWN, FORM_NOT_OPEN, FORM_CLOSED, FORM_REVISION_STALE,
 *   FORM_ACCESS_MISMATCH.
 */
export async function beginAddressVerification({
  formId,
  email,
  name,
  revisionId,
  force = false,
  heldTokenId,
}: {
  formId: string;
  email: string;
  name?: string | null;
  revisionId: string;
  /**
   * The link this browser can show it already received for this response — the
   * watch cookie's id, forwarded by the fill route. See `findLiveLink`. The
   * resend button passes none: it is `force` anyway, and a person telling us
   * the first link did not arrive must never be answered with it.
   */
  heldTokenId?: string | null;
  /**
   * Send even for an address that has already responded.
   *
   * The "unless they ask" door, and the ONLY caller is the check-email screen's
   * resend button — a person who is looking at "we sent a link to this address"
   * and telling us it did not arrive. It mints an edit link for a submitted
   * response, which is exactly what re-submitting the form already does today,
   * so it opens no path that was not open before. Everything that guards the
   * unforced call still applies: origin, honeypot, the per-client ceiling, and
   * the per-address cooldown.
   */
  force?: boolean;
}): Promise<AddressVerificationResult> {
  const emailNormalized = normalizeEmail(email);
  const { form: loadedForm } = await validateAgainstRevision({
    formId,
    revisionId,
    // Nothing to validate: this path exists precisely because the answers do
    // not exist yet. The submit still validates the whole set against the
    // revision it names.
    answers: undefined,
    expectedAccess: 'PUBLIC',
  });

  const now = new Date();

  return getPrisma().$transaction(async tx => {
    const form = await lockForm(tx, formId);
    assertAccepting(form, now);
    assertRevisionCurrent(form, revisionId);

    const existing = await tx.formResponse.findFirst({
      where: { form_id: formId, user_id: null, email_normalized: emailNormalized },
      select: { id: true, submission_state: true, verified_at: true },
    });

    /**
     * Already verified — nothing to prove, so nothing to send.
     *
     * Two rows land here and both are right to skip. One has already responded:
     * mailing somebody because a stranger typed their address is the behaviour
     * this whole flow exists to avoid. The other verified their address earlier
     * in this very session and has come back to the form; a second identical
     * link is noise, and the browser has the first one anyway.
     *
     * `force` is the check-email screen's resend button, which is the person
     * themselves asking.
     */
    if (existing && existing.verified_at !== null && !force) {
      return { emails: [], verifyUrl: null, sent: false, watchTokenId: null };
    }

    const responseId =
      existing?.id ??
      (
        await tx.formResponse.create({
          data: {
            form_id: formId,
            revision_id: revisionId,
            user_id: null,
            email: email.trim(),
            email_normalized: emailNormalized,
            name: name ?? null,
            answers: {},
            submission_state: 'PENDING_VERIFICATION',
            submitted_at: now,
          },
          select: { id: true },
        })
      ).id;

    /**
     * This browser already holds a live link for this response — nothing sent.
     *
     * The same rule the submit follows, and here it is what keeps one fill down
     * to one mail: without it, tabbing back through the email field, or the
     * blur that fires on the way to Submit, would mint a link every time and
     * three passes would leave the resend button refused for an hour. `force`
     * skips it, because a resend is the person on the screen telling us the
     * first one did not arrive.
     */
    if (!force) {
      const live = await findLiveLink(tx, responseId, heldTokenId, now);
      // No mail — but the outstanding send is the one worth watching, so its id
      // goes back rather than nothing. Without this, reloading the form and
      // re-typing the same address would swap a live bounce watch for a dead
      // one and a real bounce would never reach the page.
      if (live) return { emails: [], verifyUrl: null, sent: false, watchTokenId: live.id };
    }

    const { raw, tokenId } = await mintLinkFor(tx, responseId, form, now);
    const verifyUrl = verifyUrlFor({
      classroomSlug: loadedForm.classroom.slug,
      formSlug: loadedForm.slug,
      rawToken: raw,
    });

    return {
      emails: [
        composeLinkEmail({
          to: email.trim(),
          name,
          formTitle: loadedForm.title,
          classroomName: loadedForm.classroom.name,
          verifyUrl,
          template: 'form-verify-link',
          formMagicTokenId: tokenId,
        }),
      ],
      verifyUrl,
      sent: true,
      watchTokenId: tokenId,
    };
  });
}

// ─── Public submission: verify + confirm ────────────────────────────────────

/**
 * Resolve a raw magic-link token to the response it opens, for the
 * review-and-confirm page. Read-only: the token is NOT consumed here, so a
 * reload of the review page does not burn the link.
 *
 * Returns the response, its form, and the revision it was filled against —
 * everything the review page renders. The staff-only columns are excluded: the
 * filler must never see staff_status or staff_note on any surface.
 *
 * @throws MAGIC_LINK_INVALID, MAGIC_LINK_EXPIRED, MAGIC_LINK_USED.
 */
export async function verifyMagicToken(rawToken: string) {
  const token = await getPrisma().formMagicToken.findUnique({
    where: { token_hash: hashToken(rawToken) },
    include: {
      response: {
        select: {
          id: true,
          form_id: true,
          revision_id: true,
          email: true,
          name: true,
          answers: true,
          resolved_context: true,
          submission_state: true,
          verified_at: true,
          submitted_at: true,
          form: true,
          revision: true,
        },
      },
    },
  });

  if (!token) throw serviceError(MAGIC_LINK_INVALID, 'This link is not valid.');
  if (token.used_at) {
    throw serviceError(MAGIC_LINK_USED, 'This link has already been used. Request a new one.');
  }
  if (token.expires_at.getTime() <= Date.now()) {
    throw serviceError(MAGIC_LINK_EXPIRED, 'This link has expired. Request a new one.');
  }

  const { form, revision, ...response } = token.response;
  return { tokenId: token.id, expiresAt: token.expires_at, response, form, revision };
}

/**
 * Has this response been submitted, or is it only an address waiting for one?
 *
 * The distinction the verify page turns on: a link opened before the form was
 * finished must show "your email is verified, go and finish" — never an empty
 * answer set dressed up as a submission.
 */
export const isAddressPlaceholder = (response: {
  submission_state: SubmissionState;
  answers: unknown;
}): boolean =>
  response.submission_state === 'PENDING_VERIFICATION' && answersAreEmpty(response.answers);

/**
 * Consume a magic link and commit the response.
 *
 * One transaction does all of it: burn the token, optionally replace the
 * answers, set verified_at, and flip to SUBMITTED — with the cap checked under
 * the form's row lock so N concurrent confirmations against a cap of N-1 cannot
 * all pass.
 *
 * Two details that are easy to get wrong:
 *  - `verified_at` is set only the FIRST time. A later edit via a fresh link
 *    keeps the original timestamp, so editing an answer never costs the filler
 *    their place in a FIFO waitlist.
 *  - the cap is checked only on that first transition. An already-verified
 *    response editing itself must not be bounced by a cap it is already inside.
 *
 * @throws MAGIC_LINK_*, FORM_CAP_REACHED, FORM_NOT_OPEN, FORM_CLOSED, and the
 *   contract's answer-validation codes. On any of these the transaction rolls
 *   back, so the token stays unused and the response stays as it was.
 */
export async function confirmSubmission(rawToken: string, { answers }: { answers?: unknown } = {}) {
  const tokenHash = hashToken(rawToken);

  // Read the token unlocked, only to learn which form to lock. The authoritative
  // re-read happens under both locks below.
  const peek = await getPrisma().formMagicToken.findUnique({
    where: { token_hash: tokenHash },
    select: { response: { select: { form_id: true } } },
  });
  if (!peek) throw serviceError(MAGIC_LINK_INVALID, 'This link is not valid.');

  const now = new Date();

  return getPrisma().$transaction(async tx => {
    // Lock order: form, then token. Every writer here does the same.
    const lockedForm = await lockForm(tx, peek.response.form_id);

    await tx.$queryRaw`SELECT id FROM form_magic_tokens WHERE token_hash = ${tokenHash} FOR UPDATE`;

    const token = await tx.formMagicToken.findUnique({
      where: { token_hash: tokenHash },
      include: { response: true },
    });
    if (!token) throw serviceError(MAGIC_LINK_INVALID, 'This link is not valid.');
    if (token.used_at) {
      throw serviceError(MAGIC_LINK_USED, 'This link has already been used. Request a new one.');
    }
    if (token.expires_at.getTime() <= now.getTime()) {
      throw serviceError(MAGIC_LINK_EXPIRED, 'This link has expired. Request a new one.');
    }

    const response = token.response;
    const counted = alreadyCounted(response);

    /**
     * Nothing to confirm.
     *
     * A link minted when the ADDRESS was typed opens a row with `{}` for
     * answers. Confirming it would file an empty response — and, worse, take a
     * cap slot with it. The verify page renders the "go and finish" state for
     * exactly this row rather than a Confirm button, so reaching here means a
     * hand-made POST; it is refused with a code the route can explain.
     */
    if (!counted && answers === undefined && answersAreEmpty(response.answers)) {
      throw serviceError(
        FORM_NOT_SUBMITTED_YET,
        'This response has no answers yet — finish the form and submit it.'
      );
    }

    // Confirming a first submission requires the form to still be accepting.
    // Editing a response that is already inside the cap does not — a closed
    // form should not strand someone mid-edit.
    //
    // `counted`, not `verified_at !== null`: since an address can be verified
    // before the answers exist, a row can carry `verified_at` and still never
    // have taken a slot. See `alreadyCounted`.
    if (!counted) {
      assertAccepting(lockedForm, now);
      await assertCapAvailable(tx, lockedForm, { excludeResponseId: response.id });
    }

    const data: Prisma.FormResponseUncheckedUpdateInput = {
      submission_state: 'SUBMITTED',
      verified_at: response.verified_at ?? now,
    };

    // Answers arriving on a row that had none is a FIRST submission, whatever
    // the row's age: its FIFO position is now, not when the address was typed.
    if (!counted && answers !== undefined && answersAreEmpty(response.answers)) {
      data.submitted_at = now;
    }

    if (answers !== undefined) {
      const revision = await tx.formRevision.findUnique({ where: { id: response.revision_id } });
      if (!revision) throw serviceError(FORM_REVISION_STALE, 'Unknown form revision.');
      const fields = fieldsOf(revision.fields);
      // No `resolved` context is passed, and none is needed: repeat_group is a
      // CLASSROOM-only type (formContract's registry enforces that at save), and
      // this path only ever runs for a PUBLIC form's magic link. Asserted rather
      // than assumed — if that invariant ever changes, this fails loudly here
      // instead of throwing FORM_REPEAT_CONTEXT_MISSING from inside zod.
      if (requiresResolvedContext(fields)) {
        throw serviceError(
          FORM_ACCESS_MISMATCH,
          'This form has per-respondent fields and cannot be confirmed through the public magic-link path.'
        );
      }
      data.answers = parseAnswers(fields, answers) as unknown as Prisma.InputJsonValue;
    }

    // The token is left exactly as it is: not spent, not extended. It was
    // minted with the form's life already on it, so there is nothing here that
    // needs to change for it to keep opening this response.
    const updated = await tx.formResponse.update({ where: { id: response.id }, data });
    return { response: updated, firstVerification: !counted };
  });
}

/**
 * Mark the ADDRESS behind a pre-submit link as proven, and leave the link alive.
 *
 * This is what clicking the emailed link does when the person has not submitted
 * anything yet: it sets `verified_at` on a row that is still an empty
 * placeholder, so the submit that follows can be recorded in ONE round trip
 * instead of sending them back to their inbox a second time.
 *
 * ── Idempotent, and NOT a consumption ──────────────────────────────────────
 * Corporate mail scanners and link prefetchers open links before a human does.
 * If this burned the token, the person's own click would land on "already
 * used"; if it were not idempotent, a reload would. So it does neither: the
 * token stays usable, and a second call is a no-op that returns the same
 * answer.
 *
 * Letting a scanner set `verified_at` grants a scanner nothing. `verified_at`
 * on its own never admits a submission — the submit path additionally requires
 * possession of the token itself (see `submitVerifiedPublic`), which only
 * something that read the mailbox can have.
 *
 * @throws MAGIC_LINK_INVALID, MAGIC_LINK_EXPIRED, MAGIC_LINK_USED.
 */
export async function verifyAddressByToken(rawToken: string, now: Date = new Date()) {
  const tokenHash = hashToken(rawToken);

  const token = await getPrisma().formMagicToken.findUnique({
    where: { token_hash: tokenHash },
    include: { response: { select: { id: true, verified_at: true } } },
  });

  if (!token) throw serviceError(MAGIC_LINK_INVALID, 'This link is not valid.');
  if (token.used_at) {
    throw serviceError(MAGIC_LINK_USED, 'This link has already been used. Request a new one.');
  }
  if (token.expires_at.getTime() <= now.getTime()) {
    throw serviceError(MAGIC_LINK_EXPIRED, 'This link has expired. Request a new one.');
  }

  if (token.response.verified_at) {
    return { responseId: token.response.id, verifiedAt: token.response.verified_at };
  }

  const updated = await getPrisma().formResponse.update({
    where: { id: token.response.id },
    data: { verified_at: now },
    select: { id: true, verified_at: true },
  });
  return { responseId: updated.id, verifiedAt: updated.verified_at! };
}

/**
 * Record a public submission in ONE round trip, for somebody who has already
 * proved they own the address they are submitting under.
 *
 * ── The binding, and why it cannot be claimed ──────────────────────────────
 * The caller offers a raw magic token (from the HttpOnly, form-scoped cookie
 * the verify page set when the link was opened in this browser). Four things
 * must line up before a single answer is written, and every one of them is
 * read from the SERVER's side of the wire:
 *
 *   1. the token hashes to a live row — unspent, unexpired;
 *   2. its response belongs to THIS form;
 *   3. its response has `verified_at` — the link was actually opened;
 *   4. `email_normalized` on that response EQUALS the normalised address being
 *      submitted.
 *
 * (4) is the binding requirement. Verification is a property of the
 * (form, address) row, and the row is found from the TOKEN, not from the body
 * — so a client that types a different address in the form does not inherit
 * anything: the addresses simply fail to match and the whole request falls back
 * to the ordinary check-your-email flow. There is no "I am verified" flag to
 * forge, no id to swap, and no signature to strip; the credential is the same
 * 256-bit token that was delivered to the mailbox, and it is checked against a
 * hash the database holds.
 *
 * Anything that does not line up throws MAGIC_LINK_NOT_BOUND, which the route
 * treats as "no shortcut available" rather than as an error. A stale cookie
 * must never be able to make a legitimate submission fail.
 *
 * The token SURVIVES here, and its life is extended to the form's — see
 * `editLinkExpiresAt`. It used to be spent at this line, inherited from the
 * flow where the link's only job was confirming one submission. Verification
 * moved to blur time, which quietly gave the link a second job — being the
 * handle on the response — and spending it cut that job off at the exact
 * moment the response became worth returning to. Nothing was protected by the
 * spend that the pre-submit behaviour did not already allow: the link is
 * openable as many times as you like while you are still filling the form in,
 * so "whoever holds this mail can open this response" was always the model.
 *
 * @throws MAGIC_LINK_NOT_BOUND, FORM_CAP_REACHED, FORM_NOT_OPEN, FORM_CLOSED,
 *   FORM_REVISION_STALE, FORM_ACCESS_MISMATCH, and the contract's
 *   answer-validation codes.
 */
export async function submitVerifiedPublic({
  rawToken,
  formId,
  email,
  name,
  answers,
  revisionId,
}: {
  rawToken: string;
  formId: string;
  email: string;
  name?: string | null;
  answers: unknown;
  revisionId: string;
}) {
  const emailNormalized = normalizeEmail(email);
  const tokenHash = hashToken(rawToken);

  // Cheap disqualification before anything is validated or locked: a cookie
  // from another form, or one that no longer names a token, is the common case
  // and must cost nothing.
  const peek = await getPrisma().formMagicToken.findUnique({
    where: { token_hash: tokenHash },
    select: { response: { select: { form_id: true, email_normalized: true } } },
  });
  if (
    !peek ||
    peek.response.form_id !== formId ||
    peek.response.email_normalized !== emailNormalized
  ) {
    throw serviceError(MAGIC_LINK_NOT_BOUND, 'This browser has no verified link for that address.');
  }

  const { validated } = await validateAgainstRevision({
    formId,
    revisionId,
    answers,
    expectedAccess: 'PUBLIC',
  });

  const now = new Date();

  return getPrisma().$transaction(async tx => {
    // Lock order: form, then token. Identical to `confirmSubmission`, which is
    // what keeps two writers racing the same response from deadlocking.
    const lockedForm = await lockForm(tx, formId);
    await tx.$queryRaw`SELECT id FROM form_magic_tokens WHERE token_hash = ${tokenHash} FOR UPDATE`;

    const token = await tx.formMagicToken.findUnique({
      where: { token_hash: tokenHash },
      include: { response: true },
    });

    const response = token?.response;
    if (
      !token ||
      !response ||
      token.used_at ||
      token.expires_at.getTime() <= now.getTime() ||
      response.form_id !== formId ||
      response.email_normalized !== emailNormalized ||
      response.verified_at === null
    ) {
      throw serviceError(
        MAGIC_LINK_NOT_BOUND,
        'This browser has no verified link for that address.'
      );
    }

    assertRevisionCurrent(lockedForm, revisionId);

    const counted = alreadyCounted(response);
    if (!counted) {
      assertAccepting(lockedForm, now);
      await assertCapAvailable(tx, lockedForm, { excludeResponseId: response.id });
    }

    // Token untouched, exactly as in `confirmSubmission`.
    return tx.formResponse.update({
      where: { id: response.id },
      data: {
        revision_id: revisionId,
        email: email.trim(),
        name: name ?? null,
        answers: validated as unknown as Prisma.InputJsonValue,
        submission_state: 'SUBMITTED',
        verified_at: response.verified_at,
        // An edit of a response that is already counted keeps its place in the
        // queue; a first submission takes its place now.
        ...(counted ? {} : { submitted_at: now }),
      },
    });
  });
}

// ─── Classroom submission ───────────────────────────────────────────────────

/**
 * Submit a CLASSROOM form. Identity comes from the session, so there is no
 * verification round trip: the row is SUBMITTED with verified_at set
 * immediately, and counts against the cap at once.
 *
 * `userId` and `email` MUST come from the caller's session — never from the
 * request body. The partial unique index on (form_id, user_id) makes one row
 * per person; `allow_multiple` decides whether a second submit REPLACES that
 * row (the "resubmit until close" team-bidding case) or is refused.
 */
export async function submitClassroom({
  formId,
  userId,
  email,
  name,
  answers,
  revisionId,
  renderedTargets,
}: {
  formId: string;
  userId: string;
  email: string;
  name?: string | null;
  answers: unknown;
  revisionId: string;
  /**
   * Per repeat group, the target ids the BROWSER says it rendered. Untrusted —
   * see `newTargetsSince`. Used only to decide whether a changed team earns a
   * "your team changed" notice instead of a validation error. The set the
   * answers are actually validated against is re-resolved here, under the lock.
   */
  renderedTargets?: Record<string, string[]>;
}) {
  // Pre-flight, outside the transaction: the access mode and a clean staleness
  // error before any lock is taken. Everything it decides is decided AGAIN
  // under the row lock below, which is what actually makes it safe.
  const preflight = await getPrisma().form.findUnique({
    where: { id: formId },
    select: { id: true, access: true, classroom_id: true, current_revision_id: true },
  });
  if (!preflight) throw serviceError(FORM_NOT_FOUND, `Form ${formId} not found`);
  if (preflight.access !== 'CLASSROOM') {
    throw serviceError(
      FORM_ACCESS_MISMATCH,
      `This form is ${preflight.access} — it cannot be submitted through the CLASSROOM path.`
    );
  }
  if (preflight.current_revision_id !== revisionId) {
    throw serviceError(
      FORM_REVISION_STALE,
      'This form changed while you were filling it in — reload to see the current version.'
    );
  }

  const now = new Date();

  return getPrisma().$transaction(async tx => {
    const form = await lockForm(tx, formId);
    assertAccepting(form, now);
    assertRevisionCurrent(form, revisionId);

    const revision = await tx.formRevision.findUnique({ where: { id: revisionId } });
    if (!revision || revision.form_id !== formId) {
      throw serviceError(FORM_REVISION_STALE, 'Unknown form revision.');
    }
    const fields = fieldsOf(revision.fields);

    const existing = await tx.formResponse.findFirst({
      where: { form_id: formId, user_id: userId },
    });

    /**
     * ── Tier-2 re-resolution, under the lock ────────────────────────────────
     *
     * The teammates are resolved HERE, not taken from the caller, and not taken
     * from the request. Between the page load and this click somebody may have
     * joined the team or left it, and each of those needs a different answer:
     *
     *  - JOINED  → refuse with FORM_TEAM_CHANGED. `require_all_targets` is a
     *    promise about a whole team; silently recording a set that misses its
     *    newest member would break it without telling anyone.
     *  - LEFT    → keep the review. The answers stay, the snapshot marks the
     *    person `removed`, and the schema stops requiring anything of them.
     *
     * The set a departed target may be drawn from is this response's OWN
     * server-written snapshot — never the request body — so "they left" cannot
     * be claimed as a way to file a review of somebody who was never on the
     * team.
     */
    let resolutions: Record<string, RepeatResolution> = {};
    let resolved: Record<string, ResolvedTargetRef[]> | undefined;
    let snapshot: Prisma.InputJsonValue | undefined;

    if (requiresResolvedContext(fields)) {
      resolutions = await resolveRepeatGroups({
        classroomId: preflight.classroom_id,
        userId,
        fields,
        client: tx,
      });

      // NO_TEAM / TEAM_UNTAGGED / AMBIGUOUS_TEAM never render a fillable block,
      // so reaching here means a crafted request. Refused explicitly rather
      // than left to the schema: an unresolved group has an EMPTY target set,
      // which `.strict()` would accept as "no reviews written" and file as a
      // real submission of a peer review nobody could have filled in.
      const unresolved = Object.entries(resolutions).filter(([, resolution]) =>
        isBlockingRepeatState(resolution.state)
      );
      if (unresolved.length > 0) {
        throw serviceError(
          FORM_TEAM_UNRESOLVED,
          'This form reviews your teammates, and your team could not be resolved.'
        );
      }

      const changed = newTargetsSince(resolutions, renderedTargets);
      if (changed.length > 0) {
        throw serviceError(
          FORM_TEAM_CHANGED,
          'Your team changed while you were filling this in — reload to see everyone you need to review.'
        );
      }

      resolved = schemaContextFor({ resolutions, previous: existing?.resolved_context });
      snapshot = buildResolvedContext({
        resolutions,
        previous: existing?.resolved_context,
        resolvedAt: now,
      }) as unknown as Prisma.InputJsonValue;
    }

    const validated = parseAnswers(fields, answers, { resolved });

    if (existing && existing.submission_state === 'SUBMITTED' && !form.allow_multiple) {
      throw serviceError(FORM_ALREADY_SUBMITTED, 'You have already responded to this form.');
    }

    // Only a row that is not already counted needs a cap slot. No `before`:
    // a classroom submission verifies in this same transaction, so there is no
    // unverified queue for it to be ranked against.
    if (!existing || !alreadyCounted(existing)) {
      await assertCapAvailable(tx, form, { excludeResponseId: existing?.id });
    }

    const data = {
      revision_id: revisionId,
      email: email.trim(),
      email_normalized: normalizeEmail(email),
      name: name ?? null,
      answers: validated as unknown as Prisma.InputJsonValue,
      submission_state: 'SUBMITTED' as SubmissionState,
      verified_at: existing?.verified_at ?? now,
      ...(snapshot ? { resolved_context: snapshot } : {}),
    };

    if (existing) {
      return tx.formResponse.update({ where: { id: existing.id }, data });
    }
    return tx.formResponse.create({
      data: { form_id: formId, user_id: userId, ...data },
    });
  });
}

// ─── Drafts (server-side autosave) ──────────────────────────────────────────

/**
 * Create or update the server-side partial for one filler.
 *
 * Answers are NOT validated against the contract — a partial by definition
 * fails the required-field rules — but the byte cap still applies, because an
 * autosave endpoint is the easiest thing on the form to abuse. Validation
 * happens at submit.
 *
 * Keyed by `userId` (classroom fills, and public fills after verification) or by
 * `draftToken` (anonymous fills, only when the form's `save_partials` is on and
 * the on-form disclosure is shown).
 *
 * ── A draft may only ever overwrite a draft ────────────────────────────────
 * A row that has been SUBMITTED or is PENDING_VERIFICATION is not written at
 * all — not its state, and not its answers. Preserving only the STATE would be
 * the more obvious rule and is not enough: it would leave a row marked
 * SUBMITTED holding a half-typed answer set, which is worse than either honest
 * outcome.
 *
 * The guard is in the `where` clause of the update, not in an `if` above it,
 * because the caller's check is a read and the write is a separate statement. A
 * debounced autosave in flight while its own form is being submitted lands
 * BETWEEN them, and only the database can decide that race. The caller's cheap
 * check still runs — this is what makes it unnecessary to be right.
 */
export async function upsertDraft({
  formId,
  revisionId,
  userId = null,
  draftToken = null,
  email,
  name,
  answers,
  classroomId,
}: {
  formId: string;
  revisionId: string;
  userId?: string | null;
  draftToken?: string | null;
  email: string;
  name?: string | null;
  answers: unknown;
  /**
   * Set on a CLASSROOM draft. When the revision has repeat groups the draft
   * carries a `resolved_context` snapshot too, MERGED with whatever the row
   * already held — see below.
   */
  classroomId?: string;
}) {
  if (!userId && !draftToken) {
    throw serviceError(
      FORM_RESPONSE_NOT_FOUND,
      'A draft needs either a session user or a draft token.'
    );
  }

  const bytes = answersByteSize(answers);
  if (bytes > FORM_LIMITS.MAX_ANSWERS_BYTES) {
    throw serviceError(
      FORM_ANSWERS_TOO_LARGE,
      `Draft is ${bytes} bytes; the limit is ${FORM_LIMITS.MAX_ANSWERS_BYTES}.`
    );
  }

  const form = await getPrisma().form.findUnique({
    where: { id: formId },
    select: { id: true, save_partials: true },
  });
  if (!form) throw serviceError(FORM_NOT_FOUND, `Form ${formId} not found`);
  if (!userId && !form.save_partials) {
    throw serviceError(
      FORM_PARTIALS_DISABLED,
      'Server-side partial saves are off for this form — the draft stays in the browser.'
    );
  }

  const existing = await getPrisma().formResponse.findFirst({
    where: userId
      ? { form_id: formId, user_id: userId }
      : { form_id: formId, draft_token: draftToken },
  });

  /**
   * The draft's teammate snapshot.
   *
   * A draft is the ONLY server-written record that a departed teammate was ever
   * a teammate: submit reads it to decide which reviews may be kept as
   * `removed`, and without it a teammate who leaves mid-fill takes their review
   * with them (the answer key becomes unknown and `.strict()` refuses it).
   *
   * MERGED, never replaced — `buildResolvedContext` unions the fresh resolution
   * with what the row already held. An autosave landing the moment after
   * somebody left must not erase the evidence it exists to preserve.
   */
  let snapshot: Prisma.InputJsonValue | undefined;
  if (userId && classroomId) {
    const revision = await getPrisma().formRevision.findUnique({ where: { id: revisionId } });
    const fields = revision && revision.form_id === formId ? fieldsOf(revision.fields) : [];
    if (requiresResolvedContext(fields)) {
      const resolutions = await resolveRepeatGroups({ classroomId, userId, fields });
      snapshot = buildResolvedContext({
        resolutions,
        previous: existing?.resolved_context,
        resolvedAt: new Date(),
      }) as unknown as Prisma.InputJsonValue;
    }
  }

  const payload = {
    revision_id: revisionId,
    email: email.trim(),
    email_normalized: normalizeEmail(email),
    name: name ?? null,
    answers: (answers ?? {}) as Prisma.InputJsonValue,
    ...(snapshot ? { resolved_context: snapshot } : {}),
  };

  if (existing) {
    // `updateMany` rather than `update`, only so the state can be part of the
    // WHERE. A no-op means the row stopped being a draft while this save was in
    // flight; the row is returned unchanged, and the caller is told nothing,
    // because a dropped autosave is not something a filler can act on.
    const { count } = await getPrisma().formResponse.updateMany({
      where: { id: existing.id, submission_state: 'DRAFT' },
      data: payload,
    });
    if (count === 0) return existing;
    return getPrisma().formResponse.findUniqueOrThrow({ where: { id: existing.id } });
  }

  return getPrisma().formResponse.create({
    data: {
      form_id: formId,
      user_id: userId,
      draft_token: userId ? null : draftToken,
      submission_state: 'DRAFT',
      ...payload,
    },
  });
}

// ─── Self reads ─────────────────────────────────────────────────────────────

/** Columns a filler may see about their own response. Staff columns excluded. */
const SELF_SELECT = {
  id: true,
  form_id: true,
  revision_id: true,
  user_id: true,
  email: true,
  name: true,
  answers: true,
  resolved_context: true,
  submission_state: true,
  verified_at: true,
  submitted_at: true,
  updated_at: true,
} satisfies Prisma.FormResponseSelect;

/**
 * The caller's OWN response to a form, or null.
 *
 * ROUTES MUST PASS SESSION IDENTITY. `userId` has to come from the
 * authenticated session — never from a route param, a query string, or a form
 * field. This function does exactly what it is told, so a client-supplied
 * userId turns it into a response-enumeration endpoint.
 *
 * Staff columns (staff_status, staff_note) are not selected: they are invisible
 * to the filler on every surface, including the magic-link review page.
 */
export async function findOwnResponse(formId: string, userId: string) {
  return getPrisma().formResponse.findFirst({
    where: { form_id: formId, user_id: userId },
    select: SELF_SELECT,
  });
}

/**
 * An anonymous filler's own partial, by the opaque draft-token cookie.
 *
 * Same rule as findOwnResponse: the token is the bearer credential, so it must
 * come from the signed cookie the server set, never from a URL.
 */
export async function findOwnResponseByDraftToken(formId: string, draftToken: string) {
  return getPrisma().formResponse.findFirst({
    where: { form_id: formId, draft_token: draftToken },
    select: SELF_SELECT,
  });
}

// ─── Staff reads and triage ─────────────────────────────────────────────────

export interface ListResponsesFilters {
  submissionState?: SubmissionState | SubmissionState[];
  /** null matches rows with no label set. */
  staffStatus?: string | null;
  /** Substring match on name or email. */
  search?: string;
  take?: number;
  skip?: number;
}

/**
 * The columns a staff read of a response returns — and, by omission, the two it
 * never does.
 *
 * `draft_token` is a BEARER CREDENTIAL: it is the cookie value that resumes an
 * anonymous half-filled form, so anything holding it can open somebody else's
 * partial submission. `email_normalized` is the identity key behind the partial
 * unique index; the as-typed `email` beside it is the one a human should read,
 * and shipping both invites a caller to key on the wrong one.
 *
 * Both were previously excluded by DISCIPLINE — every consumer hand-wrote an
 * allowlist on the way out (the web's `toResponseRow`, the MCP's
 * `responseSummary`), and each of those is one forgotten field from a leak on a
 * surface nobody was thinking about. This makes the exclusion a property of the
 * QUERY: a new consumer cannot echo a column the row does not carry.
 *
 * Listed positively rather than with `omit` so that adding a column to the
 * schema is a decision made here, not a default that ships.
 */
const RESPONSE_SELECT = {
  id: true,
  form_id: true,
  revision_id: true,
  user_id: true,
  email: true,
  name: true,
  answers: true,
  resolved_context: true,
  submission_state: true,
  verified_at: true,
  staff_status: true,
  staff_note: true,
  submitted_at: true,
  created_at: true,
  updated_at: true,
  /**
   * The most recent send's delivery outcome — STAFF ONLY, and the answer to the
   * question an unverified row otherwise cannot answer.
   *
   * An unverified response looks identical whether the person changed their
   * mind or never received the link, and those want opposite responses from a
   * course. Only the provider knows which, and this is where it lands.
   *
   * Newest first, take 1: earlier tokens for the same response are superseded
   * (a resend, a reminder), and the current state of the LATEST send is what
   * describes the situation now.
   */
  tokens: {
    select: { delivery_state: true, delivery_detail: true, created_at: true },
    orderBy: { created_at: 'desc' as const },
    take: 1,
  },
} satisfies Prisma.FormResponseSelect;

/**
 * Every response to a form, staff columns included.
 *
 * STAFF ONLY, by contract. This is the ONLY read path that returns rows
 * belonging to other people; every route that calls it must have passed
 * requireClassroomTeachingTeam (or the MCP equivalent) and must have confirmed
 * the form belongs to that classroom. Never reachable from a student or public
 * route.
 *
 * Ordered by submitted_at ascending — FIFO, which is the order a waitlist is
 * worked and the order the cap was filled.
 */
export async function listByFormId(formId: string, filters: ListResponsesFilters = {}) {
  const where: Prisma.FormResponseWhereInput = { form_id: formId };

  if (filters.submissionState) {
    where.submission_state = Array.isArray(filters.submissionState)
      ? { in: filters.submissionState }
      : filters.submissionState;
  }
  if (filters.staffStatus !== undefined) {
    where.staff_status = filters.staffStatus;
  }
  if (filters.search) {
    where.OR = [
      { name: { contains: filters.search, mode: 'insensitive' } },
      { email: { contains: filters.search, mode: 'insensitive' } },
    ];
  }

  return getPrisma().formResponse.findMany({
    where,
    select: RESPONSE_SELECT,
    orderBy: { submitted_at: 'asc' },
    ...(filters.take === undefined ? {} : { take: filters.take }),
    ...(filters.skip === undefined ? {} : { skip: filters.skip }),
  });
}

/**
 * Set the staff-only triage label and note on one response.
 *
 * Both are free text with no enum behind them — the workflow a course runs
 * ("responded to", "on roster", "not eligible") is the course's business, and
 * the suggestions in the UI come from the labels already used on the same form.
 * Passing null clears a field; omitting it leaves it alone.
 */
export async function updateStaff({
  responseId,
  staff_status,
  staff_note,
}: {
  responseId: string;
  staff_status?: string | null;
  staff_note?: string | null;
}) {
  const data: Prisma.FormResponseUncheckedUpdateInput = {};
  if (staff_status !== undefined) {
    data.staff_status = staff_status === null ? null : staff_status.trim() || null;
  }
  if (staff_note !== undefined) {
    data.staff_note = staff_note === null ? null : staff_note.trim() || null;
  }
  return getPrisma().formResponse.update({ where: { id: responseId }, data });
}

/**
 * The staff_status labels already in use on a form, most-used first — the
 * autocomplete behind the inline status chip, and the source of the per-label
 * count tiles on the responses page.
 */
export async function statusLabelSuggestions(formId: string) {
  const rows = await getPrisma().formResponse.groupBy({
    by: ['staff_status'],
    where: { form_id: formId, staff_status: { not: null } },
    _count: { _all: true },
  });
  return rows
    .map(row => ({ label: row.staff_status as string, count: row._count._all }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Delete one response and its magic tokens (cascade). Callers must audit-log. */
export async function deleteResponse(responseId: string) {
  return getPrisma().formResponse.delete({ where: { id: responseId } });
}

// ─── Expiry sweep ───────────────────────────────────────────────────────────
