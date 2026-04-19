import { Link } from 'react-router';
import { Avatar, Tag } from 'antd';
import {
  IconBrandGithub,
  IconCheck,
  IconChevronRight,
  IconFileText,
  IconLock,
  IconPresentation,
  IconUsers,
} from '@tabler/icons-react';
import dayjs from 'dayjs';

import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import type { Route } from './+types/route';
import { assertClassroomAccess } from '~/utils/helpers';
import { EmojisDisplay } from '~/components';

type ModuleWithDetails = NonNullable<Awaited<ReturnType<typeof loadModule>>>;
type ModuleAssignment = ModuleWithDetails['assignments'][number];
type RepoAssignment =
  Awaited<ReturnType<typeof ClassmojiService.helper.findAllAssignmentsForStudent>>[number];
type UserTeam = NonNullable<
  Awaited<ReturnType<typeof ClassmojiService.team.findUserTeamByTag>>
>;

async function loadModule(classroomId: string, moduleSlug: string) {
  return getPrisma().module.findFirst({
    where: {
      classroom_id: classroomId,
      OR: [{ slug: moduleSlug }, { title: moduleSlug }],
    },
    include: {
      assignments: {
        where: { is_published: true },
        include: {
          pages: { include: { page: true }, orderBy: { order: 'asc' } },
          slides: {
            where: { slide: { is_draft: false } },
            include: { slide: true },
            orderBy: { order: 'asc' },
          },
        },
        orderBy: { student_deadline: 'asc' },
      },
      pages: { include: { page: true }, orderBy: { order: 'asc' } },
      slides: {
        where: { slide: { is_draft: false } },
        include: { slide: true },
        orderBy: { order: 'asc' },
      },
    },
  });
}

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;
  const moduleSlug = params.module!;

  const { userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    resourceType: 'STUDENT_MODULES',
    attemptedAction: 'view_module',
  });

  const module = await loadModule(classroom.id, moduleSlug);
  if (!module) {
    throw new Response(`Module not found (slug=${moduleSlug})`, { status: 404 });
  }

  // Compute module index within the classroom for "Module #N" label.
  const allModules = await getPrisma().module.findMany({
    where: { classroom_id: classroom.id, is_published: true },
    select: { id: true },
    orderBy: { created_at: 'desc' },
  });
  const moduleIndex = Math.max(0, allModules.findIndex(m => m.id === module.id)) + 1;

  let userTeam: UserTeam | null = null;
  if (module.team_formation_mode === 'SELF_FORMED' && module.slug) {
    const tag = await ClassmojiService.organizationTag.findByClassroomIdAndName(
      classroom.id,
      module.slug
    );
    if (tag) {
      userTeam = await ClassmojiService.team.findUserTeamByTag(classroom.id, tag.id, userId);
    }
  }

  const repoAssignments = await ClassmojiService.helper.findAllAssignmentsForStudent(
    userId,
    classSlug
  );
  const repoAssignmentsByAssignmentId: Record<string, RepoAssignment> = {};
  repoAssignments.forEach(ra => {
    repoAssignmentsByAssignmentId[ra.assignment_id] = ra;
  });

  return {
    module,
    moduleIndex,
    userTeam,
    repoAssignmentsByAssignmentId,
    classSlug,
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
  };
};

interface ResourceLinksProps {
  pages: { page: { id: string; title: string } }[] | null | undefined;
  slides: { slide: { id: string; title: string } }[] | null | undefined;
  classSlug: string;
  slidesUrl: string;
  pagesUrl: string;
}

const ResourceLinks = ({ pages, slides, classSlug, slidesUrl, pagesUrl }: ResourceLinksProps) => {
  const hasPages = !!pages && pages.length > 0;
  const hasSlides = !!slides && slides.length > 0;
  if (!hasPages && !hasSlides) return null;

  return (
    <div className="flex flex-wrap gap-3 mt-2">
      {hasPages &&
        pages!.map(({ page }) => (
          <a
            key={page.id}
            href={`${pagesUrl}/${classSlug}/${page.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-sm no-underline inline-flex items-center gap-1"
          >
            <IconFileText size={14} />
            {page.title}
          </a>
        ))}
      {hasSlides &&
        slides!.map(({ slide }) => (
          <a
            key={slide.id}
            href={`${slidesUrl}/${slide.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-sm no-underline inline-flex items-center gap-1"
          >
            <IconPresentation size={14} />
            {slide.title}
          </a>
        ))}
    </div>
  );
};

interface TeamFormationBannerProps {
  module: ModuleWithDetails;
  userTeam: UserTeam | null;
  classSlug: string;
}

const TeamFormationBanner = ({ module, userTeam, classSlug }: TeamFormationBannerProps) => {
  const deadlinePassed = module.team_formation_deadline
    ? new Date() > new Date(module.team_formation_deadline)
    : false;

  if (userTeam) {
    const maxTeamSize = module.max_team_size;
    return (
      <div
        className="flex items-center gap-3 px-3.5 py-2.5 rounded-[10px]"
        style={{
          background: 'var(--mint-bg)',
          border: '1px solid var(--mint-bord)',
          color: 'var(--mint-ink)',
        }}
      >
        <IconCheck size={16} />
        <span className="text-[13px]">
          You are on team: <strong>{userTeam.name}</strong>
        </span>
        <Tag color="blue" bordered={false}>
          {userTeam.memberships?.length || 0}
          {maxTeamSize ? `/${maxTeamSize}` : ''} members
        </Tag>
        <div className="flex items-center gap-1">
          {userTeam.memberships?.map(m => (
            <Avatar
              key={m.user_id}
              src={`https://avatars.githubusercontent.com/u/${m.user?.provider_id}?v=4`}
              size={22}
            >
              {m.user?.name?.[0] || m.user?.login?.[0]}
            </Avatar>
          ))}
        </div>
        <div className="flex-1" />
        <Link
          to={`/student/${classSlug}/modules/${module.slug}/team`}
          className="btn btn-sm no-underline"
        >
          View team →
        </Link>
      </div>
    );
  }

  if (deadlinePassed) {
    return (
      <div
        className="flex items-center gap-3 px-3.5 py-2.5 rounded-[10px]"
        style={{
          background: 'var(--peach-bg)',
          border: '1px solid var(--peach-bord)',
          color: 'var(--peach-ink)',
        }}
      >
        <IconUsers size={16} />
        <span className="text-[13px]">
          Team formation deadline has passed. Contact your instructor for assistance.
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex items-center gap-3 px-3.5 py-2.5 rounded-[10px]"
      style={{
        background: 'var(--amber-bg)',
        border: '1px solid var(--amber-bord)',
        color: 'var(--amber-ink)',
      }}
    >
      <IconUsers size={16} />
      <span className="text-[13px]">
        You need to join or create a team for this module
        {module.team_formation_deadline && (
          <span className="ml-2 text-[12px]">
            (Deadline: {new Date(module.team_formation_deadline).toLocaleDateString()})
          </span>
        )}
      </span>
      <div className="flex-1" />
      <Link
        to={`/student/${classSlug}/modules/${module.slug}/team`}
        className="btn btn-sm btn-primary no-underline"
      >
        Create or join team →
      </Link>
    </div>
  );
};

interface AssignmentRowProps {
  assignment: ModuleAssignment;
  repoAssignment: RepoAssignment | undefined;
  classSlug: string;
  slidesUrl: string;
  pagesUrl: string;
  isFirst: boolean;
}

const AssignmentRow = ({
  assignment,
  repoAssignment,
  classSlug,
  slidesUrl,
  pagesUrl,
  isFirst,
}: AssignmentRowProps) => {
  const grades = (repoAssignment as { grades?: unknown[] } | undefined)?.grades;
  const showGrades = assignment.grades_released && Array.isArray(grades) && grades.length > 0;
  const repo = (repoAssignment as { repository?: { name?: string; classroom?: { git_organization?: { login?: string } } } } | undefined)?.repository;
  const issueNumber = (repoAssignment as { provider_issue_number?: number | string } | undefined)
    ?.provider_issue_number;
  const githubIssueUrl =
    repo?.classroom?.git_organization?.login && repo.name && issueNumber !== undefined
      ? `https://github.com/${repo.classroom.git_organization.login}/${repo.name}/issues/${issueNumber}`
      : null;
  const repoUrl =
    repo?.classroom?.git_organization?.login && repo.name
      ? `https://github.com/${repo.classroom.git_organization.login}/${repo.name}`
      : null;

  const submitted = repoAssignment?.status === 'CLOSED';
  const due = assignment.student_deadline ? new Date(assignment.student_deadline) : null;
  const isPastDue = due ? due.getTime() < Date.now() : false;

  let statusChip: React.ReactNode = null;
  if (submitted) {
    statusChip = <span className="chip chip-submitted">Submitted</span>;
  } else if (isPastDue) {
    statusChip = <span className="chip chip-asgn">Late</span>;
  } else {
    statusChip = <span className="chip chip-upcoming">Upcoming</span>;
  }

  const subParts: string[] = [];
  subParts.push('Assignment');
  if (submitted) subParts.push('Submitted');
  else if (due) subParts.push(`Due ${dayjs(due).format('MMM D')}`);
  const subline = subParts.join(' · ');

  return (
    <div
      className="px-[18px] py-3"
      style={{ borderTop: isFirst ? 'none' : '1px solid var(--line-cool)' }}
    >
      <div className="flex items-center gap-3">
        <span
          className="grid place-items-center text-[14px] flex-shrink-0"
          style={{
            width: 32,
            height: 32,
            borderRadius: 7,
            background: 'var(--peach-bg)',
            color: 'var(--peach-ink)',
          }}
        >
          🧪
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-medium truncate">{assignment.title}</div>
          <div className="text-[12px]" style={{ color: 'var(--ink-3)' }}>
            {subline}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {showGrades && (
            <EmojisDisplay
              grades={grades as Parameters<typeof EmojisDisplay>[0]['grades']}
            />
          )}
          {statusChip}
          {repoUrl && (
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-sm no-underline inline-flex items-center gap-1"
            >
              <IconBrandGithub size={14} /> Open repo
            </a>
          )}
          {githubIssueUrl && (
            <a
              href={githubIssueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-sm no-underline inline-flex items-center gap-1"
            >
              View issue <IconChevronRight size={12} />
            </a>
          )}
        </div>
      </div>
      <ResourceLinks
        pages={assignment.pages}
        slides={assignment.slides}
        classSlug={classSlug}
        slidesUrl={slidesUrl}
        pagesUrl={pagesUrl}
      />
    </div>
  );
};

const StudentModuleDetail = ({ loaderData }: Route.ComponentProps) => {
  const {
    module,
    moduleIndex,
    userTeam,
    repoAssignmentsByAssignmentId,
    classSlug,
    slidesUrl,
    pagesUrl,
  } = loaderData;

  const assignments = module.assignments ?? [];
  const total = assignments.length;
  const done = assignments.filter(a => repoAssignmentsByAssignmentId[a.id]?.status === 'CLOSED')
    .length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);

  const itemsCount = (module.pages?.length ?? 0) + (module.slides?.length ?? 0) + total;

  let state: 'done' | 'prog' | 'lock';
  if (total > 0 && pct >= 100) state = 'done';
  else if (done > 0) state = 'prog';
  else state = total === 0 ? 'lock' : 'prog';

  const hasResources = (module.pages?.length ?? 0) > 0 || (module.slides?.length ?? 0) > 0;
  const hasAssignments = total > 0;

  return (
    <div className="flex flex-col gap-3">
      {/* Breadcrumb / back */}
      <div className="text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
        <Link
          to={`/student/${classSlug}/modules`}
          className="no-underline hover:underline"
          style={{ color: 'var(--ink-2)' }}
        >
          Modules
        </Link>
        <span className="mx-1.5">/</span>
        <span style={{ color: 'var(--ink-1)' }}>{module.title}</span>
      </div>

      {module.team_formation_mode === 'SELF_FORMED' && (
        <TeamFormationBanner module={module} userTeam={userTeam} classSlug={classSlug} />
      )}

      {/* Hero panel */}
      <div className="panel" style={{ padding: '18px 22px 20px' }}>
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="caps">Module #{moduleIndex}</div>
            <div
              className="mt-1"
              style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em' }}
            >
              {module.title}
            </div>
            <div className="mt-1 text-[12.5px]" style={{ color: 'var(--ink-2)' }}>
              {module.description ? `${module.description} · ` : ''}
              {itemsCount} item{itemsCount === 1 ? '' : 's'}
            </div>
          </div>
          {state === 'done' && <span className="chip chip-done">Completed</span>}
          {state === 'prog' && <span className="chip chip-inprog">In progress</span>}
          {state === 'lock' && (
            <span className="chip chip-locked inline-flex items-center gap-1">
              <IconLock size={11} stroke={2} /> Locked
            </span>
          )}
        </div>

        <div
          className="mt-3.5 text-right text-[11.5px]"
          style={{ color: 'var(--ink-3)' }}
        >
          {done} of {total} done
        </div>
        <div className="bar mt-1.5">
          <div
            className={`fill${state === 'done' ? ' done' : ''}`}
            style={{ width: `${pct}%` }}
          />
        </div>

        {hasResources && (
          <ResourceLinks
            pages={module.pages}
            slides={module.slides}
            classSlug={classSlug}
            slidesUrl={slidesUrl}
            pagesUrl={pagesUrl}
          />
        )}
      </div>

      {/* Items panel */}
      {hasAssignments && (
        <div className="panel">
          <div className="panel-head">
            <div className="text-[14px] font-semibold">Assignments &amp; Quizzes</div>
            <div className="flex-1" />
            <div className="text-[11.5px]" style={{ color: 'var(--ink-3)' }}>
              {total} item{total === 1 ? '' : 's'} · {Math.max(0, total - done)} remaining
            </div>
          </div>
          {assignments.map((assignment, i) => (
            <AssignmentRow
              key={assignment.id}
              assignment={assignment}
              repoAssignment={repoAssignmentsByAssignmentId[assignment.id]}
              classSlug={classSlug}
              slidesUrl={slidesUrl}
              pagesUrl={pagesUrl}
              isFirst={i === 0}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default StudentModuleDetail;
