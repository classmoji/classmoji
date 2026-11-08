import type { LoaderFunctionArgs } from 'react-router';
import { requirePlatformAdmin } from '~/utils/db.server';
import {
  bucketClassSizes,
  collapseSchools,
  countryForDomain,
  SIZE_BUCKETS,
} from '~/utils/dashboard';
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

const loadGrowthSection = async (now: Date, range: GrowthRange) =>
  ({ view: 'growth', range, growth: await loadGrowth(now, range) }) as const;

const loadActivationSection = async (now: Date, range: GrowthRange) => {
  const [funnel, times] = await Promise.all([
    loadFunnel(now, FUNNEL_WEEKS[range]),
    loadOnboardingTimes(now),
  ]);
  return { view: 'activation', range, funnel, times } as const;
};

const loadAdoptionSection = async (now: Date, range: GrowthRange) => {
  const [adoption, ai, sizes] = await Promise.all([
    loadAdoption(now),
    loadAiAndQuizzes(now),
    loadClassSizes(),
  ]);
  const counts = bucketClassSizes(sizes.map(s => s.accepted));
  return {
    view: 'adoption',
    range,
    adoption,
    ai,
    classSizes: SIZE_BUCKETS.map((b, i) => ({ label: b.label, count: counts[i] })),
    largest: [...sizes].sort((a, b) => b.accepted - a.accepted).slice(0, 10),
  } as const;
};

const loadAudienceSection = async (range: GrowthRange) => {
  const domains = await loadDomainCounts();
  return {
    view: 'audience',
    range,
    domains: collapseSchools(domains, 15).map(r => ({ ...r, country: countryForDomain(r.school) })),
    totalUsers: domains.reduce((n, r) => n + r.users, 0),
  } as const;
};

/** One section's data, as each section component reads it. */
export type InsightsSection =
  | Awaited<ReturnType<typeof loadGrowthSection>>
  | Awaited<ReturnType<typeof loadActivationSection>>
  | Awaited<ReturnType<typeof loadAdoptionSection>>
  | Awaited<ReturnType<typeof loadAudienceSection>>;

/**
 * Every section on one page. They load at once, each streamed (the page
 * renders right away and a section fills in when its queries finish), so a
 * slow section doesn't hold up the others.
 */
export async function loadInsights({ request }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);
  const url = new URL(request.url);
  const rangeParam = url.searchParams.get('range') ?? '';
  const range: GrowthRange = rangeParam in GROWTH_RANGES ? (rangeParam as GrowthRange) : '12w';
  const now = new Date();

  return {
    range,
    growth: loadGrowthSection(now, range),
    activation: loadActivationSection(now, range),
    adoption: loadAdoptionSection(now, range),
    audience: loadAudienceSection(range),
  };
}
