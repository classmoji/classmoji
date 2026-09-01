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

/** How long a verify/edit link stays usable. */
export const MAGIC_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;
/**
 * Links per response inside the rolling window.
 *
 * THREE, and it stayed three because an honest interaction costs ONE link.
 *
 * It briefly went to five, when moving the verification mail to blur time made
 * an ordinary journey cost two — typing the address minted one, submitting
 * minted another — and three then refused somebody their second attempt inside
 * the hour. Reuse (see `MAGIC_TOKEN_REUSE_MS`) removed the second link instead
 * of paying for it, so the reason for the loosening is gone and the ceiling on
 * what one mailbox can be sent goes back to where it was. Three now buys the
 * link itself plus two resends the person explicitly asked for, which is more
 * headroom than five bought when every step minted.
 *
 * The per-CLIENT limit in the pages app is the primary defence against a mail
 * relay; this one bounds what can be aimed at a single mailbox.
 */
export const MAGIC_TOKEN_MAX_PER_WINDOW = 3;
export const MAGIC_TOKEN_WINDOW_MS = 60 * 60 * 1000;
/**
 * How recently a link must have been minted for the next send to REUSE it
 * rather than mint a second one.
 *
 * ── Why there is a reuse rule at all ───────────────────────────────────────
 * Typing an address mints a link, and submitting used to mint another. Two
 * mails for one action reads as broken to the person receiving them, and the
 * second makes the first ambiguous: which one do I click? Both worked, so it
 * was never incorrect — just noisy, and noisy on the one surface where a
 * stranger can make us send mail. The link is already in their inbox; the right
 * thing to do with it is point at it.
 *
 * ── Why HALF the token's life ──────────────────────────────────────────────
 * A link's usefulness is bounded by its 48-hour life, not by minutes: somebody
 * filling in a long form, or coming back to it after lunch, should be told
 * about the link they already have rather than handed a second one. But a link
 * minted 47 hours ago is about to die, and reusing THAT would strand them. One
 * constant settles both: reuse only inside the first half of the life, and the
 * link handed back always has at least another 24 hours on it.
 *
 * A link is reusable only while it is also unspent and unexpired — see
 * `findLiveLink`. Anything else mints fresh, so nobody is ever left with no
 * live link at all.
 */
export const MAGIC_TOKEN_REUSE_MS = MAGIC_TOKEN_TTL_MS / 2;
/** Abandoned server-side partials are swept after this long. */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How long an unverified row survives.
 *
 * ── Why this is no longer the link's TTL ───────────────────────────────────
 * It used to be 48h, exactly as long as the link that would verify it, on the
 * reasoning that a row nobody can verify any more is only holding a
 * (form_id, email_normalized) slot hostage. That reasoning had a cost nobody
 * was paying attention to: the instructor never learned that somebody tried.
 * A waitlist that quietly deletes half its applicants is worse than one that
 * shows them as unverified, and "did anybody bounce off the confirmation
 * step?" is a question staff can only answer if the rows are still there.
 *
 * Holding the slot is no longer the problem it was, either: a later submission
 * from the same address REUSES the row and mints a fresh link (see
 * `beginPublicSubmission`), so an abandoned row does not lock anybody out.
 *
 * Thirty days matches the anonymous-draft TTL — one retention story for
 * "personal data typed by someone who never finished", rather than two.
 */
export const PENDING_TTL_MS = DRAFT_TTL_MS;

/**
 * When a still-unverified response is nudged, measured from its first
 * submission.
 *
 * Six hours catches the overwhelmingly common case — "I meant to click that
 * later" — inside the same day, while a full 42 hours of link life remain.
 * Twenty-four hours is the last honest moment to ask: a fresh link minted then
 * outlives the reminder by another two days, and a third nudge on a form
 * somebody has now ignored twice is spam wearing a helpful hat.
 *
 * IDEMPOTENCE COMES FROM THE TOKEN TABLE, not from a column. A stage is due
 * only when NO token for the response was created after `submitted_at + stage`
 * — and sending mints one, which is precisely the record that the stage has
 * been served. Running the sweep twice in a row therefore mails once, and the
 * property survives a process restart, a re-run by hand, and a schedule that
 * fires late. A resend the person asked for suppresses the next nudge too,
 * which is correct: they have a fresh link in their inbox already.
 */
export const REMINDER_STAGES_MS = [6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000] as const;

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
 * Refuse if the cap is already full — with the queue ordered by FIRST
 * SUBMISSION, not by who read their email fastest.
 *
 * ── What is counted ────────────────────────────────────────────────────────
 * Two classes of row, and the second is the whole point of this function:
 *
 *  1. VERIFIED submissions. Unconditional: they are in, and they are in
 *     wherever they sit in the order.
 *  2. UNVERIFIED submissions that came in BEFORE this one and can still be
 *     verified — a real answer set (not an address placeholder) holding a
 *     token that is neither spent nor expired.
 *
 * Class 2 is a RESERVATION, and it is what stops a slow inbox from costing
 * somebody their place. Before this, the cap counted verified rows only, so
 * two people submitting one second apart against the last slot were ranked by
 * how quickly their mail server delivered: the later submission that verified
 * first took the place, and the earlier one was told the form had filled up.
 *
 * ── Why this does not make an unverified row "close" a form ────────────────
 * The reservation is consulted ONLY here, on the transition into the cap. The
 * fill loader and `beginPublicSubmission` still count verified rows alone, so
 * a pending row never turns a form away at the door — it only loses a tie it
 * was already winning on time. That asymmetry is deliberate: a reservation is
 * a promise to the person who submitted first, not a lock on the form.
 *
 * ── Why it stays exact under concurrency ───────────────────────────────────
 * Every writer holds the form's row lock (see `lockForm`), so these counts are
 * taken in a serialized order. N simultaneous confirmations against a cap of K
 * admit exactly K — and now it is always the K earliest submissions, whatever
 * order the confirmations arrive in, because each one measures itself against
 * everything that came before it rather than against whatever happens to be
 * verified at that instant.
 *
 * `before` is the submitted_at this response WILL HOLD when the transaction
 * commits — for a row whose placeholder timestamp is being bumped to now, that
 * is `now`, not the value on disk. Passing the stale one would let a browser
 * that merely typed an address hours ago jump the queue.
 *
 * Omitting `before` (the classroom path, where a submission verifies in the
 * same transaction) counts verified rows only, which is the behaviour that
 * path has always had.
 */
async function assertCapAvailable(
  tx: Prisma.TransactionClient,
  form: LockedFormRow,
  { excludeResponseId, before, now }: { excludeResponseId?: string; before?: Date; now?: Date } = {}
): Promise<void> {
  if (form.response_cap === null) return;

  // Sentinels rather than nullable casts: no row has an empty-string id, and
  // nothing was submitted before the epoch, so "absent" is expressed as a
  // predicate that is simply never true. One query, no dynamic SQL.
  const exclude = excludeResponseId ?? '';
  const cutoff = before ?? new Date(0);
  const at = now ?? new Date();
  /**
   * The outer bound on how long a place can be held.
   *
   * A live token is the natural test for "can still verify", and on its own it
   * is not enough: the reminder pass mints a FRESH link at six hours and again
   * at twenty-four, and the resend button mints one whenever it is pressed, so
   * "holds a live token" could be renewed indefinitely and a slot held for
   * weeks by somebody who never verifies. The window is therefore measured from
   * the SUBMISSION — one link's life, whatever links have been sent since —
   * which is exactly the promise the design makes: verify within the window and
   * you keep the place you submitted for.
   */
  const windowOpened = new Date(at.getTime() - MAGIC_TOKEN_TTL_MS);

  const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count
    FROM form_responses r
    WHERE r.form_id = ${form.id}
      AND r.id <> ${exclude}
      AND (
        (r.submission_state = 'SUBMITTED' AND r.verified_at IS NOT NULL)
        OR (
          r.submission_state = 'PENDING_VERIFICATION'
          AND r.submitted_at < ${cutoff}
          AND r.submitted_at > ${windowOpened}
          AND r.answers <> '{}'::jsonb
          AND EXISTS (
            SELECT 1
            FROM form_magic_tokens t
            WHERE t.response_id = r.id
              AND t.used_at IS NULL
              AND t.expires_at > ${at}
          )
        )
      )
  `;

  const taken = Number(rows[0]?.count ?? 0);
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
          EXPIRES_HOURS: MAGIC_TOKEN_TTL_MS / (60 * 60 * 1000),
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
      expires_at: new Date(now.getTime() + MAGIC_TOKEN_TTL_MS),
    },
    select: { id: true },
  });
  return { raw, tokenId: created.id };
}

/**
 * When this response last got a link that is STILL WORTH POINTING AT, or null.
 *
 * Three conditions, and each one is a way the reuse could otherwise strand
 * somebody with a dead link and no mail:
 *
 *  - unspent (`used_at` null) — a link that has been clicked opens nothing;
 *  - unexpired — the obvious one;
 *  - minted inside `MAGIC_TOKEN_REUSE_MS` — so what is handed back has real
 *    life left, not the last twenty minutes of it.
 *
 * The RAW token is not recoverable (only its digest is stored), which is
 * exactly right: reuse means "send nothing", never "send the old link again".
 * The one already in their inbox is the copy.
 *
 * Called inside the form's row lock by every path that would otherwise mint, so
 * two concurrent sends for one address cannot both decide they are the first.
 */
async function findLiveLink(
  tx: Prisma.TransactionClient,
  responseId: string,
  now: Date
): Promise<{ id: string; created_at: Date } | null> {
  return tx.formMagicToken.findFirst({
    where: {
      response_id: responseId,
      used_at: null,
      expires_at: { gt: now },
      created_at: { gt: new Date(now.getTime() - MAGIC_TOKEN_REUSE_MS) },
    },
    orderBy: { created_at: 'desc' },
    // The id comes back so a caller who sends NOTHING can still point a browser
    // at the send that is already outstanding — otherwise re-typing the same
    // address would replace a real bounce watch with a dead one.
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
 * EMPTY, and `rawToken` null, when a live link already covers this response;
 * see `MAGIC_TOKEN_REUSE_MS`.
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
}: {
  formId: string;
  email: string;
  name?: string | null;
  answers: unknown;
  revisionId: string;
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
     * ── The second mail that used not to be worth sending ─────────────────
     *
     * Somebody who typed their address (which mailed a link) and then submitted
     * without opening it used to get a SECOND mail, seconds after the first.
     * Two mails for one action reads as broken, and the second one makes the
     * first ambiguous. The link minted on blur opens this very row — the
     * placeholder overwrite above has just put the real answers into it — so
     * there is nothing the new link would do that the old one does not.
     *
     * Nobody is stranded by this. Reuse requires a link that is unspent,
     * unexpired and young (`findLiveLink`), so the alternative to a mail is
     * always a working link rather than silence; the check-email screen's
     * resend button force-mints for the person who cannot find it; and the
     * unverified-reminder sweep mints a fresh one six hours later on its own,
     * because `submitted_at` moves to now here and the reused token predates
     * it.
     */
    const live = await findLiveLink(tx, responseId, now);
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

    const { raw, tokenId } = await mintLinkFor(tx, responseId, now);
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
 * ── An address that already holds a live link ──────────────────────────────
 * No mail either. One live link per address is the whole policy — see
 * `MAGIC_TOKEN_REUSE_MS` — so re-typing the same address, on this page load or
 * on tomorrow's, points at the link already in the inbox rather than adding to
 * it. `force` is the one way past it.
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
}: {
  formId: string;
  email: string;
  name?: string | null;
  revisionId: string;
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
     * A live link already covers this address — so nothing is sent.
     *
     * The same rule the submit follows, and here it is what keeps the per-
     * mailbox ceiling meaningful: without it, reloading the form and re-typing
     * the same address mints a link every time, and three reloads would leave
     * the resend button refused for an hour. `force` skips it, because a resend
     * is the person on the screen telling us the first one did not arrive.
     */
    if (!force) {
      const live = await findLiveLink(tx, responseId, now);
      // No mail — but the outstanding send is the one worth watching, so its id
      // goes back rather than nothing. Without this, reloading the form and
      // re-typing the same address would swap a live bounce watch for a dead
      // one and a real bounce would never reach the page.
      if (live) return { emails: [], verifyUrl: null, sent: false, watchTokenId: live.id };
    }

    const { raw, tokenId } = await mintLinkFor(tx, responseId, now);
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
      await assertCapAvailable(tx, lockedForm, {
        excludeResponseId: response.id,
        before: response.submitted_at,
        now,
      });
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

    await tx.formMagicToken.update({ where: { id: token.id }, data: { used_at: now } });

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
 * The token is CONSUMED here: it was single-use before this feature and it is
 * single-use now. A later edit takes a fresh link, exactly as it always did.
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
      // `before: now` — this row's FIFO position is the submission happening
      // right now, not the moment its address was typed.
      await assertCapAvailable(tx, lockedForm, {
        excludeResponseId: response.id,
        before: now,
        now,
      });
    }

    await tx.formMagicToken.update({ where: { id: token.id }, data: { used_at: now } });

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
      await assertCapAvailable(tx, form, { excludeResponseId: existing?.id, now });
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

/**
 * Drop the rows that are holding uniqueness slots without holding a submission.
 *
 * ── What changed, and why ──────────────────────────────────────────────────
 * This used to delete every PENDING_VERIFICATION row at 48 hours, on the
 * argument that a row nobody can verify any more is dead weight on the
 * (form_id, email_normalized) slot. The argument was half right and the
 * consequence was bad: an applicant who typed their address, got distracted,
 * and never clicked simply VANISHED, and the instructor never learned that
 * anybody had tried. On a waitlist that is the most interesting row on the
 * page — somebody who wanted in and bounced off a confirmation step.
 *
 * They are visible as `Unverified` in the responses table, so the fix is to let
 * them stay there: the age is now 30 days, the same retention the anonymous
 * drafts get, and the responses surface says out loud when each one goes.
 * Nothing disappears without having been visible for a month first.
 *
 * The slot is no longer hostage either. A later submission from the same
 * address REUSES the pending row and mints a fresh link (see
 * `beginPublicSubmission`), so an abandoned row costs nobody their second try —
 * which is what made the aggressive sweep necessary in the first place.
 *
 * Three classes now:
 *  - PENDING_VERIFICATION older than 30 days, EXCEPT any a staff member has put
 *    a triage label on. Somebody wrote something about that row; deleting it
 *    would throw away a person's work as well as a person's record.
 *  - Orphan DRAFT partials older than 30 days — the anonymous, cookie-keyed
 *    autosaves the "save partial responses" toggle creates. A classroom draft
 *    (user_id set) is kept: it belongs to an identified member and is theirs to
 *    finish or delete.
 *
 * Pure service function with no scheduling of its own; the Trigger.dev task
 * that calls it lives in `packages/tasks/src/workflows/forms.ts`.
 */
export async function expireStale(now: Date = new Date()) {
  const pendingBefore = new Date(now.getTime() - PENDING_TTL_MS);
  const draftsBefore = new Date(now.getTime() - DRAFT_TTL_MS);

  const pending = await getPrisma().formResponse.deleteMany({
    where: {
      submission_state: 'PENDING_VERIFICATION',
      created_at: { lt: pendingBefore },
      staff_status: null,
    },
  });

  const drafts = await getPrisma().formResponse.deleteMany({
    where: {
      submission_state: 'DRAFT',
      user_id: null,
      updated_at: { lt: draftsBefore },
    },
  });

  return { pendingDeleted: pending.count, draftsDeleted: drafts.count };
}

/** When an unverified row will be swept, for the staff surface to show. */
export const pendingExpiresAt = (createdAt: Date): Date =>
  new Date(createdAt.getTime() + PENDING_TTL_MS);

// ─── Reminders ──────────────────────────────────────────────────────────────

export interface ReminderSweepResult {
  /** Composed mail for the CALLER to send, in submission order. */
  emails: FormVerifyEmail[];
  /** Rows nudged, by stage index. For the task's log line. */
  remindedByStage: number[];
  /** Rows that were due but had spent their hourly link budget. */
  skippedForCooldown: number;
}

/**
 * Nudge the people who submitted a public response and never clicked the link.
 *
 * ── Who is in scope ────────────────────────────────────────────────────────
 * PENDING_VERIFICATION, `verified_at` still null, and a NON-EMPTY answer set.
 * The last of those matters: a row with `{}` for answers is an address
 * somebody typed into a form and abandoned — possibly somebody else's address,
 * typed by a stranger — and mailing it twice more would turn the early-send
 * convenience into an unsolicited three-message sequence. An entry has to
 * exist before "finish your entry" is a sentence worth sending.
 *
 * ── Idempotence, with no column to track it ────────────────────────────────
 * A stage is due when the response is at least `stage` old AND NO TOKEN for it
 * was created after `submitted_at + stage`. Sending mints a token, which places
 * a token after that boundary — so the same stage can never fire twice, and the
 * property is recomputed from durable state on every run rather than
 * remembered. Running the sweep twice back to back mails once. So does running
 * it after a restart, or by hand, or late.
 *
 * A link the person asked for themselves (the resend button) suppresses the
 * next nudge for the same reason, which is the behaviour you want: they have a
 * fresh link in their inbox already.
 *
 * ── Failure is per row ─────────────────────────────────────────────────────
 * One row that has spent its hourly link budget must not abort the sweep for
 * everybody else, so the cooldown is caught and counted rather than thrown.
 *
 * The caller sends (or logs) the mail — the same "service prepares, route
 * delivers" split `beginPublicSubmission` uses, and the reason this is
 * testable without a mail transport.
 */
export async function remindUnverified(now: Date = new Date()): Promise<ReminderSweepResult> {
  const oldest = new Date(now.getTime() - REMINDER_STAGES_MS[0]);

  const candidates = await getPrisma().formResponse.findMany({
    where: {
      submission_state: 'PENDING_VERIFICATION',
      verified_at: null,
      user_id: null,
      submitted_at: { lte: oldest },
      // Only forms that could still take the response. Nudging somebody towards
      // a form that closed is worse than saying nothing.
      form: { status: 'OPEN', access: 'PUBLIC' },
    },
    select: {
      id: true,
      email: true,
      name: true,
      answers: true,
      submitted_at: true,
      form: {
        select: {
          title: true,
          slug: true,
          closes_at: true,
          classroom: { select: { slug: true, name: true } },
        },
      },
    },
    orderBy: { submitted_at: 'asc' },
  });

  const emails: FormVerifyEmail[] = [];
  const remindedByStage = REMINDER_STAGES_MS.map(() => 0);
  let skippedForCooldown = 0;

  for (const response of candidates) {
    if (answersAreEmpty(response.answers)) continue;
    if (response.form.closes_at && response.form.closes_at.getTime() <= now.getTime()) continue;

    const age = now.getTime() - response.submitted_at.getTime();

    // The LATEST stage this row has come of age for. Checking newest-first
    // means a sweep that missed a run does not send two nudges in a row to
    // catch up — it sends the one that is actually current.
    let stageIndex = -1;
    for (let index = REMINDER_STAGES_MS.length - 1; index >= 0; index--) {
      if (age >= REMINDER_STAGES_MS[index]) {
        stageIndex = index;
        break;
      }
    }
    if (stageIndex < 0) continue;

    const boundary = new Date(response.submitted_at.getTime() + REMINDER_STAGES_MS[stageIndex]);
    const servedAlready = await getPrisma().formMagicToken.count({
      where: { response_id: response.id, created_at: { gt: boundary } },
    });
    if (servedAlready > 0) continue;

    try {
      const { raw, tokenId } = await getPrisma().$transaction(tx =>
        mintLinkFor(tx, response.id, now)
      );
      emails.push(
        composeLinkEmail({
          to: response.email,
          name: response.name,
          formTitle: response.form.title,
          classroomName: response.form.classroom.name,
          verifyUrl: verifyUrlFor({
            classroomSlug: response.form.classroom.slug,
            formSlug: response.form.slug,
            rawToken: raw,
          }),
          template: 'form-verify-reminder',
          // A reminder bounces exactly as a first send does, and the staff row
          // wants to know that too — nobody is on a page to be told.
          formMagicTokenId: tokenId,
        })
      );
      remindedByStage[stageIndex] += 1;
    } catch (error) {
      if ((error as { code?: string }).code === MAGIC_LINK_COOLDOWN) {
        skippedForCooldown += 1;
        continue;
      }
      throw error;
    }
  }

  return { emails, remindedByStage, skippedForCooldown };
}
