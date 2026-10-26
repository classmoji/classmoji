import type { FeedbackCategory, FeedbackStatus } from '@prisma/client';

/** What the board shows about a person: never more than a name and a picture. */
export interface FeedbackAuthor {
  id: string;
  name: string | null;
  image: string | null;
}

export interface FeedbackPostSummary {
  id: string;
  title: string;
  body: string;
  category: FeedbackCategory;
  status: FeedbackStatus | null;
  vote_count: number;
  comment_count: number;
  created_at: string | Date;
  author: FeedbackAuthor | null;
  is_anonymous: boolean;
  viewerVoted: boolean;
  /** A bug report's first field; the list shows it instead of the full body. */
  bug_what_happened?: string | null;
}

export interface FeedbackCommentView {
  id: string;
  body: string;
  vote_count: number;
  created_at: string | Date;
  author: FeedbackAuthor | null;
  is_anonymous: boolean;
  /** The viewer wrote it (an anonymous comment has no author to compare). */
  viewerIsAuthor: boolean;
  viewerVoted: boolean;
  replies?: FeedbackCommentView[];
}

/** The roadmap's columns: a feature request's statuses. */
export const STATUS_ORDER = [
  'IN_REVIEW',
  'PLANNED',
  'IN_PROGRESS',
  'COMPLETED',
] as const satisfies readonly FeedbackStatus[];

/** Each type's statuses (mirrors FEEDBACK_STATUSES_BY_CATEGORY in the service). */
export const STATUSES_BY_CATEGORY: Record<FeedbackCategory, FeedbackStatus[]> = {
  FEATURE: [...STATUS_ORDER],
  BUG: ['FIXED'],
  QUESTION: ['ANSWERED'],
};

export const ALL_STATUSES: FeedbackStatus[] = [
  ...STATUSES_BY_CATEGORY.FEATURE,
  ...STATUSES_BY_CATEGORY.BUG,
  ...STATUSES_BY_CATEGORY.QUESTION,
];

export const STATUS_META: Record<
  FeedbackStatus,
  { label: string; description: string; ink: string }
> = {
  IN_REVIEW: { label: 'In review', description: 'Under consideration', ink: 'text-sky-ink' },
  PLANNED: { label: 'Planned', description: 'Committed and queued', ink: 'text-lilac-ink' },
  IN_PROGRESS: { label: 'In progress', description: 'Actively being built', ink: 'text-amber-ink' },
  COMPLETED: { label: 'Completed', description: 'Recently shipped', ink: 'text-mint-ink' },
  FIXED: { label: 'Fixed', description: 'The fix has shipped', ink: 'text-mint-ink' },
  ANSWERED: { label: 'Answered', description: 'See the replies', ink: 'text-mint-ink' },
};

export const CATEGORY_ORDER: FeedbackCategory[] = ['FEATURE', 'BUG', 'QUESTION'];

export const CATEGORY_EMOJI: Record<FeedbackCategory, string> = {
  FEATURE: '💡',
  BUG: '🐛',
  QUESTION: '❓',
};

export const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  FEATURE: 'Feature Request',
  BUG: 'Bug',
  QUESTION: 'Question',
};

/**
 * A bug report's sections, as on the Github bug template (mirrors
 * BUG_SECTION_LABELS in the service, which writes them into the body).
 */
export const BUG_SECTIONS = [
  { field: 'bug_what_happened', label: 'What happened?' },
  { field: 'bug_expected', label: 'What should have happened?' },
  { field: 'bug_steps', label: 'Steps to reproduce' },
  { field: 'bug_additional_info', label: 'Additional info' },
] as const;

/** Plural names for the board's type filter. */
export const CATEGORY_FILTER_LABELS: Record<FeedbackCategory, string> = {
  FEATURE: 'Feature requests',
  BUG: 'Bugs',
  QUESTION: 'Questions',
};

export const isCategory = (value: string | null): value is FeedbackCategory =>
  value === 'FEATURE' || value === 'BUG' || value === 'QUESTION';

/**
 * The name shown for a post or comment: "Anonymous" when the author asked for
 * it, and "Former user" when their account is gone.
 */
export const authorName = (author: FeedbackAuthor | null, anonymous = false) =>
  anonymous ? 'Anonymous' : author?.name || 'Former user';

export const timeAgo = (value: string | Date): string => {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  const units: [number, string][] = [
    [31536000, 'year'],
    [2592000, 'month'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
};

export const formatDate = (value: string | Date) =>
  new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** Where a signed-out click goes: sign in, then back to the page they were on. */
export const signInHref = (path: string) => `/?redirect=${encodeURIComponent(path)}`;

/** The one endpoint every board action posts to. */
export const FEEDBACK_ACTION = '/api/feedback';
