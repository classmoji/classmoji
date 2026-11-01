import type { LoaderFunctionArgs } from 'react-router';
import { requirePlatformAdmin } from '~/utils/db.server';
import { loadAttention, loadKpis, loadLatestActivity } from '~/utils/metrics.server';
import { REPORTING_TZ } from '~/utils/time';

/**
 * Home: what needs doing, then how the week is going. Growth reporting lives
 * on Insights; nothing here is a chart you can only look at.
 */
export async function loadHome({ request }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);
  const now = new Date();
  const [kpis, attention, activity] = await Promise.all([
    loadKpis(now),
    loadAttention(now),
    loadLatestActivity(10),
  ]);
  return {
    generatedAt: now.toISOString(),
    timeZone: REPORTING_TZ,
    kpis,
    attention,
    activity,
  };
}

export type HomeData = Awaited<ReturnType<typeof loadHome>>;
