import type { LoaderFunctionArgs } from 'react-router';
import type { Prisma } from '@prisma/client';
import { GIT_IDENTITY } from '@classmoji/database';
import { displayUsername } from '@classmoji/utils';
import { prisma, requirePlatformAdmin } from '~/utils/db.server';
import { distinctClassrooms, emailDomain, highestRole } from '~/utils/people';
import { platformAudit } from '~/utils/audit.server';
import { csvResponse, toCsv } from '~/utils/csv';

const PAGE_SIZE = 50;
const CSV_LIMIT = 10_000;
const REAL = { is_example: false } as const;

/** Filter chips: '' is the default (people who have signed in). */
const FILTERS = {
  '': { label: 'Signed in', where: { first_sign_in_at: { not: null } } },
  instructors: {
    label: 'Instructors',
    where: {
      classroom_memberships: {
        some: { role: { in: ['OWNER', 'TEACHER'] }, has_accepted_invite: true, classroom: REAL },
      },
    },
  },
  assistants: {
    label: 'Assistants',
    where: {
      classroom_memberships: {
        some: { role: 'ASSISTANT', has_accepted_invite: true, classroom: REAL },
      },
    },
  },
  students: {
    label: 'Students',
    where: {
      classroom_memberships: {
        some: { role: 'STUDENT', has_accepted_invite: true, classroom: REAL },
      },
    },
  },
  never: { label: 'Never signed in', where: { first_sign_in_at: null } },
  all: { label: 'Everyone', where: {} },
} satisfies Record<string, { label: string; where: Prisma.UserWhereInput }>;
type FilterKey = keyof typeof FILTERS;

const SORTS = {
  seen: (dir: Prisma.SortOrder) => [{ last_seen_at: { sort: dir, nulls: 'last' as const } }],
  joined: (dir: Prisma.SortOrder) => [{ first_sign_in_at: { sort: dir, nulls: 'last' as const } }],
  name: (dir: Prisma.SortOrder) => [{ name: { sort: dir, nulls: 'last' as const } }],
  classes: (dir: Prisma.SortOrder) => [{ classroom_memberships: { _count: dir } }],
} satisfies Record<string, (dir: Prisma.SortOrder) => Prisma.UserOrderByWithRelationInput[]>;
type SortKey = keyof typeof SORTS;

/** Search: name, email, any git username/email, an exact id, or "@domain". */
const searchWhere = (q: string): Prisma.UserWhereInput => {
  if (!q) return {};
  if (q.startsWith('@') && q.length > 1) {
    return { email: { endsWith: q.slice(1), mode: 'insensitive' } };
  }
  const has = { contains: q, mode: 'insensitive' as const };
  return {
    OR: [
      { id: q },
      { name: has },
      { email: has },
      { accounts: { some: { OR: [{ username: has }, { email: has }] } } },
    ],
  };
};

export async function loadPeople({ request }: LoaderFunctionArgs) {
  const { user: admin } = await requirePlatformAdmin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const filterParam = url.searchParams.get('role') ?? '';
  const filter: FilterKey = filterParam in FILTERS ? (filterParam as FilterKey) : '';
  const sortParam = url.searchParams.get('sort') ?? '';
  const sort: SortKey = sortParam in SORTS ? (sortParam as SortKey) : 'seen';
  const dir: Prisma.SortOrder = url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const csv = url.searchParams.get('format') === 'csv';

  const search = searchWhere(q);
  const where: Prisma.UserWhereInput = { AND: [search, FILTERS[filter].where] };

  const [users, total, counts] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: [...SORTS[sort](dir), { id: 'asc' }],
      skip: csv ? 0 : (page - 1) * PAGE_SIZE,
      take: csv ? CSV_LIMIT : PAGE_SIZE,
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        last_seen_at: true,
        first_sign_in_at: true,
        created_at: true,
        ...GIT_IDENTITY,
        classroom_memberships: {
          where: { classroom: REAL },
          select: { role: true, has_accepted_invite: true, classroom_id: true },
        },
      },
    }),
    prisma.user.count({ where }),
    Promise.all(
      (Object.keys(FILTERS) as FilterKey[]).map(k =>
        prisma.user.count({ where: { AND: [search, FILTERS[k].where] } })
      )
    ),
  ]);

  const rows = users.map(u => {
    const providers = [
      ...new Set(
        (u.accounts ?? [])
          .map(a => a.provider_id)
          .filter((p): p is string => p === 'github' || p === 'gitlab')
      ),
    ];
    return {
      id: u.id,
      name: u.name ?? displayUsername(u) ?? u.email ?? u.id,
      login: displayUsername(u),
      email: u.email,
      image: u.image,
      domain: emailDomain(u.email),
      role: highestRole(u.classroom_memberships),
      classes: distinctClassrooms(u.classroom_memberships),
      providers,
      lastSeenAt: u.last_seen_at?.toISOString() ?? null,
      firstSignInAt: u.first_sign_in_at?.toISOString() ?? null,
      createdAt: u.created_at.toISOString(),
    };
  });

  if (csv) {
    // Names and emails leave the app: recorded like any other read of them.
    await platformAudit({
      actorId: admin.id,
      action: 'export',
      targetType: 'users',
      data: { list: 'people', rows: rows.length, filter: { q, role: filter } },
    });
    return csvResponse(
      `people-${new Date().toISOString().slice(0, 10)}.csv`,
      toCsv(
        [
          'id',
          'name',
          'username',
          'email',
          'role',
          'classes',
          'providers',
          'last_seen_at',
          'first_sign_in_at',
        ],
        rows.map(r => [
          r.id,
          r.name,
          r.login,
          r.email,
          r.role,
          r.classes,
          r.providers.join(' '),
          r.lastSeenAt,
          r.firstSignInAt,
        ])
      )
    );
  }

  return {
    query: q,
    filter,
    page,
    pageSize: PAGE_SIZE,
    total,
    filters: (Object.keys(FILTERS) as FilterKey[]).map((k, i) => ({
      value: k,
      label: FILTERS[k].label,
      count: counts[i],
    })),
    rows: rows.map(({ email: _email, ...r }) => r),
  };
}
