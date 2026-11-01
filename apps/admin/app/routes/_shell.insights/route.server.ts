import type { LoaderFunctionArgs } from 'react-router';
import { requirePlatformAdmin } from '~/utils/db.server';
import { bucketClassSizes, collapseSchools, countryForDomain, SIZE_BUCKETS } from '~/utils/dashboard';
import {
  GROWTH_RANGES,
  loadAdoption,
  loadAiAndQuizzes,
  loadClassSizes,
  loadDomainCounts,
  loadFunnel,
  loadGrowth,
  loadOnboardingTimes,
  type GrowthRange,
} from '~/utils/metrics.server';

export const VIEWS = ['growth', 'activation', 'adoption', 'audience'] as const;
export type InsightsView = (typeof VIEWS)[number];

const FUNNEL_WEEKS: Record<string, number> = { '30d': 5, '12w': 12, '26w': 26, '52w': 52 };

/** Each view loads only its own queries. */
export async function loadInsights({ request }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);
  const url = new URL(request.url);
  const view = (VIEWS as readonly string[]).includes(url.searchParams.get('view') ?? '')
    ? (url.searchParams.get('view') as InsightsView)
    : 'growth';
  const rangeParam = url.searchParams.get('range') ?? '';
  const range: GrowthRange = rangeParam in GROWTH_RANGES ? (rangeParam as GrowthRange) : '12w';
  const now = new Date();

  if (view === 'growth') {
    return { view, range, growth: await loadGrowth(now, range) } as const;
  }
  if (view === 'activation') {
    const [funnel, times] = await Promise.all([
      loadFunnel(now, FUNNEL_WEEKS[range]),
      loadOnboardingTimes(now),
    ]);
    return { view, range, funnel, times } as const;
  }
  if (view === 'adoption') {
    const [adoption, ai, sizes] = await Promise.all([
      loadAdoption(now),
      loadAiAndQuizzes(now),
      loadClassSizes(),
    ]);
    const counts = bucketClassSizes(sizes.map(s => s.accepted));
    return {
      view,
      range,
      adoption,
      ai,
      classSizes: SIZE_BUCKETS.map((b, i) => ({ label: b.label, count: counts[i] })),
      largest: [...sizes].sort((a, b) => b.accepted - a.accepted).slice(0, 10),
    } as const;
  }
  const domains = await loadDomainCounts();
  return {
    view,
    range,
    domains: collapseSchools(domains, 15).map(r => ({ ...r, country: countryForDomain(r.school) })),
    totalUsers: domains.reduce((n, r) => n + r.users, 0),
  } as const;
}
