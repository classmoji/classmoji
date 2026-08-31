import { getThemeByKey } from '@classmoji/utils/themes';
import { assertFieldsAllowedForAccess, type FormField } from '@classmoji/services/form-contract';

import { ClassmojiService, prisma } from '~/utils/db.server.ts';
import { resolveClassroomForm, type ClassroomFormLoad } from './classroomForm.server.ts';

/**
 * Resolving a form for a PUBLIC, possibly anonymous visitor — the one place
 * both the fill loader and the fill action decide what a stranger may see.
 *
 * ── Why one function serves both ───────────────────────────────────────────
 * The action must re-derive everything the loader derived: a form that closed,
 * filled up, went back to DRAFT, or turned out to be CLASSROOM between the page
 * load and the click has to be refused on the way in, never trusted from the
 * page's own idea of what it was rendering. Two copies of that reasoning would
 * eventually disagree, and the copy that mattered would be the one on the write
 * path.
 *
 * ── Order is a disclosure decision ─────────────────────────────────────────
 * A DRAFT or unknown form 404s before anything else, and CLASSROOM access is
 * answered before open/closed — so an anonymous visitor never learns a
 * members-only form's title or status. Reordering these is a security change.
 *
 * ── What is NOT here, and what is ──────────────────────────────────────────
 * This module never RESOLVES a roster: there is no membership query on the
 * public path, so it cannot go and fetch one. That is necessary and it is not
 * sufficient, because a roster does not have to be fetched to be leaked — it
 * can already be sitting inside the revision being served. `form.service.publish`
 * materializes every `roster_select` into the revision as `[{ id: user_id,
 * label: "Name (login)" }]`, and a form whose `access` changed after that
 * publish would hand those rows to an anonymous visitor with no query at all.
 *
 * So this module also ASSERTS, on the way out: the fields about to be shipped
 * to a public caller are re-checked against the form's current access mode
 * (`assertFieldsAllowedForAccess`, below). The service refuses the access flip
 * that produces such a state; this is the independent second layer, so a future
 * write path that forgets the rule still cannot serve a roster to a stranger.
 */

export interface CanvasTheme {
  background: string;
  darkBackground: string;
}

export interface PublicFormSummary {
  id: string;
  title: string;
  description: string | null;
}

export type PublicFormLoad =
  | { view: 'closed'; theme: CanvasTheme; classroomName: string; form: PublicFormSummary }
  | {
      view: 'fill';
      theme: CanvasTheme;
      classroomName: string;
      form: PublicFormSummary;
      revisionId: string;
      fields: unknown[];
    }
  // A CLASSROOM form's outcomes (sign-in, not-a-member, closed, the authed
  // fill) come back through the same union: one loader, one `view` switch on
  // the page, whichever mode the form turned out to be in.
  | ClassroomFormLoad;

/** The two hex values the fill pages paint their canvas with. */
export const themeFor = (themeKey: string | null | undefined): CanvasTheme => {
  const theme = getThemeByKey(themeKey);
  return { background: theme.background, darkBackground: theme.darkBackground };
};

/**
 * Where an anonymous visitor is sent to sign in.
 *
 * Same shape `formAuth.server.ts` builds for the admin surfaces — the webapp
 * owns login, and `redirect` brings them back to the form afterwards rather
 * than to a dashboard they did not ask for.
 */
export const loginUrlFor = (request: Request): string => {
  const webappUrl = process.env.WEBAPP_URL || 'http://localhost:3000';
  return `${webappUrl}?redirect=${encodeURIComponent(request.url)}`;
};

const notFound = (): never => {
  // A DRAFT form and a slug nobody ever created answer identically. A 403 on the
  // draft would confirm that a guessed slug names something real.
  throw new Response('Form not found', { status: 404 });
};

/**
 * Resolve `/{classroomSlug}/forms/{formSlug}` for a public caller.
 *
 * @throws Response 404 for an unknown classroom, an unknown form, a DRAFT form,
 *   or an OPEN form with no published revision (which should be unreachable —
 *   `form.service.quickUpdate` refuses OPEN without one — but is a 404 rather
 *   than a crash if it ever happens).
 */
export async function loadPublicForm({
  classroomSlug,
  formSlug,
  request,
}: {
  classroomSlug: string;
  formSlug: string;
  request: Request;
}): Promise<PublicFormLoad> {
  const classroom = await prisma.classroom.findFirst({
    where: { slug: classroomSlug },
    select: { id: true, name: true, settings: { select: { theme: true } } },
  });
  if (!classroom) return notFound();

  const theme = themeFor(classroom.settings?.theme);
  const classroomName = classroom.name ?? classroomSlug;

  const form = await ClassmojiService.form.findBySlug(classroom.id, formSlug);
  if (!form || form.status === 'DRAFT') return notFound();

  const summary: PublicFormSummary = {
    id: form.id,
    title: form.title,
    description: form.description,
  };

  // ── Access mode, before status ──────────────────────────────────────────
  //
  // Everything past this point is the PUBLIC path. The classroom path — session,
  // membership, roster-materialized options, the member's own draft — lives in
  // its own module, and this one has no import that could reach a roster.
  if (form.access === 'CLASSROOM') {
    return resolveClassroomForm({
      classroom: { id: classroom.id },
      form,
      theme,
      classroomName,
      request,
      loginUrl: loginUrlFor(request),
    });
  }

  // ── Open, or shut ───────────────────────────────────────────────────────
  const closed = { view: 'closed' as const, theme, classroomName, form: summary };

  if (form.status !== 'OPEN') return closed;
  if (form.closes_at && form.closes_at.getTime() <= Date.now()) return closed;

  if (form.response_cap !== null) {
    // Verified rows only — the same count `assertCapAvailable` makes under the
    // row lock at submit. A PENDING_VERIFICATION row holds a uniqueness slot but
    // no place in the queue, so counting it here would close a form that still
    // has room.
    const verified = await prisma.formResponse.count({
      where: { form_id: form.id, submission_state: 'SUBMITTED', verified_at: { not: null } },
    });
    if (verified >= form.response_cap) return closed;
  }

  if (!form.current_revision_id) return notFound();

  const revision = await ClassmojiService.form.getCurrentRevision(form.id);
  if (!revision) return notFound();

  const fields = ClassmojiService.form.fieldsOf(revision.fields) as FormField[];

  /**
   * The render backstop. `fields` here is a PUBLISHED revision, which is the one
   * place a materialized roster can be sitting in a payload nobody re-validated:
   * the contract checks the DRAFT at save and checks the definition at publish,
   * and neither runs again if `access` changes afterwards.
   *
   * A mismatch means a form is in a state no supported write path can produce
   * any more, so it is logged at error level and answered with the same 404 a
   * DRAFT gets — refusing to render is always safe, and the alternative is
   * dumping the roster.
   */
  try {
    assertFieldsAllowedForAccess(fields, form.access);
  } catch (error) {
    console.error('[forms:public] refused to serve a revision that violates its access mode', {
      formId: form.id,
      revisionId: revision.id,
      code: (error as { code?: string }).code,
    });
    return notFound();
  }

  return {
    view: 'fill',
    theme,
    classroomName,
    form: summary,
    revisionId: revision.id,
    fields,
  };
}
