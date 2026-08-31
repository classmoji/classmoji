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

export const MAGIC_LINK_INVALID = 'MAGIC_LINK_INVALID';
export const MAGIC_LINK_EXPIRED = 'MAGIC_LINK_EXPIRED';
export const MAGIC_LINK_USED = 'MAGIC_LINK_USED';
/** Too many links requested for one response inside the rolling window. */
export const MAGIC_LINK_COOLDOWN = 'MAGIC_LINK_COOLDOWN';

const serviceError = (code: string, message: string) => Object.assign(new Error(message), { code });

// ─── Magic-link policy ──────────────────────────────────────────────────────

/** How long a verify/edit link stays usable. */
export const MAGIC_TOKEN_TTL_MS = 48 * 60 * 60 * 1000;
/** Links per response inside the rolling window. */
export const MAGIC_TOKEN_MAX_PER_WINDOW = 3;
export const MAGIC_TOKEN_WINDOW_MS = 60 * 60 * 1000;
/** Unverified rows are swept at the same age as the link that would verify them. */
export const PENDING_TTL_MS = MAGIC_TOKEN_TTL_MS;
/** Abandoned server-side partials are swept after this long. */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

/**
 * Refuse if the cap is already full. Counts VERIFIED rows only — a
 * PENDING_VERIFICATION row holds a uniqueness slot but no place in the queue,
 * so an unverified submission never displaces a real one, and the 48h sweep
 * releases it. Must be called under the form's row lock.
 */
async function assertCapAvailable(
  tx: Prisma.TransactionClient,
  form: LockedFormRow,
  excludeResponseId?: string
): Promise<void> {
  if (form.response_cap === null) return;
  const verified = await tx.formResponse.count({
    where: {
      form_id: form.id,
      submission_state: 'SUBMITTED',
      verified_at: { not: null },
      ...(excludeResponseId ? { id: { not: excludeResponseId } } : {}),
    },
  });
  if (verified >= form.response_cap) {
    throw serviceError(FORM_CAP_REACHED, 'This form has reached its response limit.');
  }
}

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

  const validated = parseAnswers(fieldsOf(revision.fields), answers);
  return { form, revision, validated };
}

// ─── Public submission: begin ───────────────────────────────────────────────

/**
 * A composed verify/edit-link mail, in the same shape roster.service's
 * `RosterEmail` uses. The template itself (`form-verify-link`) lands with the
 * public fill route; this shape is what the route hands to Tasks.sendEmailTask.
 */
export interface FormVerifyEmail {
  payload: {
    to: string;
    template: {
      id: 'form-verify-link';
      variables: Record<string, string | number>;
    };
  };
}

export interface BeginPublicSubmissionResult {
  responseId: string;
  /** The raw link token. Returned ONCE — never stored, never recoverable. */
  rawToken: string;
  /** The full link. Also embedded in `emails`; exposed for dev-mode logging. */
  verifyUrl: string;
  /** 'existing' means this email already had a response; its answers are untouched. */
  mode: 'new' | 'existing';
  /**
   * Composed mail for the CALLER to send. Services must not import
   * @classmoji/tasks (tasks already depends on services — that would be
   * circular), so composition lives here and the trigger stays with the route,
   * exactly as roster.service.addStudents does it.
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
 * this function stays testable and free of transport concerns.
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
  const { raw, hash } = mintMagicToken();
  const verifyUrl = verifyUrlFor({
    classroomSlug: loadedForm.classroom.slug,
    formSlug: loadedForm.slug,
    rawToken: raw,
  });

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
      select: { id: true },
    });

    const response =
      existing ??
      (await tx.formResponse.create({
        data: {
          form_id: formId,
          revision_id: revisionId,
          user_id: null,
          email: email.trim(),
          email_normalized: emailNormalized,
          name: name ?? null,
          answers: validated as unknown as Prisma.InputJsonValue,
          submission_state: 'PENDING_VERIFICATION',
        },
        select: { id: true },
      }));

    // DB-backed so the limit holds across machines. Counted per RESPONSE, which
    // is per (form, email) — the unit a mail bomb would target.
    const recentTokens = await tx.formMagicToken.count({
      where: {
        response_id: response.id,
        created_at: { gt: new Date(now.getTime() - MAGIC_TOKEN_WINDOW_MS) },
      },
    });
    if (recentTokens >= MAGIC_TOKEN_MAX_PER_WINDOW) {
      throw serviceError(
        MAGIC_LINK_COOLDOWN,
        'Too many links requested for this address. Try again in an hour.'
      );
    }

    await tx.formMagicToken.create({
      data: {
        response_id: response.id,
        token_hash: hash,
        expires_at: new Date(now.getTime() + MAGIC_TOKEN_TTL_MS),
      },
    });

    return {
      responseId: response.id,
      rawToken: raw,
      verifyUrl,
      mode: existing ? ('existing' as const) : ('new' as const),
      emails: [
        {
          payload: {
            to: email.trim(),
            template: {
              id: 'form-verify-link' as const,
              // Form titles, classroom names, and the filler's own name are all
              // user-authored, and Resend injects variables raw — escape before
              // they reach the template.
              variables: escapeVars({
                RECIPIENT_NAME: name || 'there',
                FORM_TITLE: loadedForm.title,
                CLASSROOM_NAME: loadedForm.classroom.name,
                VERIFY_URL: verifyUrl,
                EXPIRES_HOURS: MAGIC_TOKEN_TTL_MS / (60 * 60 * 1000),
              }),
            },
          },
        },
      ],
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
  return { tokenId: token.id, response, form, revision };
}

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
    const alreadyVerified = response.verified_at !== null;

    // Confirming a first submission requires the form to still be accepting.
    // Editing an already-verified response does not — a closed form should not
    // strand someone mid-edit, and the row is already inside the cap.
    if (!alreadyVerified) {
      assertAccepting(lockedForm, now);
      await assertCapAvailable(tx, lockedForm, response.id);
    }

    const data: Prisma.FormResponseUncheckedUpdateInput = {
      submission_state: 'SUBMITTED',
      verified_at: response.verified_at ?? now,
    };

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
    return { response: updated, firstVerification: !alreadyVerified };
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

    // Only a row that is not already counted needs a cap slot.
    if (!existing || existing.verified_at === null) {
      await assertCapAvailable(tx, form, existing?.id);
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
 * Two classes, deliberately different ages:
 *  - PENDING_VERIFICATION older than the link's own 48h TTL. Nobody can verify
 *    it any more, and its (form_id, email_normalized) slot must be released so
 *    the same person can start over.
 *  - Orphan DRAFT partials older than 30 days — the anonymous, cookie-keyed
 *    autosaves the "save partial responses" toggle creates. A classroom draft
 *    (user_id set) is kept: it belongs to an identified member and is theirs to
 *    finish or delete.
 *
 * Pure service function with no scheduling of its own; the Trigger.dev task that
 * calls it lands with the public fill route.
 */
export async function expireStale(now: Date = new Date()) {
  const pendingBefore = new Date(now.getTime() - PENDING_TTL_MS);
  const draftsBefore = new Date(now.getTime() - DRAFT_TTL_MS);

  const pending = await getPrisma().formResponse.deleteMany({
    where: { submission_state: 'PENDING_VERIFICATION', created_at: { lt: pendingBefore } },
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
