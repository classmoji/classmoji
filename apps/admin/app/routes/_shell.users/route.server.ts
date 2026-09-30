import { prisma, requirePlatformAdmin } from '~/utils/db.server';
// The light subpath — the cookie-domain resolution with none of betterAuth or
// Prisma behind it.
import { COOKIE_DOMAIN } from '@classmoji/auth/secret';
import { GIT_IDENTITY } from '@classmoji/database';
import { displayUsername, gitAccount } from '@classmoji/utils';
import type { LoaderFunctionArgs } from 'react-router';

/** Cap on rows returned. Search narrows; this only bounds the unfiltered view. */
const RESULT_LIMIT = 50;

export interface AdminUserRow {
  id: string;
  login: string | null;
  name: string | null;
  email: string | null;
  image: string | null;
  createdAt: string;
  classrooms: { slug: string; name: string; role: string }[];
}

export async function loadUsers({ request }: LoaderFunctionArgs) {
  const { user: admin } = await requirePlatformAdmin(request);

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').trim();

  // Search server-side rather than filtering in the browser: this is the whole
  // users table, not a classroom roster.
  const where = q
    ? {
        OR: [
          { email: { contains: q, mode: 'insensitive' as const } },
          { name: { contains: q, mode: 'insensitive' as const } },
          {
            accounts: {
              some: {
                OR: [
                  { username: { contains: q, mode: 'insensitive' as const } },
                  { email: { contains: q, mode: 'insensitive' as const } },
                ],
              },
            },
          },
        ],
      }
    : {};

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: RESULT_LIMIT,
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        ...GIT_IDENTITY,
        created_at: true,
        classroom_memberships: {
          select: { role: true, classroom: { select: { slug: true, name: true } } },
        },
      },
    }),
    prisma.user.count({ where }),
  ]);

  const rows: AdminUserRow[] = users.map(u => ({
    id: u.id,
    login: displayUsername(u),
    name: u.name,
    email: u.email ?? gitAccount(u)?.email ?? null,
    image: u.image,
    createdAt: u.created_at.toISOString(),
    classrooms: u.classroom_memberships.map(m => ({
      slug: m.classroom.slug,
      name: m.classroom.name,
      role: m.role,
    })),
  }));

  return {
    rows,
    total,
    query: q,
    truncated: total > rows.length,
    limit: RESULT_LIMIT,
    adminUserId: admin.id,
    webappUrl: process.env.WEBAPP_URL ?? 'http://localhost:3000',
    // Scope for the return-path breadcrumb cookie. Same resolution the session
    // cookie uses, so it reaches the webapp under exactly the conditions the
    // session does: null in dev (host-only on localhost, shared across ports),
    // `.{SITE_BASE_DOMAIN}` in deployed envs (shared across subdomains).
    cookieDomain: COOKIE_DOMAIN,
  };
}
