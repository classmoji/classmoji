import type { LoaderFunctionArgs } from 'react-router';
import type { Prisma } from '@prisma/client';
import { prisma, requirePlatformAdmin } from '~/utils/db.server';
import { healthOf, loadPlans, loadSignals } from '~/utils/classroomHealth.server';

const PAGE_SIZE = 50;

/** Status chips; '' (the default) is ACTIVE. Examples only when asked for. */
const STATUS = {
  '': { label: 'Active', where: { is_example: false, is_archived: false, status: 'ACTIVE' } },
  locked: { label: 'Locked', where: { is_example: false, is_archived: false, status: 'LOCKED' } },
  unpublished: {
    label: 'Unpublished',
    where: { is_example: false, is_archived: false, status: 'UNPUBLISHED' },
  },
  archived: { label: 'Archived', where: { is_example: false, is_archived: true } },
  all: { label: 'All', where: { is_example: false } },
  examples: { label: 'Examples', where: { is_example: true } },
} satisfies Record<string, { label: string; where: Prisma.ClassroomWhereInput }>;
type StatusKey = keyof typeof STATUS;

const SORTS = ['activity', 'created', 'students', 'name'] as const;
type SortKey = (typeof SORTS)[number];

const searchWhere = (q: string): Prisma.ClassroomWhereInput => {
  if (!q) return {};
  const has = { contains: q, mode: 'insensitive' as const };
  return {
    OR: [
      { name: has },
      { slug: has },
      { git_organization: { login: has } },
      { memberships: { some: { role: 'OWNER', user: { name: has } } } },
    ],
  };
};

export async function loadClassrooms({ request }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const statusParam = url.searchParams.get('status') ?? '';
  const status: StatusKey = statusParam in STATUS ? (statusParam as StatusKey) : '';
  const provider = url.searchParams.get('provider');
  const problemsOnly = url.searchParams.get('health') === 'problems';
  const sortParam = url.searchParams.get('sort') ?? '';
  const sort: SortKey = (SORTS as readonly string[]).includes(sortParam)
    ? (sortParam as SortKey)
    : 'activity';
  const dir = url.searchParams.get('dir') === 'asc' ? 1 : -1;
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);

  const search = searchWhere(q);
  const where: Prisma.ClassroomWhereInput = {
    AND: [
      search,
      STATUS[status].where,
      provider === 'github' || provider === 'gitlab'
        ? { git_organization: { provider: provider.toUpperCase() as 'GITHUB' | 'GITLAB' } }
        : {},
    ],
  };

  // Light rows for every match: sorting by activity or roster size and the
  // "has problems" filter need aggregates, so they are computed over the
  // filtered set, then one page is loaded in full.
  const [light, statusCounts] = await Promise.all([
    prisma.classroom.findMany({
      where,
      select: {
        id: true,
        name: true,
        created_at: true,
        git_organization: {
          select: { provider: true, github_installation_id: true, gitlab_connection_id: true },
        },
        import_job: { select: { status: true } },
      },
    }),
    Promise.all(
      (Object.keys(STATUS) as StatusKey[]).map(k =>
        prisma.classroom.count({ where: { AND: [search, STATUS[k].where] } })
      )
    ),
  ]);

  const signals = await loadSignals(light);
  let rows = light.map(c => {
    const s = signals.get(c.id)!;
    return { ...c, signals: s, ...healthOf(s) };
  });
  const problems = rows.filter(r => r.health !== 'ok').length;
  if (problemsOnly) rows = rows.filter(r => r.health !== 'ok');

  const key = (r: (typeof rows)[number]): number | string => {
    switch (sort) {
      case 'activity':
        return r.signals.lastActivity?.getTime() ?? 0;
      case 'created':
        return r.created_at.getTime();
      case 'students':
        return r.signals.accepted;
      case 'name':
        return r.name.toLowerCase();
    }
  };
  const effectiveDir = sort === 'name' && !url.searchParams.get('dir') ? 1 : dir;
  rows.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return (ka < kb ? -1 : ka > kb ? 1 : 0) * effectiveDir || a.name.localeCompare(b.name);
  });

  const total = rows.length;
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const ids = pageRows.map(r => r.id);
  const [details, plans] = await Promise.all([
    prisma.classroom.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        slug: true,
        status: true,
        is_archived: true,
        is_example: true,
        content_delivery_enabled: true,
        git_organization: { select: { login: true } },
        memberships: {
          where: { role: 'OWNER', has_accepted_invite: true },
          orderBy: { created_at: 'asc' },
          take: 1,
          select: { user: { select: { id: true, name: true } } },
        },
      },
    }),
    loadPlans(ids),
  ]);
  const detail = new Map(details.map(d => [d.id, d]));

  return {
    query: q,
    page,
    pageSize: PAGE_SIZE,
    total,
    statusFilters: (Object.keys(STATUS) as StatusKey[]).map((k, i) => ({
      value: k,
      label: STATUS[k].label,
      count: statusCounts[i],
    })),
    problems,
    rows: pageRows.map(r => {
      const d = detail.get(r.id)!;
      const owner = d.memberships[0]?.user ?? null;
      return {
        id: r.id,
        slug: d.slug,
        name: r.name,
        status: d.status,
        isArchived: d.is_archived,
        isExample: d.is_example,
        org: d.git_organization.login,
        provider: r.signals.provider,
        owner,
        accepted: r.signals.accepted,
        pending: r.signals.pending,
        staff: r.signals.staff,
        lastActivity: r.signals.lastActivity?.toISOString() ?? null,
        createdAt: r.created_at.toISOString(),
        delivery: d.content_delivery_enabled,
        plan: plans.get(r.id) ?? 'Free',
        health: r.health,
        reasons: r.reasons,
      };
    }),
  };
}
