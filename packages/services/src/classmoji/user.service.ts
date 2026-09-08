import _ from 'lodash';
import getPrisma from '@classmoji/database';
import { claimPendingInvites } from './classroomInvite.service.ts';
import type { GitProvider, Prisma, GitRepo, Role } from '@prisma/client';
import type {
  Repository as GradeModule,
  GitRepo as GradeRepository,
  GitRepoAssignment as GradeRepositoryAssignment,
} from '@classmoji/utils';

interface UserCreateClassroomContext {
  id: string;
  git_organization: {
    provider: GitProvider | null;
  };
}

interface StudentRepositoryClassroomContext {
  id: string;
  slug: string;
}

interface RepositoryModuleSummary extends GradeModule {
  id: string;
  title: string;
  weight: number;
  is_extra_credit: boolean;
  drop_lowest_count: number;
  type: string;
}

interface GitRepoAssignmentRelation extends GradeRepositoryAssignment {
  assignment: {
    id: string;
    weight: number;
  };
  [key: string]: unknown;
}

type RepositoryWithRelations = GitRepo &
  GradeRepository & {
    repository: RepositoryModuleSummary;
    assignments: GitRepoAssignmentRelation[];
  };

interface TeamMembershipWithRepositories {
  team: {
    git_repos: RepositoryWithRelations[];
  };
}

/**
 * A row of `findRepositoriesPerStudent`, which selects whole `User` rows.
 *
 * The identity and contact columns are named here rather than left to the index
 * signature so a caller projecting this down to a payload can be type-checked
 * while doing it. `image` is the User column the avatar lives in — this
 * previously declared a non-existent `avatar_url`, which is a name only the
 * view layer uses.
 */
interface StudentRepositoriesRecord {
  id: string;
  name?: string | null;
  image?: string | null;
  login?: string | null;
  email?: string | null;
  provider_email?: string | null;
  school_id?: string | null;
  git_repos?: RepositoryWithRelations[];
  team_memberships?: TeamMembershipWithRepositories[];
  [key: string]: unknown;
}

interface UserWithMemberships {
  classroom_memberships: Array<{
    classroom: {
      slug: string;
      status: 'ACTIVE' | 'LOCKED' | 'UNPUBLISHED';
      is_archived: boolean;
      _count?: {
        repositories?: number;
      };
      memberships: unknown[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export const create = async (
  userData: Prisma.UserCreateInput,
  classroomData: UserCreateClassroomContext,
  role: Role
) => {
  let whereClause: Prisma.UserWhereUniqueInput;

  if (typeof userData.login === 'string' && userData.login.length > 0) {
    whereClause = { login: userData.login };
  } else if (typeof userData.email === 'string' && userData.email.length > 0) {
    whereClause = { email: userData.email };
  } else {
    throw new Error('User create requires a unique login or email');
  }

  // Get the provider from the classroom's git_organization
  const provider = classroomData.git_organization.provider;

  return getPrisma().user.upsert({
    where: whereClause,
    update: {
      // Always create a new membership for the classroom on update
      classroom_memberships: {
        create: {
          classroom_id: classroomData.id,
          role,
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
          role,
          is_grader: role === 'ASSISTANT' ? true : false,
          has_accepted_invite: false,
        },
      },
    },
  });
};

/**
 * Which of these addresses belong to an existing account, under EITHER address
 * we hold (`email` or `provider_email`), compared case-insensitively.
 *
 * Answers one question for the roster: is a pending invite waiting on someone
 * who has simply not signed up yet, or on an address nobody on Classmoji uses?
 * The second is the shape of a typo, and it is invisible today — a mistyped
 * invite looks exactly like a patient one.
 *
 * Returned lowercased, because that is the only form the caller can compare
 * against an invite's `school_email`, which is stored as the instructor typed it.
 */
export const findRegisteredEmails = async (emails: string[]): Promise<Set<string>> => {
  const candidates = Array.from(
    new Set(emails.filter(e => !!e && e.trim().length > 0).map(e => e.trim().toLowerCase()))
  );
  if (candidates.length === 0) return new Set();

  const users = await getPrisma().user.findMany({
    where: {
      OR: candidates.flatMap(email => [
        { email: { equals: email, mode: 'insensitive' as const } },
        { provider_email: { equals: email, mode: 'insensitive' as const } },
      ]),
    },
    select: { email: true, provider_email: true },
  });

  const registered = new Set<string>();
  for (const user of users) {
    for (const address of [user.email, user.provider_email]) {
      const normalized = address?.trim().toLowerCase();
      if (normalized && candidates.includes(normalized)) registered.add(normalized);
    }
  }
  return registered;
};

export const findBy = ({ where }: { where: Prisma.UserWhereUniqueInput }) => {
  return getPrisma().user.findUnique({
    where,
  });
};

export const update = async (userId: string, updates: Prisma.UserUpdateInput) => {
  const user = await getPrisma().user.update({
    where: { id: userId },
    data: updates,
  });

  // Correcting a mistyped address is exactly what someone does after noticing
  // they were invited to a classroom they never joined, so a pending invite for
  // the NEW address is claimed here rather than waiting for the next login
  // (#307). Never let it fail the update it is following.
  if (updates.email !== undefined || updates.provider_email !== undefined) {
    try {
      await claimPendingInvites(userId);
    } catch (error) {
      console.error('Failed to claim pending invites after email change:', error);
    }
  }

  return user;
};

export const deleteByLogin = async (login: string) => {
  return getPrisma().user.delete({
    where: { login },
  });
};

export const findRepositoriesPerStudent = async (classroom: StudentRepositoryClassroomContext) => {
  const includeRepos = {
    git_repos: {
      // Scope to THIS classroom. A user's `git_repos` relation spans every
      // classroom they belong to (each student also has an auto-provisioned
      // `example-<login>` course), so without this filter a student's repos
      // from another classroom bleed into this classroom's grade computation —
      // and that other classroom's grade emojis (e.g. the example course's ⭐)
      // aren't in THIS classroom's EmojiMapping, so convertEmojiToNumber
      // returns undefined and NaN-poisons the student's entire final grade
      // (surfaces as a false `F` on the grades table / `null` on leaderboards).
      // Applies to both the student-owned query and the team query below.
      where: { classroom_id: classroom.id },
      include: {
        repository: true,
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
  // Scope by classroom_id, NOT slug. Classroom.slug is GLOBALLY unique today
  // (schema.prisma: `slug String @unique`), so a slug filter would no longer
  // match twin classrooms in different orgs — but the id is the classroom's
  // actual identity, and scoping by it keeps this query isolated by
  // construction rather than by a property of another column. The team query
  // below already scopes by classroom_id — keep both consistent.
  const studentWithRepos = await getPrisma().user.findMany({
    where: {
      classroom_memberships: {
        some: { classroom_id: classroom.id, role: 'STUDENT' },
      },
    },
    include: includeRepos,
  });

  // 2. find team repos that students belong to
  const studentsWithTeamRepos = await getPrisma().user.findMany({
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
  const combined = _(studentWithRepos as StudentRepositoriesRecord[])
    .concat(studentsWithTeamRepos as StudentRepositoriesRecord[]) // Combine arrays
    .groupBy('id') // Group by id
    .map(items => {
      const [studentData, teamData] = items as StudentRepositoriesRecord[];
      const teamRepos = (teamData?.team_memberships || []).map(
        ({ team }: TeamMembershipWithRepositories) => team.git_repos
      );

      return {
        ...studentData,
        git_repos: [...(studentData?.git_repos || []), ...teamRepos.flat()],
      };
    })
    .value();

  combined.sort((a, b) => {
    const lastNameA = a.name?.split(' ').pop() || '';
    const lastNameB = b.name?.split(' ').pop() || '';
    return lastNameA.localeCompare(lastNameB);
  });

  // Transform data to match expected shape for grades page
  // New schema: GitRepo.repository, GitRepo.assignments (GitRepoAssignment[])
  // Expected: gitRepo.assignment_id, gitRepo.assignment, gitRepo.issues
  return combined.map(student => ({
    ...student,
    git_repos: (student.git_repos || []).map((repo: RepositoryWithRelations) => ({
      ...repo,
      // Map repository to assignment for backward compatibility with grades UI
      assignment_id: repo.repository?.id,
      assignment: repo.repository
        ? {
            id: repo.repository.id,
            title: repo.repository.title,
            weight: repo.repository.weight,
            is_extra_credit: repo.repository.is_extra_credit,
            drop_lowest_count: repo.repository.drop_lowest_count,
            type: repo.repository.type,
          }
        : null,
      // GitRepoAssignments with their Assignment data
      repositoryAssignments: (repo.assignments || []).map(
        (repoAssignment: GitRepoAssignmentRelation) => ({
          ...repoAssignment,
          assignment_id: repoAssignment.assignment?.id,
          // Note: 'assignment' is already included via spread from Prisma include
        })
      ),
    })),
  }));
};

export const findById = async (id: string, options: { includeMemberships?: boolean } = {}) => {
  const { includeMemberships = false } = options;

  const user = await getPrisma().user.findUnique({
    where: { id },
    include: includeMemberships
      ? {
          classroom_memberships: {
            include: {
              classroom: {
                include: {
                  git_organization: true,
                  memberships: {
                    where: { role: 'OWNER' },
                  },
                  _count: {
                    select: { repositories: true },
                  },
                },
              },
            },
          },
        }
      : undefined,
  });

  if (!user) return null;

  // Transform to backward compatible format for UI if memberships included
  if (includeMemberships && 'classroom_memberships' in user) {
    const membershipUser = user as UserWithMemberships;
    return {
      ...user,
      memberships: membershipUser.classroom_memberships.map(m => ({
        ...m,
        organization: {
          ...m.classroom,
          login: m.classroom.slug, // Use slug as "login" for URL compatibility
          status: m.classroom.status,
          is_archived: m.classroom.is_archived,
          assignments: { _count: m.classroom._count?.repositories || 0 },
          memberships: m.classroom.memberships,
        },
      })),
    };
  }

  return user;
};

// TODO: refactor to just take any
export const findByLogin = async (login: string) => {
  const user = await getPrisma().user.findUnique({
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
                select: { repositories: true },
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
        status: m.classroom.status,
        is_archived: m.classroom.is_archived,
        assignments: { _count: m.classroom._count?.repositories || 0 },
        memberships: m.classroom.memberships,
      },
    })),
  };
};
