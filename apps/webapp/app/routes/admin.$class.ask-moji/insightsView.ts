/**
 * What the Ask Moji insights screens send to the browser, built field by
 * field from the service results (askMojiInsights). Pure: no request, no
 * database, so the loaders and their tests share one copy.
 *
 * Every string the page shows is filled from these fields; times are
 * formatted here, in the course time zone the usage view used, so the page
 * never shows a raw UTC clock time.
 */
import type {
  AskMojiFeedbackExchange,
  AskMojiFeedbackReviewRow,
  AskMojiMaterialRow,
  AskMojiRating,
  AskMojiResolvedViewing,
  AskMojiUsageInsights,
} from '@classmoji/services';

/** Weeks the usage table covers. */
export const USAGE_WEEKS = 12;

/** Feedback rows the review list shows. */
export const REVIEW_LIMIT = 50;

/** The review filter in the URL (`?rating=up`); anything else is the default, 👎. */
export const ratingFromSearch = (search: URLSearchParams): AskMojiRating =>
  search.get('rating') === 'up' ? 'UP' : 'DOWN';

export const KIND_LABEL: Record<string, string> = {
  page: 'Page',
  deck: 'Slides',
  module: 'Module',
  assignment: 'Assignment',
  quiz: 'Quiz',
  calendar: 'Calendar',
  platform_docs: 'Docs',
};

export const ROLE_LABEL: Record<string, string> = {
  OWNER: 'Owner',
  TEACHER: 'Teacher',
  ASSISTANT: 'Assistant',
  STUDENT: 'Student',
};

/** `Oct 12, 3:04 PM` in the course zone (plain spaces, whatever the ICU build). */
export const formatWhen = (at: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
    .format(at)
    .replace(/[\u202f\u00a0]/g, ' ');

/** A week's Monday (`YYYY-MM-DD`, already a course-zone date) as `Oct 12`. */
export const weekLabel = (weekStart: string): string => {
  const date = new Date(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return weekStart;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  }).format(date);
};

export type ViewingView = { kind: string; title: string; detail: string | null };

const viewingView = (viewing: AskMojiResolvedViewing | null): ViewingView | null =>
  viewing
    ? {
        kind: KIND_LABEL[viewing.kind] ?? viewing.kind,
        title: viewing.title,
        detail: viewing.detail ?? null,
      }
    : null;

export type UsageWeekView = {
  weekStart: string;
  label: string;
  questions: number;
  conversations: number;
  activeStudents: number;
  staffQuestions: number;
  tokensIn: number;
  tokensOut: number;
};

export type MaterialView = {
  key: string;
  kind: string;
  title: string;
  askers: number;
  count: number;
};

export type UsageView = {
  timeZone: string;
  minAskers: number;
  weeks: UsageWeekView[];
  askedFrom: MaterialView[];
  mostCited: MaterialView[];
};

const materialView = (row: AskMojiMaterialRow, n: number): MaterialView => ({
  key: `${row.kind}:${row.id ?? row.path ?? n}`,
  kind: KIND_LABEL[row.kind] ?? row.kind,
  title: row.title,
  askers: row.askers,
  count: row.count,
});

/** The usage view: newest week first. Cache token counts are not shown. */
export const toUsageView = (usage: AskMojiUsageInsights): UsageView => ({
  timeZone: usage.timeZone,
  minAskers: usage.minAskers,
  weeks: [...usage.weeks].reverse().map(week => ({
    weekStart: week.weekStart,
    label: weekLabel(week.weekStart),
    questions: week.questions,
    conversations: week.conversations,
    activeStudents: week.activeStudents,
    staffQuestions: week.staffQuestions,
    tokensIn: week.tokensIn,
    tokensOut: week.tokensOut,
  })),
  askedFrom: usage.askedFrom.map(materialView),
  mostCited: usage.mostCited.map(materialView),
});

export type ReviewRowView = {
  feedbackId: string;
  rating: AskMojiRating;
  askerName: string;
  askerRole: string;
  question: string;
  when: string;
  viewing: ViewingView | null;
};

/** A name for a user without one. */
export const UNNAMED = 'Unnamed user';

export const toReviewRowView = (
  row: AskMojiFeedbackReviewRow,
  timeZone: string
): ReviewRowView => ({
  feedbackId: row.feedbackId,
  rating: row.rating,
  askerName: row.asker.name?.trim() || UNNAMED,
  askerRole: ROLE_LABEL[row.askerRole] ?? row.askerRole,
  question: row.question,
  when: formatWhen(row.createdAt, timeZone),
  viewing: viewingView(row.viewing),
});

export type SourceView = { title: string; url: string | null };

export type ExchangeView = {
  feedbackId: string;
  rating: AskMojiRating;
  askerName: string;
  askerRole: string;
  when: string;
  viewing: ViewingView | null;
  question: string;
  answer: string;
  sources: SourceView[];
  steps: string[];
};

type LoosePart = {
  type?: unknown;
  text?: unknown;
  state?: unknown;
  output?: unknown;
  data?: unknown;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const textOf = (parts: readonly unknown[]): string =>
  parts
    .map(p => p as LoosePart)
    .filter(p => p.type === 'text' && typeof p.text === 'string')
    .map(p => p.text as string)
    .join('\n\n')
    .trim();

const httpUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
};

/** The sources the answer cited (server-checked `cite_content` results), each once. */
const sourcesOf = (parts: readonly unknown[]): SourceView[] => {
  const out: SourceView[] = [];
  const seen = new Set<string>();
  for (const raw of parts) {
    const part = raw as LoosePart;
    if (part.type !== 'tool-cite_content' || part.state !== 'output-available') continue;
    if (!isRecord(part.output) || part.output.ok !== true) continue;
    const title = typeof part.output.title === 'string' ? part.output.title : '';
    if (!title) continue;
    const url = httpUrl(part.output.url);
    const key = `${title}\n${url ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, url });
  }
  return out;
};

/** The step lines the answer showed while it looked things up. */
const stepsOf = (parts: readonly unknown[]): string[] =>
  parts
    .map(p => p as LoosePart)
    .filter(p => p.type === 'data-step' && isRecord(p.data) && typeof p.data.title === 'string')
    .map(p => (p.data as { title: string }).title);

export const toExchangeView = (ex: AskMojiFeedbackExchange, timeZone: string): ExchangeView => ({
  feedbackId: ex.feedbackId,
  rating: ex.rating,
  askerName: ex.asker.name?.trim() || UNNAMED,
  askerRole: ROLE_LABEL[ex.askerRole] ?? ex.askerRole,
  when: formatWhen(ex.createdAt, timeZone),
  viewing: viewingView(ex.viewing),
  question: textOf(ex.question.parts),
  answer: textOf(ex.answer.parts),
  sources: sourcesOf(ex.answer.parts),
  steps: stepsOf(ex.answer.parts),
});
