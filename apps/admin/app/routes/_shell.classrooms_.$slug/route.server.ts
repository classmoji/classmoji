import { prisma, requirePlatformAdmin } from '~/utils/db.server';
import type { LoaderFunctionArgs } from 'react-router';

export interface ClassroomMember {
  userId: string;
  login: string | null;
  name: string | null;
  email: string | null;
  image: string | null;
}

export async function loadClassroom({ request, params }: LoaderFunctionArgs) {
  await requirePlatformAdmin(request);

  const slug = params.slug as string;

  const classroom = await prisma.classroom.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      is_archived: true,
      is_example: true,
      content_repo: true,
      github_classroom_id: true,
      created_at: true,
      git_organization: {
        select: { login: true, provider: true, provider_id: true, github_installation_id: true },
      },
      memberships: {
        select: {
          role: true,
          user: {
            select: {
              id: true,
              login: true,
              name: true,
              email: true,
              provider_email: true,
              image: true,
            },
          },
        },
      },
      _count: {
        select: {
          repositories: true,
          quizzes: true,
          modules: true,
          pages: true,
          slides: true,
          teams: true,
        },
      },
    },
  });

  if (!classroom) {
    throw new Response('Classroom not found', { status: 404 });
  }

  const byRole = (role: string): ClassroomMember[] =>
    classroom.memberships
      .filter(m => m.role === role)
      .map(m => ({
        userId: m.user.id,
        login: m.user.login,
        name: m.user.name,
        email: m.user.email ?? m.user.provider_email,
        image: m.user.image,
      }))
      .sort((a, b) => (a.name ?? a.login ?? '').localeCompare(b.name ?? b.login ?? ''));

  const org = classroom.git_organization;

  return {
    classroom: {
      slug: classroom.slug,
      name: classroom.name,
      status: classroom.status,
      isArchived: classroom.is_archived,
      isExample: classroom.is_example,
      contentRepo: classroom.content_repo,
      // Set only on classrooms imported from GitHub Classroom.
      githubClassroomId: classroom.github_classroom_id,
      createdAt: classroom.created_at.toISOString(),
    },
    org: {
      login: org.login,
      provider: org.provider,
      // Missing means the GitHub App was never installed or was revoked, which
      // makes every repo operation fail in ways that look like random bugs.
      hasInstallation: Boolean(org.github_installation_id),
    },
    owners: byRole('OWNER'),
    teachers: byRole('TEACHER'),
    assistants: byRole('ASSISTANT'),
    students: byRole('STUDENT'),
    counts: classroom._count,
  };
}
