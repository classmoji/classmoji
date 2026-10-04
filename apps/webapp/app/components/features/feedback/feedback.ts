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
}

export interface FeedbackCommentView {
  id: string;
  body: string;
  vote_count: number;
  created_at: string | Date;
  author: FeedbackAuthor | null;
  viewerVoted: boolean;
  replies?: FeedbackCommentView[];
}

export const STATUS_ORDER: FeedbackStatus[] = ['IN_REVIEW', 'PLANNED', 'IN_PROGRESS', 'COMPLETED'];

export const STATUS_META: Record<
  FeedbackStatus,
  { label: string; description: string; ink: string }
> = {
  IN_REVIEW: { label: 'In review', description: 'Under consideration', ink: 'text-sky-ink' },
  PLANNED: { label: 'Planned', description: 'Committed and queued', ink: 'text-lilac-ink' },
  IN_PROGRESS: { label: 'In progress', description: 'Actively being built', ink: 'text-amber-ink' },
  COMPLETED: { label: 'Completed', description: 'Recently shipped', ink: 'text-mint-ink' },
};

export const CATEGORY_EMOJI: Record<FeedbackCategory, string> = {
  FEATURE: '💡',
  BUG: '🐛',
  INTEGRATION: '🔌',
};

export const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  FEATURE: 'Feature Request',
  BUG: 'Bug',
  INTEGRATION: 'Integration',
};

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
