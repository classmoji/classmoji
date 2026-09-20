import {
  IconFileText,
  IconFolder,
  IconForms,
  IconHelpCircle,
  IconPresentation,
  type Icon,
} from '@tabler/icons-react';
import type { FormAccess, FormStatus, ModuleItemType } from '@prisma/client';
import { formatCloseDate } from './ReadOnlyModulesTree';

/**
 * The item types the "Add item" picker offers. Repositories are not module
 * members at all (a REPO assignment points at one); legacy REPOSITORY rows are
 * kept in the data but no longer rendered.
 */
export type ContentItemType = Exclude<ModuleItemType, 'REPOSITORY'>;

export const CONTENT_TYPES: ContentItemType[] = ['PAGE', 'SLIDE', 'QUIZ', 'FORM'];

/**
 * Compile-time exhaustiveness guard for the switches over ModuleItemType,
 * mirroring the one in module.service. Adding a value to the enum without
 * teaching every switch about it becomes a type error here rather than an item
 * that silently renders as "Unknown" / unpublished / unaddable.
 */
export const unhandledItemType = (type: never): never => {
  throw new Error(`Unhandled ModuleItemType: ${String(type)}`);
};

export const TYPE_META: Record<ModuleItemType, { label: string; icon: Icon }> = {
  PAGE: { label: 'Page', icon: IconFileText },
  REPOSITORY: { label: 'Repository', icon: IconFolder },
  QUIZ: { label: 'Quiz', icon: IconHelpCircle },
  SLIDE: { label: 'Slides', icon: IconPresentation },
  FORM: { label: 'Form', icon: IconForms },
};

// A form's two lifecycle axes, as an instructor reads them. Both are exhaustive
// Records over their enums, so adding a status or an access mode fails to
// compile here rather than rendering the raw enum name.
export const FORM_STATUS_TEXT: Record<FormStatus, string> = {
  DRAFT: 'Draft',
  OPEN: 'Open',
  CLOSED: 'Closed',
};
export const FORM_ACCESS_TEXT: Record<FormAccess, string> = {
  PUBLIC: 'Public',
  CLASSROOM: 'Classroom',
};

/** "Public · Open · closes Jan 12, 5:00 PM" — access, status, then the deadline. */
export const formSummary = (form: {
  status: FormStatus;
  access: FormAccess;
  closes_at: Date | string | null;
}): string =>
  [
    FORM_ACCESS_TEXT[form.access],
    FORM_STATUS_TEXT[form.status],
    ...(form.closes_at ? [`closes ${formatCloseDate(form.closes_at)}`] : []),
  ].join(' · ');

/** The minimum a module item must carry to be labelled and given a pill. */
export interface ModuleItemLike {
  id: string;
  item_type: ModuleItemType;
  page?: { id: string; title: string; is_draft: boolean } | null;
  slide?: { id: string; title: string; is_draft: boolean } | null;
  repository?: { id: string; title: string; is_published: boolean } | null;
  quiz?: { id: string; name: string; status: string } | null;
  form?: {
    id: string;
    title: string;
    status: FormStatus;
    access: FormAccess;
    closes_at: Date | string | null;
  } | null;
  page_id?: string | null;
  slide_id?: string | null;
  quiz_id?: string | null;
  form_id?: string | null;
}

export const itemLabel = (item: ModuleItemLike): string => {
  switch (item.item_type) {
    case 'PAGE':
      return item.page?.title ?? '(deleted page)';
    case 'REPOSITORY':
      return item.repository?.title ?? '(deleted repository)';
    case 'QUIZ':
      return item.quiz?.name ?? '(deleted quiz)';
    case 'SLIDE':
      return item.slide?.title ?? '(deleted slides)';
    case 'FORM':
      return item.form?.title ?? '(deleted form)';
    default:
      return unhandledItemType(item.item_type);
  }
};

// Display label + student-visibility for an item. Keep this client-safe: route
// components cannot call server services without pulling Node-only code into
// the browser bundle.
//
// `note` is the optional muted line after the title. Only forms use it today:
// a form carries two axes the other types don't (who may open it, and when it
// stops accepting answers), and neither is recoverable from the Published pill.
export const describeItem = (
  item: ModuleItemLike
): { label: string; published: boolean; note?: string } => {
  switch (item.item_type) {
    case 'PAGE':
      return { label: itemLabel(item), published: !!item.page && !item.page.is_draft };
    case 'REPOSITORY':
      return {
        label: itemLabel(item),
        published: !!item.repository && item.repository.is_published,
      };
    case 'QUIZ':
      return { label: itemLabel(item), published: !!item.quiz && item.quiz.status !== 'DRAFT' };
    case 'SLIDE':
      return { label: itemLabel(item), published: !!item.slide && !item.slide.is_draft };
    // Matches isItemPublished in module.service: a CLOSED form is still shown
    // to students (reading "Closed"); only a DRAFT is hidden.
    case 'FORM':
      return {
        label: itemLabel(item),
        published: !!item.form && item.form.status !== 'DRAFT',
        note: item.form ? formSummary(item.form) : undefined,
      };
    default:
      return unhandledItemType(item.item_type);
  }
};

/** Candidate content for the picker, as module.getCandidateContent returns it. */
export interface CandidateContent {
  pages: Array<{ id: string; title: string; is_draft: boolean }>;
  slides: Array<{ id: string; title: string; is_draft: boolean }>;
  quizzes: Array<{ id: string; name: string; status: string }>;
  forms: Array<{
    id: string;
    title: string;
    slug: string;
    status: FormStatus;
    access: FormAccess;
    closes_at: Date | string | null;
  }>;
}

/** Options for one content type, minus what the module already holds. */
export const candidateOptions = (
  type: ContentItemType,
  candidates: CandidateContent,
  items: ModuleItemLike[]
) => {
  const added = new Set(
    items
      .filter(i => i.item_type === type)
      .map(i => i.page_id ?? i.slide_id ?? i.quiz_id ?? i.form_id)
  );
  switch (type) {
    case 'PAGE':
      return candidates.pages
        .filter(p => !added.has(p.id))
        .map(p => ({ value: p.id, label: p.title }));
    case 'QUIZ':
      return candidates.quizzes
        .filter(q => !added.has(q.id))
        .map(q => ({ value: q.id, label: q.name }));
    case 'SLIDE':
      return candidates.slides
        .filter(s => !added.has(s.id))
        .map(s => ({ value: s.id, label: s.title }));
    // A DRAFT form is addable on purpose — an instructor builds the module
    // before opening the form — so the option says so rather than hiding it.
    // The suffix stays plain text because the Select filters on `label`
    // (optionFilterProp), which a JSX pill would break.
    case 'FORM':
      return candidates.forms
        .filter(f => !added.has(f.id))
        .map(f => ({
          value: f.id,
          label: `${f.title} — ${FORM_ACCESS_TEXT[f.access]} · ${FORM_STATUS_TEXT[f.status]}`,
        }));
    default:
      return unhandledItemType(type);
  }
};
