import { Link, Outlet, useLocation } from 'react-router';

import { ClassmojiService } from '@classmoji/services';
import { INSIGHT_AUDIT_TOOLS, requireAskMojiInsights } from './insights.server';
import {
  REVIEW_LIMIT,
  ROLE_LABEL,
  USAGE_WEEKS,
  ratingFromSearch,
  toReviewRowView,
  toUsageView,
  type MaterialView,
  type ReviewRowView,
  type UsageView,
} from './insightsView';
import type { Route } from './+types/route';

/**
 * Ask Moji insights: weekly usage, the materials students ask from and the
 * answers cite, and the feedback review. OWNER and TEACHER of the classroom
 * (`/teacher/:class/ask-moji` re-exports this route); 404 where Ask Moji is
 * not available. See ./insights.server.ts for the gate and the audit rows.
 */
export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const access = await requireAskMojiInsights(request, params.class!, 'view_insights');
  const rating = ratingFromSearch(new URL(request.url).searchParams);

  const [usage, review] = await Promise.all([
    ClassmojiService.askMojiInsights.usage({
      classroomId: access.classroomId,
      weeks: USAGE_WEEKS,
      timeZone: access.timeZone,
    }),
    ClassmojiService.askMojiInsights.feedbackReview({
      classroomId: access.classroomId,
      viewerRole: access.viewerRole,
      rating,
      limit: REVIEW_LIMIT,
    }),
  ]);

  // Two reads of other people's activity, one row each.
  await access.audit({
    resourceType: 'ASK_MOJI_INSIGHTS',
    resourceId: access.classroomId,
    tool: INSIGHT_AUDIT_TOOLS.usage,
    data: { weeks: USAGE_WEEKS },
  });
  await access.audit({
    resourceType: 'ASK_MOJI_FEEDBACK',
    resourceId: access.classroomId,
    tool: INSIGHT_AUDIT_TOOLS.review,
    data: { rating, feedback_ids: review.map(row => row.feedbackId) },
  });

  const usageView = toUsageView(usage);
  return {
    viewerRole: access.viewerRole,
    rating,
    usage: usageView,
    review: review.map(row => toReviewRowView(row, usageView.timeZone)),
  };
};

const CARD =
  'rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 p-5 sm:p-6';

const n = (value: number) => value.toLocaleString('en-US');

const plural = (count: number, one: string, many: string) =>
  `${n(count)} ${count === 1 ? one : many}`;

const EmptyState = ({ title, detail }: { title: string; detail?: string }) => (
  <div className="text-center py-12 text-gray-500">
    <div className="font-medium">{title}</div>
    {detail && <div className="text-sm">{detail}</div>}
  </div>
);

const SectionTitle = ({ title, detail }: { title: string; detail?: string }) => (
  <div className="mb-3">
    <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{title}</h2>
    {detail && <p className="text-xs text-gray-500 dark:text-gray-400">{detail}</p>}
  </div>
);

const UsageTable = ({ usage }: { usage: UsageView }) => {
  const max = Math.max(1, ...usage.weeks.map(week => week.questions));
  const anyActivity = usage.weeks.some(
    week => week.questions > 0 || week.staffQuestions > 0 || week.tokensIn > 0
  );
  if (!anyActivity) {
    return (
      <EmptyState
        title="No questions yet"
        detail={`Last ${plural(usage.weeks.length, 'week', 'weeks')}`}
      />
    );
  }
  const head = 'px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400';
  const num = 'px-3 py-2 text-right tabular-nums text-gray-700 dark:text-gray-300';
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="ask-moji-usage">
        <thead>
          <tr className="border-b border-stone-200 dark:border-neutral-800">
            <th className={head}>Week of</th>
            <th className={head}>Questions</th>
            <th className={`${head} text-right`}>Conversations</th>
            <th className={`${head} text-right`}>Active students</th>
            <th className={`${head} text-right`}>Staff questions</th>
            <th className={`${head} text-right`}>Tokens in</th>
            <th className={`${head} text-right`}>Tokens out</th>
          </tr>
        </thead>
        <tbody>
          {usage.weeks.map(week => (
            <tr
              key={week.weekStart}
              className="border-b border-stone-100 dark:border-neutral-800/60 last:border-0"
            >
              <td className="px-3 py-2 whitespace-nowrap text-gray-700 dark:text-gray-300">
                {week.label}
              </td>
              <td className="px-3 py-2 min-w-40">
                <div className="flex items-center gap-2">
                  <div className="h-2 flex-1 rounded-full bg-stone-100 dark:bg-neutral-800">
                    <div
                      className="h-2 rounded-full"
                      style={{
                        width: `${(week.questions / max) * 100}%`,
                        backgroundColor: 'var(--accent)',
                      }}
                    />
                  </div>
                  <span className="w-10 text-right tabular-nums text-gray-700 dark:text-gray-300">
                    {n(week.questions)}
                  </span>
                </div>
              </td>
              <td className={num}>{n(week.conversations)}</td>
              <td className={num}>{n(week.activeStudents)}</td>
              <td className={num}>{n(week.staffQuestions)}</td>
              <td className={num}>{n(week.tokensIn)}</td>
              <td className={num}>{n(week.tokensOut)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const MaterialList = ({
  rows,
  unit,
  minAskers,
}: {
  rows: MaterialView[];
  unit: { one: string; many: string };
  minAskers: number;
}) => {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing to show yet"
        detail={`Shown for materials with ${n(minAskers)} or more students.`}
      />
    );
  }
  return (
    <ul className="divide-y divide-stone-100 dark:divide-neutral-800">
      {rows.map(row => (
        <li key={row.key} className="flex items-baseline justify-between gap-3 py-2 text-sm">
          <span className="min-w-0 truncate text-gray-800 dark:text-gray-200">
            <span className="mr-2 text-xs text-gray-500 dark:text-gray-400">{row.kind}</span>
            {row.title}
          </span>
          <span className="shrink-0 tabular-nums text-xs text-gray-500 dark:text-gray-400">
            {plural(row.count, unit.one, unit.many)} · {plural(row.askers, 'student', 'students')}
          </span>
        </li>
      ))}
    </ul>
  );
};

const RatingFilter = ({ rating }: { rating: 'UP' | 'DOWN' }) => {
  const pill = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors ${
      active
        ? 'bg-stone-100 text-gray-900 ring-stone-300 dark:bg-neutral-800 dark:text-gray-100 dark:ring-neutral-600'
        : 'text-gray-600 ring-stone-200 hover:bg-stone-50 dark:text-gray-400 dark:ring-neutral-800 dark:hover:bg-neutral-800/60'
    }`;
  return (
    <div className="flex gap-2" role="group" aria-label="Filter by rating">
      <Link
        to={{ pathname: '.', search: '' }}
        preventScrollReset
        className={pill(rating === 'DOWN')}
        aria-current={rating === 'DOWN' ? 'true' : undefined}
      >
        👎 Not helpful
      </Link>
      <Link
        to={{ pathname: '.', search: '?rating=up' }}
        preventScrollReset
        className={pill(rating === 'UP')}
        aria-current={rating === 'UP' ? 'true' : undefined}
      >
        👍 Helpful
      </Link>
    </div>
  );
};

const ReviewList = ({ rows, rating }: { rows: ReviewRowView[]; rating: 'UP' | 'DOWN' }) => {
  const { search } = useLocation();
  if (rows.length === 0) {
    return <EmptyState title={rating === 'DOWN' ? 'No 👎 answers' : 'No 👍 answers'} />;
  }
  return (
    <ul className="divide-y divide-stone-100 dark:divide-neutral-800" data-testid="ask-moji-review">
      {rows.map(row => (
        <li key={row.feedbackId}>
          <Link
            to={{ pathname: row.feedbackId, search }}
            preventScrollReset
            className="block rounded-lg px-2 py-3 -mx-2 hover:bg-stone-50 dark:hover:bg-neutral-800/60"
          >
            <div className="line-clamp-2 text-sm text-gray-800 dark:text-gray-200">
              {row.question}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
              <span className="font-medium text-gray-600 dark:text-gray-300">{row.askerName}</span>
              {row.askerRole !== ROLE_LABEL.STUDENT && (
                <span className="rounded-sm bg-stone-100 px-1.5 py-0.5 dark:bg-neutral-800">
                  {row.askerRole}
                </span>
              )}
              <span>{row.when}</span>
              {row.viewing && (
                <span className="min-w-0 truncate">
                  Viewing {row.viewing.kind}: {row.viewing.title}
                  {row.viewing.detail ? ` · ${row.viewing.detail}` : ''}
                </span>
              )}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
};

const AskMojiInsights = ({ loaderData }: Route.ComponentProps) => {
  const { usage, review, rating } = loaderData;

  return (
    <div className="min-h-full relative">
      <Outlet />

      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-base font-semibold text-gray-600 dark:text-gray-400">
          Ask Moji insights
        </h1>
      </div>

      <div className={`${CARD} min-h-[calc(100vh-10rem)] space-y-8`}>
        <section>
          <SectionTitle title="Usage" detail={`Weeks start Monday · ${usage.timeZone}`} />
          <UsageTable usage={usage} />
        </section>

        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          <section>
            <SectionTitle
              title="Asked from"
              detail={`What students had open · last ${plural(usage.weeks.length, 'week', 'weeks')}`}
            />
            <MaterialList
              rows={usage.askedFrom}
              unit={{ one: 'question', many: 'questions' }}
              minAskers={usage.minAskers}
            />
          </section>
          <section>
            <SectionTitle
              title="Most cited"
              detail={`What answers to students cited · last ${plural(usage.weeks.length, 'week', 'weeks')}`}
            />
            <MaterialList
              rows={usage.mostCited}
              unit={{ one: 'citation', many: 'citations' }}
              minAskers={usage.minAskers}
            />
          </section>
        </div>

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <SectionTitle title="Feedback" />
            <RatingFilter rating={rating} />
          </div>
          <ReviewList rows={review} rating={rating} />
        </section>
      </div>
    </div>
  );
};

export default AskMojiInsights;
