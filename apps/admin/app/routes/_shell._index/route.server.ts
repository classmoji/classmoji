import type { LoaderFunctionArgs } from 'react-router';
import { requirePlatformAdmin } from '~/utils/db.server';
import { loadAttentionCached, loadKpis, loadLatestActivity } from '~/utils/metrics.server';
import { REPORTING_TZ } from '~/utils/time';

/**
 * Home: what needs doing, then how the week is going. Growth reporting lives
 * on Insights; nothing here is a chart you can only look at.
 *
 * The KPI tiles are the slow part (eight weeks of activity, submissions and
 * Ask Moji chats), so they stream: the page renders with Needs attention
 * (shared with the tab badge, a minute old at most) and the latest activity,
 * and the tiles fill in.
 */
export async function loadHome({ request }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);
  const now = new Date();
  const kpis = loadKpis(now);
  const [attention, activity] = await Promise.all([loadAttentionCached(), loadLatestActivity(10)]);
  return {
    generatedAt: now.toISOString(),
    timeZone: REPORTING_TZ,
    kpis,
    attention,
    activity,
  };
}

export type HomeData = Awaited<ReturnType<typeof loadHome>>;
