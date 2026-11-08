import type { LoaderFunctionArgs } from 'react-router';
import { requirePlatformAdmin } from '~/utils/db.server';
import { insightsRange, loadInsightsSections } from '~/utils/insights.server';
import { loadKpis, loadLatestActivity } from '~/utils/metrics.server';
import { REPORTING_TZ } from '~/utils/time';

/**
 * Home: how the week is going (the KPI tiles), the growth reports (Growth,
 * Activation, Adoption, Email domains) and the latest activity.
 *
 * The tiles and reports are the slow part, so they stream: the page renders
 * with the activity feed, and each block fills in when its queries finish.
 */
export async function loadHome({ request }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);
  const now = new Date();
  const range = insightsRange(new URL(request.url));
  const kpis = loadKpis(now);
  const insights = loadInsightsSections(now, range);
  const activity = await loadLatestActivity(10);
  return {
    generatedAt: now.toISOString(),
    timeZone: REPORTING_TZ,
    range,
    kpis,
    ...insights,
    activity,
  };
}

export type HomeData = Awaited<ReturnType<typeof loadHome>>;
