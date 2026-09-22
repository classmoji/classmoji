import getPrisma from '@classmoji/database';
import type { Prisma } from '@prisma/client';
import { fieldsOf } from './form.service.ts';
import {
  FIELD_TYPE_REGISTRY,
  galleryRoleOf,
  type FormField,
  type FormOption,
} from './formContract.ts';

/**
 * Gallery Service — the org project gallery.
 *
 * A project IS a form response: APPROVED + SUBMITTED, on a form whose
 * gallery_org_id names the org. PUBLIC read path (the anonymous class-site
 * routes call it), so the select below never reads email, user_id, staff
 * columns or resolved_context, and values leave only through a gallery role or
 * the extras list. Carries no authorization, like every service here.
 */

export interface GalleryCard {
  id: string;
  title: string;
  tagline: string;
  summary: string;
  /** Free text, meant to be one emoji. */
  icon: string;
  /** https only (the site CSP is `img-src 'self' https: data:`). */
  coverUrl: string | null;
  /** classroom.name — the term label. */
  term: string;
  classroomSlug: string;
  submittedAt: string;
}

export interface GalleryProject extends GalleryCard {
  team: string[];
  tags: string[];
  links: Array<{ label: string; url: string }>;
  details: Array<{ heading: string; body: string }>;
  /**
   * Every other answered input field. Formatted by the caller with apps/pages
   * `formatAnswer` — the one answer formatter — which this package cannot import.
   */
  extras: Array<{ field: FormField; value: unknown }>;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Option labels for a choice answer (one id or many); unknown ids are dropped. */
const optionLabels = (field: FormField, value: unknown): string[] => {
  const options = (field.options as FormOption[] | undefined) ?? [];
  const ids = Array.isArray(value) ? value : value == null ? [] : [value];
  return ids.map(id => options.find(option => option.id === id)?.label ?? '').filter(Boolean);
};

/**
 * A pasted URL, or null. A bare host gets https://. Links allow http and https;
 * images (httpsOnly) allow https only. Anything else — javascript:, data:,
 * mailto: — is refused.
 */
const webUrl = (raw: string, httpsOnly = false): string | null => {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url.href;
  return !httpsOnly && url.protocol === 'http:' ? url.href : null;
};

/** Identity and per-teammate answers never go public, even unroled. */
const NEVER_EXTRA = new Set(['email', 'repeat_group']);

/**
 * The respondent's own name: mirrors identityPlan (apps/pages answerCoerce.ts),
 * which reads the first short_text labelled "name" as the filler's name and,
 * on a classroom form, fills it from the account.
 */
const SELF_NAME = /\bname\b/i;

const isExtra = (field: FormField, value: unknown): boolean =>
  FIELD_TYPE_REGISTRY[field.type]?.kind === 'input' &&
  !NEVER_EXTRA.has(field.type) &&
  !(field.type === 'short_text' && SELF_NAME.test(String(field.label ?? ''))) &&
  value !== undefined &&
  value !== null &&
  value !== '' &&
  !(Array.isArray(value) && value.length === 0);

/**
 * One response → one project, read through the roles of the revision it was
 * filled under. Pure; shared by the list and the detail page.
 */
export function projectFromResponse(
  response: { id: string; submitted_at: Date; answers: unknown },
  fields: FormField[],
  classroom: { name: string; slug: string }
): GalleryProject {
  const answers = (response.answers ?? {}) as Record<string, unknown>;
  const project: GalleryProject = {
    id: response.id,
    title: '',
    tagline: '',
    summary: '',
    icon: '',
    coverUrl: null,
    term: classroom.name,
    classroomSlug: classroom.slug,
    submittedAt: response.submitted_at.toISOString(),
    team: [],
    tags: [],
    links: [],
    details: [],
    extras: [],
  };

  for (const field of fields) {
    const value = answers[field.id];
    const role = galleryRoleOf(field);
    switch (role) {
      case 'title':
      case 'tagline':
      case 'summary':
      case 'icon':
        project[role] = text(value);
        break;
      case 'cover':
        project.coverUrl = webUrl(text(value), true);
        break;
      case 'team':
        // Roster labels are "Name (login)"; the public page shows names.
        project.team = optionLabels(field, value).map(label => label.replace(/ \([^)]*\)$/, ''));
        break;
      case 'tags':
        project.tags =
          field.type === 'multiselect'
            ? optionLabels(field, value)
            : text(value)
                .split(',')
                .map(tag => tag.trim())
                .filter(Boolean);
        break;
      case 'link': {
        const url = webUrl(text(value));
        if (url) project.links.push({ label: String(field.label ?? ''), url });
        break;
      }
      case 'detail':
        if (text(value))
          project.details.push({ heading: String(field.label ?? ''), body: text(value) });
        break;
      default:
        if (isExtra(field, value)) project.extras.push({ field, value });
    }
  }

  if (!project.title) project.title = 'Untitled project';
  return project;
}

const PUBLIC_SELECT = {
  id: true,
  answers: true,
  submitted_at: true,
  revision: { select: { fields: true } },
  form: { select: { classroom: { select: { name: true, slug: true, created_at: true } } } },
} satisfies Prisma.FormResponseSelect;

type PublicRow = Prisma.FormResponseGetPayload<{ select: typeof PUBLIC_SELECT }>;

const approvedIn = (orgId: string): Prisma.FormResponseWhereInput => ({
  submission_state: 'SUBMITTED',
  gallery_status: 'APPROVED',
  form: { gallery_org_id: orgId },
});

const toProject = (row: PublicRow): GalleryProject =>
  projectFromResponse(row, fieldsOf(row.revision.fields), row.form.classroom);

const cardOf = (project: GalleryProject): GalleryCard => ({
  id: project.id,
  title: project.title,
  tagline: project.tagline,
  summary: project.summary,
  icon: project.icon,
  coverUrl: project.coverUrl,
  term: project.term,
  classroomSlug: project.classroomSlug,
  submittedAt: project.submittedAt,
});

/** Every approved project in the org, newest term first, then by title. */
export async function listForOrg(orgId: string): Promise<GalleryCard[]> {
  // ponytail: no pagination; a cross-term gallery is hundreds of rows at most.
  // Add take/skip when an org outgrows one page.
  const rows = await getPrisma().formResponse.findMany({
    where: approvedIn(orgId),
    select: PUBLIC_SELECT,
  });
  return rows
    .map(row => ({ termAt: row.form.classroom.created_at.getTime(), project: toProject(row) }))
    .sort((a, b) => b.termAt - a.termAt || a.project.title.localeCompare(b.project.title))
    .map(entry => cardOf(entry.project));
}

/** One approved project in the org, or null (pending, hidden, other org, unknown). */
export async function getForOrg(orgId: string, responseId: string): Promise<GalleryProject | null> {
  const row = await getPrisma().formResponse.findFirst({
    where: { id: responseId, ...approvedIn(orgId) },
    select: PUBLIC_SELECT,
  });
  return row ? toProject(row) : null;
}
