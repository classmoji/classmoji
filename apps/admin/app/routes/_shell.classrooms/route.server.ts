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
  // Example classrooms are the auto-provisioned per-user "Example Course"
  // sandbox behind the onboarding tour — one per signed-up user, so they swamp
  // the list and are almost never what an admin is looking for. Hidden unless
  // asked for.
  const includeExamples = url.searchParams.get('examples') === '1';

  const search = q
    ? {
        OR: [
          { name: { contains: q, mode: 'insensitive' as const } },
          { slug: { contains: q, mode: 'insensitive' as const } },
          { git_organization: { login: { contains: q, mode: 'insensitive' as const } } },
        ],
      }
    : {};

  const where = includeExamples ? search : { ...search, is_example: false };

  const [classrooms, exampleCount] = await Promise.all([
    prisma.classroom.findMany({
      where,
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
    }),
    // How many the filter is hiding, so the UI can say so rather than silently
    // truncating. Counted against the same search so the number is meaningful.
    prisma.classroom.count({ where: { ...search, is_example: true } }),
  ]);

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

  return {
    rows,
    total: rows.length,
    query: q,
    includeExamples,
    // Only meaningful while they're hidden; once shown they're in `total`.
    hiddenExamples: includeExamples ? 0 : exampleCount,
  };
}
