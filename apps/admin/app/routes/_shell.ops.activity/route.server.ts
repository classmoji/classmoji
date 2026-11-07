import type { LoaderFunctionArgs } from 'react-router';
import type { Prisma } from '@prisma/client';
import { prisma, requirePlatformAdmin } from '~/utils/db.server';
import { describeAdminAction } from '~/utils/metrics.server';

const PAGE_SIZE = 50;

/** Filter chips. Page views are kept but hidden by default: they are the noise. */
const KINDS = {
  '': { label: 'Changes', where: { action: { notIn: ['user.view', 'classroom.view'] } } },
  // `impersonate` rows are from before the auth server recorded View as:
  // written when the admin asked, here, not when it started.
  impersonate: { label: 'View as', where: { action: { startsWith: 'impersonate' } } },
  delivery: { label: 'Content delivery', where: { action: { startsWith: 'delivery.' } } },
  views: { label: 'Page views', where: { action: { in: ['user.view', 'classroom.view'] } } },
  all: { label: 'Everything', where: {} },
} satisfies Record<string, { label: string; where: Prisma.PlatformAuditLogWhereInput }>;
type Kind = keyof typeof KINDS;

export async function loadActivity({ request }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);
  const url = new URL(request.url);
  const kindParam = url.searchParams.get('kind') ?? '';
  const kind: Kind = kindParam in KINDS ? (kindParam as Kind) : '';
  const actor = url.searchParams.get('actor') ?? '';
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);

  const where: Prisma.PlatformAuditLogWhereInput = {
    ...KINDS[kind].where,
    ...(actor ? { actor_id: actor } : {}),
  };

  const [rows, total, counts, actors] = await Promise.all([
    prisma.platformAuditLog.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        action: true,
        target_type: true,
        target_id: true,
        data: true,
        created_at: true,
        actor: { select: { id: true, name: true } },
      },
    }),
    prisma.platformAuditLog.count({ where }),
    Promise.all(
      (Object.keys(KINDS) as Kind[]).map(k =>
        prisma.platformAuditLog.count({
          where: { ...KINDS[k].where, ...(actor ? { actor_id: actor } : {}) },
        })
      )
    ),
    prisma.platformAuditLog.groupBy({ by: ['actor_id'], _count: { _all: true } }),
  ]);

  const actorUsers = await prisma.user.findMany({
    where: { id: { in: actors.map(a => a.actor_id).filter((id): id is string => Boolean(id)) } },
    select: { id: true, name: true, email: true },
  });

  // Classroom slugs for links, looked up once for the page.
  const classroomIds = rows
    .filter(r => r.target_type === 'classroom' && r.target_id)
    .map(r => r.target_id as string);
  const slugs = new Map(
    (
      await prisma.classroom.findMany({
        where: { id: { in: classroomIds } },
        select: { id: true, slug: true },
      })
    ).map(c => [c.id, c.slug])
  );

  return {
    kind,
    actor,
    page,
    pageSize: PAGE_SIZE,
    total,
    kinds: (Object.keys(KINDS) as Kind[]).map((k, i) => ({
      value: k,
      label: KINDS[k].label,
      count: counts[i],
    })),
    actors: actorUsers.map(u => ({ id: u.id, name: u.name ?? u.email ?? u.id })),
    rows: rows.map(r => {
      const data = (r.data ?? {}) as Record<string, unknown>;
      const href =
        r.target_type === 'user' && r.target_id
          ? `/people/${r.target_id}`
          : r.target_type === 'classroom' && r.target_id && slugs.get(r.target_id)
            ? `/classrooms/${encodeURIComponent(slugs.get(r.target_id) as string)}`
            : null;
      const filter = data.filter as { q?: string; state?: string; scope?: string } | undefined;
      return {
        id: r.id,
        at: r.created_at.toISOString(),
        action: r.action,
        actor: r.actor,
        text: describeAdminAction(r.action, r.data),
        href,
        reason: typeof data.reason === 'string' ? data.reason : null,
        filter: filter
          ? [
              filter.q ? `search “${filter.q}”` : null,
              filter.state ? `only ${filter.state}` : null,
              filter.scope === 'all' ? 'archived included' : null,
            ]
              .filter(Boolean)
              .join(', ') || 'no filter'
          : null,
      };
    }),
  };
}
