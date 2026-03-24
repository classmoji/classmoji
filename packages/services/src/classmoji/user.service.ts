import _ from 'lodash';
import prisma from '@classmoji/database';

export const create = async (userData: any, classroomData: any, role: string) => {
  const whereClause = userData.login ? { login: userData.login } : { email: userData.email };

  // Get the provider from the classroom's git_organization
  const provider = classroomData.git_organization.provider;

  return prisma!.user.upsert({
    where: whereClause,
    update: {
      // Always create a new membership for the classroom on update
      classroom_memberships: {
        create: {
          classroom_id: classroomData.id,
          role: role as any,
          is_grader: role === 'ASSISTANT' ? true : false,
          has_accepted_invite: false,
        },
      },
    },
    create: {
      // If user doesn't exist, create the user and the membership
      ...userData,
      provider: provider,
      classroom_memberships: {
        create: {
          classroom_id: classroomData.id,
          role: role as any,
          is_grader: role === 'ASSISTANT' ? true : false,
          has_accepted_invite: false,
        },
      },
    },
  });
};

export const findBy = ({ where }: { where: any }) => {
  return prisma!.user.findUnique({
    where,
  });
};

export const update = async (userId: string, updates: any) => {
  return prisma!.user.update({
    where: { id: userId },
    data: updates,
  });
};

export const deleteByLogin = async (login: string) => {
  return prisma!.user.delete({
    where: { login },
  });
};

export const findRepositoriesPerStudent = async (classroom: any) => {
  const includeRepos = {
    repositories: {
      include: {
        module: true,
        assignments: {
          include: {
            token_transactions: true,
            assignment: true,
            grades: true,
          },
        },
      },
    },
  };

  // 1. find student repos
  const studentWithRepos = await prisma!.user.findMany({
    where: {
      classroom_memberships: {
        some: { classroom: { slug: classroom.slug }, role: 'STUDENT' },
      },
    },
    include: includeRepos,
  });

  // 2. find team repos that students belong to
  let studentsWithTeamRepos = await prisma!.user.findMany({
    where: {
      team_memberships: {
        some: {
          team: {
            classroom_id: classroom.id,
          },
        },
      },
    },
    include: {
      team_memberships: {
        include: {
          team: {
            include: includeRepos,
          },
        },
      },
    },
  });

  // 3. combine results
  const combined = _(studentWithRepos)
    .concat(studentsWithTeamRepos as any) // Combine arrays
    .groupBy('id') // Group by id
    .map(items => {
      const [studentData, teamData]: any[] = items;
      const teamRepos = (teamData?.team_memberships || []).map(({ team }: any) => team.repositories);

      return {
        ...studentData,
        repositories: [...(studentData?.repositories || []), ...teamRepos.flat()],
      };
    })
    .value();

  combined.sort((a, b) => {
    const lastNameA = a.name?.split(' ').pop() || '';
    const lastNameB = b.name?.split(' ').pop() || '';
    return lastNameA.localeCompare(lastNameB);
  });

  // Transform data to match expected shape for grades page
  // New schema: Repository.module, Repository.assignments (RepositoryAssignment[])
  // Expected: repository.assignment_id, repository.assignment, repository.issues
  return combined.map(student => ({
    ...student,
    repositories: student.repositories.map((repo: any) => ({
      ...repo,
      // Map module to assignment for backward compatibility with grades UI
      assignment_id: repo.module?.id,
      assignment: repo.module
        ? {
            id: repo.module.id,
            title: repo.module.title,
            weight: repo.module.weight,
            is_extra_credit: repo.module.is_extra_credit,
            drop_lowest_count: repo.module.drop_lowest_count,
            type: repo.module.type,
          }
        : null,
      // RepositoryAssignments with their Assignment data
      repositoryAssignments: (repo.assignments || []).map((repoAssignment: any) => ({
        ...repoAssignment,
        assignment_id: repoAssignment.assignment?.id,
        // Note: 'assignment' is already included via spread from Prisma include
      })),
    })),
  }));
};

export const findById = async (id: string, options: { includeMemberships?: boolean } = {}) => {
  const { includeMemberships = false } = options;

  const user = await prisma!.user.findUnique({
    where: { id },
    include: includeMemberships ? {
      classroom_memberships: {
        include: {
          classroom: {
            include: {
              git_organization: true,
              memberships: {
                where: { role: 'OWNER' },
              },
              _count: {
                select: { modules: true },
              },
            },
          },
        },
      },
    } : undefined,
  });

  if (!user) return null;

  // Transform to backward compatible format for UI if memberships included
  if (includeMemberships && (user as any).classroom_memberships) {
    return {
      ...user,
      memberships: (user as any).classroom_memberships.map((m: any) => ({
        ...m,
        organization: {
          ...m.classroom,
          login: m.classroom.slug, // Use slug as "login" for URL compatibility
          is_active: m.classroom.is_active,
          assignments: { _count: m.classroom._count?.modules || 0 },
          memberships: m.classroom.memberships,
        },
      })),
    };
  }

  return user;
};

// TODO: refactor to just take any
export const findByLogin = async (login: string) => {
  const user = await prisma!.user.findUnique({
    where: { login },
    include: {
      classroom_memberships: {
        include: {
          classroom: {
            include: {
              git_organization: true,
              memberships: {
                where: { role: 'OWNER' },
              },
              _count: {
                select: { modules: true },
              },
            },
          },
        },
      },
    },
  });

  if (!user) return null;

  // Transform to backward compatible format for UI
  // TODO: Update all consumers to use classroom_memberships directly
  return {
    ...user,
    memberships: user.classroom_memberships.map(m => ({
      ...m,
      organization: {
        ...m.classroom,
        login: m.classroom.slug, // Use slug as "login" for URL compatibility
        is_active: m.classroom.is_active,
        assignments: { _count: m.classroom._count?.modules || 0 },
        memberships: m.classroom.memberships,
      },
    })),
  };
};
