import getPrisma from '@classmoji/database';
import { useLocation } from 'react-router';
import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/helpers';
import type { AutogradingResult } from '@prisma/client';
import ReadOnlyModulesTree from '~/components/features/modules/ReadOnlyModulesTree';
import {
  buildRepositoryNode,
  type AnyRepository,
  type AnyRepoAssignment,
} from '~/components/features/modules/studentTree';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: 'STUDENT_REPOSITORIES',
    attemptedAction: 'view_repos',
  });

  const repositories = await getPrisma().repository.findMany({
    where: { classroom_id: classroom.id, is_published: true },
    include: {
      assignments: {
        where: { is_published: true },
        include: {
          pages: {
            where: { page: { is_draft: false } },
            include: { page: true },
            orderBy: { order: 'asc' },
          },
          slides: {
            where: { slide: { is_draft: false } },
            include: { slide: true },
            orderBy: { order: 'asc' },
          },
        },
        orderBy: { student_deadline: 'asc' },
      },
      // Attached pages and slides are both filtered to published content here,
      // so the tree lists the same set whichever resource type it renders.
      pages: {
        where: { page: { is_draft: false } },
        include: { page: true },
        orderBy: { order: 'asc' },
      },
      slides: {
        where: { slide: { is_draft: false } },
        include: { slide: true },
        orderBy: { order: 'asc' },
      },
      quizzes: {
        where: { status: 'PUBLISHED' },
        select: { id: true, name: true },
      },
    },
    orderBy: { created_at: 'asc' },
  });

  // Fetch both individual AND team assignments so View Issue button works for group assignments
  const repoAssignments = await ClassmojiService.helper.findAllAssignmentsForStudent(
    userId,
    classSlug
  );

  const repoAssignmentsByAssignmentId: Record<string, (typeof repoAssignments)[number]> = {};
  repoAssignments.forEach(ra => {
    repoAssignmentsByAssignmentId[ra.assignment_id] = ra;
  });

  // Org login powers the repository "View" link's fallback to the source repo
  // when the viewer has no personal repo yet (e.g. instructors previewing).
  const gitOrgLogin =
    (
      await getPrisma().classroom.findUnique({
        where: { id: classroom.id },
        select: { git_organization: { select: { login: true } } },
      })
    )?.git_organization?.login ?? null;

  // The viewer's own repos for this classroom (individual + team-based).
  const studentRepos = await getPrisma().gitRepo.findMany({
    where: {
      classroom_id: classroom.id,
      OR: [{ student_id: userId }, { team: { memberships: { some: { user_id: userId } } } }],
    },
    select: { id: true, name: true, repository_id: true, repository: { select: { title: true } } },
  });

  // Map each repository to the viewer's own git repo (powers the "View" link)
  // and track which repositories they actually have a repo for.
  const studentRepoByRepositoryId: Record<string, { name: string }> = {};
  const ownedRepositoryIds = new Set<string>();
  studentRepos.forEach(r => {
    studentRepoByRepositoryId[r.repository_id] = { name: r.name };
    ownedRepositoryIds.add(r.repository_id);
  });

  // A SELF_FORMED group repo has NO GitRepo until the student forms a team, so
  // the ownership filter alone hid the one page they need to reach (#313). The
  // filter's original purpose — hiding unprovisioned individual repos — is
  // unchanged.
  const isSelfFormed = (repository: (typeof repositories)[number]) =>
    repository.type === 'GROUP' &&
    repository.team_formation_mode === 'SELF_FORMED' &&
    !!repository.slug;

  // Students only see repositories they actually have a repo for, plus any
  // self-formed group repo still waiting on a team. Instructors previewing the
  // student view still see every published repository.
  const visibleRepositories =
    membership?.role === 'STUDENT'
      ? repositories.filter(r => ownedRepositoryIds.has(r.id) || isSelfFormed(r))
      : repositories;

  // Team state for the self-formed repos on this page. There is no
  // Repository -> Team foreign key: a team is tied to a repo by the convention
  // `Tag.name === Repository.slug`, so each costs a tag lookup plus a
  // membership lookup. Bounded by the number of self-formed repos in one
  // classroom, which is a handful at most.
  //
  // Only for viewers the team page itself admits: it allows STUDENT, OWNER and
  // TEACHER, so an ASSISTANT — who can read THIS page — would follow the link
  // into a full-page 403. No state means no link, and their rows render exactly
  // as they did before.
  const canReachTeamPage =
    membership?.role === 'STUDENT' ||
    membership?.role === 'OWNER' ||
    membership?.role === 'TEACHER';
  const selfFormedByRepositoryId: Record<
    string,
    { slug: string; hasTeam: boolean; deadlinePassed: boolean }
  > = {};
  for (const repository of canReachTeamPage ? visibleRepositories : []) {
    if (!isSelfFormed(repository)) continue;
    const tag = await ClassmojiService.organizationTag.findByClassroomIdAndName(
      classroom.id,
      repository.slug!
    );
    const userTeam = tag
      ? await ClassmojiService.team.findUserTeamByTag(classroom.id, tag.id, userId)
      : null;
    selfFormedByRepositoryId[repository.id] = {
      slug: repository.slug!,
      hasTeam: !!userTeam,
      deadlinePassed: repository.team_formation_deadline
        ? new Date() > new Date(repository.team_formation_deadline)
        : false,
    };
  }
  // Latest autograding result per repository unit — rendered as a pill in the
  // repos table, with the per-test breakdown one click away in a modal.
  const latestAutograding = await ClassmojiService.autogradingResult.findLatestByGitRepoIds(
    studentRepos.map(r => r.id)
  );
  const autogradingByRepositoryId: Record<string, AutogradingResult> = {};
  studentRepos.forEach(r => {
    const result = latestAutograding.get(r.id);
    if (result) autogradingByRepositoryId[r.repository_id] = result;
  });

  return {
    repositories: visibleRepositories,
    repoAssignmentsByAssignmentId,
    gitOrgLogin,
    studentRepoByRepositoryId,
    autogradingByRepositoryId,
    selfFormedByRepositoryId,
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
    classSlug,
  };
};

const StudentRepositories = ({ loaderData }: Route.ComponentProps) => {
  const rolePrefix = useLocation().pathname.split('/')[1];
  const {
    repositories,
    repoAssignmentsByAssignmentId,
    gitOrgLogin,
    studentRepoByRepositoryId,
    autogradingByRepositoryId,
    selfFormedByRepositoryId,
    slidesUrl,
    pagesUrl,
    classSlug,
  } = loaderData;

  // Served under every prefix this route's gate allows, so resource links stay
  // on the prefix the viewer arrived on.
  const ctx = {
    classSlug,
    slidesUrl,
    pagesUrl,
    gitOrgLogin,
    studentRepoByRepositoryId,
    autogradingByRepositoryId,
    selfFormedByRepositoryId,
    rolePrefix,
  };
  const nodes = (repositories as AnyRepository[]).map(r =>
    buildRepositoryNode(
      r,
      repoAssignmentsByAssignmentId as Record<string, AnyRepoAssignment>,
      ctx,
      0
    )
  );

  return (
    <div className="min-h-full">
      <h1 className="mt-2 mb-4 text-lg font-semibold text-ink-1">Repositories</h1>

      {repositories.length === 0 ? (
        <div className="rounded-2xl bg-panel ring-1 ring-line p-8 text-center">
          <h3 className="text-lg font-semibold text-ink-1">No published repositories yet</h3>
          <p className="text-sm text-ink-3 mt-1">
            Repositories will appear here once your instructor publishes them.
          </p>
        </div>
      ) : (
        <div data-tour="repos-card">
          <ReadOnlyModulesTree key={classSlug} nodes={nodes} nameColumnTitle="Repository" />
        </div>
      )}
    </div>
  );
};

export default StudentRepositories;
