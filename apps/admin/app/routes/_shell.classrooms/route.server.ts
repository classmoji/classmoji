import { prisma, requirePlatformAdmin } from '~/utils/db.server';
import type { LoaderFunctionArgs } from 'react-router';

export interface ClassroomRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  isArchived: boolean;
  isExample: boolean;
  orgLogin: string;
  createdAt: string;
  students: number;
  staff: number;
}

export async function loadClassrooms({ request }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') ?? '').trim();

  const classrooms = await prisma.classroom.findMany({
    where: q
      ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { slug: { contains: q, mode: 'insensitive' } },
            { git_organization: { login: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {},
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      is_archived: true,
      is_example: true,
      created_at: true,
      git_organization: { select: { login: true } },
      // Roles are counted in one pass below rather than with four grouped
      // counts — a classroom roster is small enough that pulling the role
      // column beats four extra round trips.
      memberships: { select: { role: true } },
    },
  });

  const rows: ClassroomRow[] = classrooms.map(c => {
    // A user can hold several roles in one classroom (the membership table is
    // unique on classroom+user+role), so these are role counts, not people.
    const students = c.memberships.filter(m => m.role === 'STUDENT').length;
    return {
      id: c.id,
      slug: c.slug,
      name: c.name,
      status: c.status,
      isArchived: c.is_archived,
      isExample: c.is_example,
      orgLogin: c.git_organization.login,
      createdAt: c.created_at.toISOString(),
      students,
      staff: c.memberships.length - students,
    };
  });

  return { rows, total: rows.length, query: q };
}
