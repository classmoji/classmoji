import type { FormField } from '@classmoji/services/form-contract';

import { ClassmojiService, getAuthSession, prisma } from '~/utils/db.server.ts';
import {
  classroomIdentityPlan,
  visibleClassroomFields,
  type ClassroomIdentity,
} from '~/components/forms/answerCoerce.ts';
import type { CanvasTheme, PublicFormSummary } from './publicForm.server.ts';

/**
 * Resolving a CLASSROOM form for a signed-in member — the classroom half of
 * what `publicForm.server.ts` does for a stranger, and the only module in the
 * fill subtree that is allowed to know a roster exists.
 *
 * ── The isolation invariant ────────────────────────────────────────────────
 * A member sees their OWN response and nothing else, ever. That is enforced in
 * one place and one way: `findOwnResponse(formId, userId)` where `userId` comes
 * from `getAuthSession`. No route param, query string, or request body reaches
 * that call — not as a fallback, not as an override. A response id posted by a
 * client is not rejected here, it is never read, which is the version of the
 * rule that cannot be got around by finding a code path someone forgot to
 * validate.
 *
 * ── Why the write path calls this too ──────────────────────────────────────
 * Exactly as on the public side: the action re-derives everything the loader
 * derived, from the session, so a form that closed, filled up, republished, or
 * a member who was removed from the roster between page load and click is
 * refused on the way in. The page's own belief about what it was rendering is
 * never an input.
 *
 * ── Identity ───────────────────────────────────────────────────────────────
 * `name` and `email` come from the account. Where the DEFINITION also asks for
 * them (a preset written for a public link), those questions are removed from
 * what the renderer gets and answered server-side — see `classroomIdentityPlan`
 * for the rule and for the one case where a question stays visible.
 */

/** The identity a member fills a form under, taken from their account. */
interface SessionMember {
  userId: string;
  name: string;
  email: string;
}

export type ClassroomFormLoad =
  | { view: 'signin'; theme: CanvasTheme; classroomName: string; loginUrl: string }
  | {
      view: 'not-member';
      theme: CanvasTheme;
      classroomName: string;
      /** The account they are signed in as, so they can tell it is the wrong one. */
      signedInAs: string;
      loginUrl: string;
    }
  | {
      view: 'no-account-email';
      theme: CanvasTheme;
      classroomName: string;
      form: PublicFormSummary;
    }
  | { view: 'closed'; theme: CanvasTheme; classroomName: string; form: PublicFormSummary }
  | {
      view: 'classroom-fill';
      theme: CanvasTheme;
      classroomName: string;
      form: PublicFormSummary;
      revisionId: string;
      /** The questions to render — identity questions already removed. */
      fields: FormField[];
      identity: ClassroomIdentity;
      /** Their draft, or their submitted answers when re-visiting. */
      storedAnswers: Record<string, unknown> | null;
      /** True when `storedAnswers` came from a DRAFT (show "we brought it back"). */
      restoredDraft: boolean;
      /**
       * The form was republished after this person answered. Their answers key
       * to questions that are no longer the current ones, so a fillable page
       * starts empty and says why.
       */
      revisionChanged: boolean;
      /**
       * `fill` — nothing recorded yet.
       * `update` — recorded, and the form still allows a replacement.
       * `recorded` — recorded and final (single-response form, or shut).
       */
      mode: 'fill' | 'update' | 'recorded';
      /**
       * SERVER ONLY. The route loader strips this before answering, because a
       * loader's return value is shipped to the browser and none of it is the
       * browser's business. The ACTION gets its own copy by calling this
       * function again, from the session — never from what the page sends back.
       */
      server: {
        userId: string;
        /** `{ [fieldId]: value }` written over the client's answers at submit. */
        injected: Record<string, string>;
      };
    };

/**
 * The form row this module reads — DERIVED from the query that produces it, not
 * declared alongside it.
 *
 * A hand-written interface here would have to be asserted at the call site, and
 * the day `findBySlug`'s select stopped returning `allow_multiple` the compiler
 * would say nothing: the field would read `undefined`, `mode` would settle on
 * `recorded`, the cap would never be checked, and every symptom would look like
 * a logic bug somewhere else.
 */
export type ClassroomFormRow = NonNullable<
  Awaited<ReturnType<typeof ClassmojiService.form.findBySlug>>
>;

/**
 * The account behind a request, or null when there is no usable session.
 *
 * `email` may be empty, and the caller decides what that means AFTER it has
 * checked membership — a response row requires an address (it is how a filler
 * is addressed in the staff table and in a confirmation mail), but saying so
 * names the form, and a non-member must not be told the form's name whatever
 * else is wrong with their account.
 */
async function sessionAccount(request: Request): Promise<SessionMember | null> {
  const session = await getAuthSession(request).catch(() => null);
  const userId = session?.userId;
  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, login: true, email: true, provider_email: true },
  });
  if (!user) return null;

  return {
    userId: user.id,
    name: (user.name || user.login || '').trim(),
    email: (user.email || user.provider_email || '').trim(),
  };
}

/**
 * Resolve a CLASSROOM form for whoever is asking.
 *
 * Called only from `loadPublicForm`'s CLASSROOM branch, which has already
 * resolved the classroom, its theme, and the form, and has already 404'd a
 * DRAFT. The order of the checks below is the same disclosure decision the
 * public path documents: membership is answered before status, so a stranger
 * never learns whether a members-only form is open.
 */
export async function resolveClassroomForm({
  classroom,
  form,
  theme,
  classroomName,
  request,
  loginUrl,
}: {
  classroom: { id: string };
  form: ClassroomFormRow;
  theme: CanvasTheme;
  classroomName: string;
  request: Request;
  loginUrl: string;
}): Promise<ClassroomFormLoad> {
  const summary: PublicFormSummary = {
    id: form.id,
    title: form.title,
    description: form.description,
  };

  const account = await sessionAccount(request);
  if (!account) return { view: 'signin', theme, classroomName, loginUrl };

  // ANY member role may fill — a TA answering a planning survey is filling in a
  // form, not administering one. Staff are members too.
  //
  // Checked BEFORE the account's own problems (a missing email address), because
  // the no-email view names the form and the not-member view does not. Deciding
  // them the other way round would hand a members-only form's title to a
  // non-member who happens to have an incomplete account.
  const membership = await prisma.classroomMembership.findFirst({
    where: { classroom_id: classroom.id, user_id: account.userId },
    select: { id: true },
  });

  if (!membership) {
    /**
     * A DIFFERENT state from the anonymous interstitial, on purpose.
     *
     * The committed public path answers both with "sign in" because telling a
     * stranger "you are signed in but not on this roster" would confirm a
     * members-only form exists. But this person is already being told the
     * classroom's name by that very interstitial — so the extra sentence
     * discloses nothing new, and withholding it produces the genuinely bad
     * outcome: a sign-in loop for someone who is already signed in and whose
     * real problem is the account they used.
     *
     * The form's title and description are still withheld.
     */
    return {
      view: 'not-member',
      theme,
      classroomName,
      // The login, when there is no address to name — the point is to identify
      // the account they used, and "(no email on this account)" would not.
      signedInAs: account.email || account.name || 'this account',
      loginUrl,
    };
  }

  // A member with no address at all. A response row is filed under one, and
  // storing `''` to get past the type would put a row in the staff table that
  // nothing downstream can address.
  if (!account.email) {
    return { view: 'no-account-email', theme, classroomName, form: summary };
  }
  const member = account;

  if (!form.current_revision_id) {
    return { view: 'closed', theme, classroomName, form: summary };
  }

  const revision = await ClassmojiService.form.getCurrentRevision(form.id);
  if (!revision) return { view: 'closed', theme, classroomName, form: summary };

  /**
   * Their own row, by session id. Read BEFORE the accepting/cap decision,
   * because a member who is already inside the cap must still be able to see
   * (and, on a resubmittable form, change) what they submitted after the form
   * fills up — the same rule `confirmSubmission` applies to an already-verified
   * public response.
   */
  const own = await ClassmojiService.formResponse.findOwnResponse(form.id, member.userId);
  const submitted = own?.submission_state === 'SUBMITTED';

  const accepting =
    form.status === 'OPEN' && !(form.closes_at && form.closes_at.getTime() <= Date.now());

  let capFull = false;
  if (accepting && !submitted && form.response_cap !== null) {
    const verified = await prisma.formResponse.count({
      where: { form_id: form.id, submission_state: 'SUBMITTED', verified_at: { not: null } },
    });
    capFull = verified >= form.response_cap;
  }

  if (!submitted && (!accepting || capFull)) {
    return { view: 'closed', theme, classroomName, form: summary };
  }

  const identity: ClassroomIdentity = { name: member.name, email: member.email };

  const mode: 'fill' | 'update' | 'recorded' = !submitted
    ? 'fill'
    : accepting && form.allow_multiple
      ? 'update'
      : 'recorded';

  const revisionChanged = Boolean(own && own.revision_id !== revision.id);

  /**
   * Which revision this page RENDERS.
   *
   * A final response is rendered against the revision it was filled against —
   * those are the questions it answers, and showing them against a newer
   * definition would print an answer under a question nobody was asked. A
   * fillable page is always the current revision, because that is what a new
   * submission has to satisfy.
   */
  const displayRevision =
    mode === 'recorded' && revisionChanged && own
      ? // Scoped to the form, not just to the revision id. The id is
        // server-derived (it came off a row already scoped to this form and
        // this user), so this cannot currently resolve elsewhere — and the
        // argument this module makes everywhere else is that a read is safe
        // because the query cannot reach the wrong row, not because the caller
        // was careful.
        ((await prisma.formRevision.findFirst({
          where: { id: own.revision_id, form_id: form.id },
        })) ?? revision)
      : revision;

  // The plan the ACTION will apply, keyed to the current definition — the one a
  // submission is written against. When the page is showing an older revision
  // it is read-only, so that plan is only ever used to decide what to display.
  const currentPlan = classroomIdentityPlan(
    ClassmojiService.form.fieldsOf(revision.fields),
    identity
  );

  const displayFields = ClassmojiService.form.fieldsOf(displayRevision.fields);
  const displayPlan =
    displayRevision.id === revision.id
      ? currentPlan
      : classroomIdentityPlan(displayFields, identity);

  // Answers written against an OLDER revision are never poured into a FILLABLE
  // form: the questions have changed, and prefilling across that boundary is
  // how a person ends up submitting something they never read.
  const showStored = Boolean(own && (mode === 'recorded' || !revisionChanged));

  return {
    view: 'classroom-fill',
    theme,
    classroomName,
    form: summary,
    // Always the CURRENT revision id: it is what a submit is checked against,
    // and offering the old one would fail every staleness check.
    revisionId: revision.id,
    fields: visibleClassroomFields(displayFields, displayPlan),
    identity,
    storedAnswers: showStored ? (own?.answers as Record<string, unknown>) : null,
    restoredDraft: Boolean(own && !submitted && !revisionChanged),
    revisionChanged,
    mode,
    server: { userId: member.userId, injected: currentPlan.injected },
  };
}
