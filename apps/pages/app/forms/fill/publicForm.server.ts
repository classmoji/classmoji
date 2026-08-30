import { getThemeByKey } from '@classmoji/utils/themes';

import { ClassmojiService, getAuthSession, prisma } from '~/utils/db.server.ts';

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
 * ── What is NOT here ───────────────────────────────────────────────────────
 * The roster. A PUBLIC form cannot contain a roster-sourced field (the contract
 * refuses to save one), and this module has no code path that could resolve one
 * if it did. That is the render layer of the plan's three-layer access rule:
 * not "we don't ask", but "there is nothing here to ask with".
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
  | { view: 'signin'; theme: CanvasTheme; classroomName: string; loginUrl: string }
  | {
      view: 'classroom-placeholder';
      theme: CanvasTheme;
      classroomName: string;
      form: PublicFormSummary;
    }
  | { view: 'closed'; theme: CanvasTheme; classroomName: string; form: PublicFormSummary }
  | {
      view: 'fill';
      theme: CanvasTheme;
      classroomName: string;
      form: PublicFormSummary;
      revisionId: string;
      fields: unknown[];
    };

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
  if (form.access === 'CLASSROOM') {
    const session = await getAuthSession(request).catch(() => null);
    const userId = session?.userId;

    const membership = userId
      ? await prisma.classroomMembership.findFirst({
          where: { classroom_id: classroom.id, user_id: userId },
          select: { id: true },
        })
      : null;

    // A signed-in non-member gets the same interstitial as a stranger. Telling
    // them "you are signed in but not on this roster" would confirm the form
    // exists to someone with no business knowing.
    if (!membership) {
      return { view: 'signin', theme, classroomName, loginUrl: loginUrlFor(request) };
    }

    // Mission 6 replaces this with the authed renderer: session identity, roster
    // options resolved behind the membership check, server-side draft autosave.
    return { view: 'classroom-placeholder', theme, classroomName, form: summary };
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

  return {
    view: 'fill',
    theme,
    classroomName,
    form: summary,
    revisionId: revision.id,
    fields: ClassmojiService.form.fieldsOf(revision.fields),
  };
}
