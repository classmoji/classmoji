import type { LoaderFunctionArgs } from 'react-router';
import { GIT_IDENTITY } from '@classmoji/database';
import { displayUsername } from '@classmoji/utils';
import { prisma, requirePlatformAdmin } from '~/utils/db.server';

/**
 * The ⌘K palette's search: people, classrooms and feedback posts at once.
 * People match on name, email, any git username or their exact id;
 * classrooms on name, slug, org or an owner's name. Example classrooms are
 * left out.
 */
const LIMIT = 6;

export async function loader({ request }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);
  const q = (new URL(request.url).searchParams.get('q') ?? '').trim();
  if (q.length < 2) return Response.json({ people: [], classrooms: [], posts: [] });
  const has = { contains: q, mode: 'insensitive' as const };

  const [people, classrooms, posts] = await Promise.all([
    prisma.user.findMany({
      where: {
        OR: [
          { id: q },
          { name: has },
          { email: has },
          { accounts: { some: { OR: [{ username: has }, { email: has }] } } },
        ],
      },
      orderBy: [{ last_seen_at: { sort: 'desc', nulls: 'last' } }],
      take: LIMIT,
      select: { id: true, name: true, email: true, image: true, ...GIT_IDENTITY },
    }),
    prisma.classroom.findMany({
      where: {
        is_example: false,
        OR: [
          { name: has },
          { slug: has },
          { git_organization: { login: has } },
          { memberships: { some: { role: 'OWNER', user: { name: has } } } },
        ],
      },
      orderBy: [{ is_archived: 'asc' }, { created_at: 'desc' }],
      take: LIMIT,
      select: {
        slug: true,
        name: true,
        is_archived: true,
        memberships: {
          where: { role: 'OWNER' },
          take: 1,
          orderBy: { created_at: 'asc' },
          select: { user: { select: { name: true } } },
        },
      },
    }),
    prisma.feedbackPost.findMany({
      where: { duplicate_of_id: null, title: has },
      orderBy: { vote_count: 'desc' },
      take: 4,
      select: { id: true, title: true, category: true, vote_count: true },
    }),
  ]);

  return Response.json({
    people: people.map(u => ({
      id: u.id,
      name: u.name ?? displayUsername(u) ?? u.email ?? u.id,
      login: displayUsername(u),
      domain: u.email?.split('@')[1] ?? null,
      image: u.image,
    })),
    classrooms: classrooms.map(c => ({
      slug: c.slug,
      name: c.name,
      archived: c.is_archived,
      owner: c.memberships[0]?.user.name ?? null,
    })),
    posts: posts.map(p => ({
      id: p.id,
      title: p.title,
      category: p.category,
      votes: p.vote_count,
    })),
  });
}
