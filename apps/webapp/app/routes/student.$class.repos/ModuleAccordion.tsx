import { useState } from 'react';
import { Alert, Avatar, Button, Tag } from 'antd';
import { Link } from 'react-router';
import { IconChevronDown, IconCheck, IconUsers } from '@tabler/icons-react';
import ResourceLinks from './ResourceLinks';
import AssignmentCard from './AssignmentCard';

interface LinkedPage {
  page: { id: string; title: string };
}

interface LinkedSlide {
  slide: { id: string; title: string };
}

interface LinkedQuiz {
  id: string;
  name: string;
}

interface Assignment {
  id: string | number;
  title: string;
  grades_released?: boolean;
  student_deadline?: string | Date | null;
  [key: string]: unknown;
}

interface Repository {
  id: string;
  slug: string | null;
  title: string;
  type: string;
  description?: string | null;
  team_formation_mode?: string | null;
  team_formation_deadline?: string | Date | null;
  max_team_size?: number | null;
  assignments?: Assignment[];
  pages?: LinkedPage[];
  slides?: LinkedSlide[];
  quizzes?: LinkedQuiz[];
  [key: string]: unknown;
}

interface TeamMembership {
  user_id: string;
  user?: { name?: string | null; login?: string | null; provider_id?: string | null };
}

interface UserTeam {
  name: string;
  memberships?: TeamMembership[];
}

interface RepoAssignment {
  id: string;
  status: string;
  [key: string]: unknown;
}

interface TeamFormationBannerProps {
  repository: Repository;
  userTeam: UserTeam | undefined;
  classSlug: string | undefined;
}

const TeamFormationBanner = ({ repository, userTeam, classSlug }: TeamFormationBannerProps) => {
  const deadlinePassed = repository.team_formation_deadline
    ? new Date() > new Date(repository.team_formation_deadline)
    : false;

  if (userTeam) {
    const maxTeamSize = repository.max_team_size;
    return (
      <Alert
        type="success"
        icon={<IconCheck size={16} />}
        message={
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <span>
                You are on team: <strong>{userTeam.name}</strong>
              </span>
              <Tag color="blue">
                {userTeam.memberships?.length || 0}
                {maxTeamSize ? `/${maxTeamSize}` : ''} members
              </Tag>
              <div className="flex items-center gap-2">
                {userTeam.memberships?.map((m: TeamMembership) => (
                  <Avatar
                    key={m.user_id}
                    src={`https://avatars.githubusercontent.com/u/${m.user?.provider_id}?v=4`}
                    size={24}
                  >
                    {m.user?.name?.[0] || m.user?.login?.[0]}
                  </Avatar>
                ))}
              </div>
            </div>
            <Link to={`/student/${classSlug}/repos/${repository.slug}/team`}>
              <Button size="small" type="link">
                View Team
              </Button>
            </Link>
          </div>
        }
        className="mb-4"
      />
    );
  }

  if (deadlinePassed) {
    return (
      <Alert
        type="error"
        icon={<IconUsers size={16} />}
        message="Team formation deadline has passed. Contact your instructor for assistance."
        className="mb-4"
      />
    );
  }

  return (
    <Alert
      type="warning"
      icon={<IconUsers size={16} />}
      message={
        <div className="flex justify-between items-center">
          <span>
            You need to join or create a team for this repository
            {repository.team_formation_deadline && (
              <span className="ml-2 text-sm">
                (Deadline: {new Date(repository.team_formation_deadline).toLocaleDateString()})
              </span>
            )}
          </span>
          <Link to={`/student/${classSlug}/repos/${repository.slug}/team`}>
            <Button type="primary">Create or Join Team</Button>
          </Link>
        </div>
      }
      className="mb-4"
    />
  );
};

interface ModuleCardProps {
  repository: Repository;
  ordinal: number;
  repoAssignmentsByAssignmentId: Record<string, RepoAssignment>;
  userTeam?: UserTeam;
  classSlug: string | undefined;
  slidesUrl: string;
  pagesUrl: string;
  rolePrefix: string;
  defaultOpen: boolean;
}

const buildSummary = (repository: Repository) => {
  const qCount = repository.quizzes?.length ?? 0;
  const sCount = repository.slides?.length ?? 0;
  const pCount = repository.pages?.length ?? 0;
  const aCount = repository.assignments?.length ?? 0;
  const parts: string[] = [];
  if (qCount) parts.push(`${qCount} ${qCount === 1 ? 'quiz' : 'quizzes'}`);
  if (sCount) parts.push(`${sCount} slide ${sCount === 1 ? 'deck' : 'decks'}`);
  if (pCount) parts.push(`${pCount} ${pCount === 1 ? 'page' : 'pages'}`);
  if (aCount) parts.push(`${aCount} ${aCount === 1 ? 'assignment' : 'assignments'}`);
  return parts.join(' · ');
};

const ModuleCard = ({
  repository,
  ordinal,
  repoAssignmentsByAssignmentId,
  userTeam,
  classSlug,
  slidesUrl,
  pagesUrl,
  rolePrefix,
  defaultOpen,
}: ModuleCardProps) => {
  const [open, setOpen] = useState(defaultOpen);

  const assignments = repository.assignments ?? [];
  const total = assignments.length;
  const done = assignments.filter(a => {
    const ra = repoAssignmentsByAssignmentId[String(a.id)];
    return ra?.status === 'CLOSED';
  }).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : null;
  const summary = buildSummary(repository);

  const hasExpandableContent =
    (repository.pages?.length ?? 0) > 0 ||
    (repository.slides?.length ?? 0) > 0 ||
    assignments.length > 0 ||
    !!repository.description ||
    (repository.team_formation_mode === 'SELF_FORMED' && rolePrefix === 'student');

  return (
    <section
      id={repository.slug ?? undefined}
      className="scroll-mt-24 rounded-2xl bg-panel ring-1 ring-line overflow-hidden"
    >
      <button
        type="button"
        onClick={() => hasExpandableContent && setOpen(v => !v)}
        className={`w-full text-left p-5 sm:p-6 ${
          hasExpandableContent
            ? 'hover:bg-stone-50/60 dark:hover:bg-neutral-800/30 transition-colors cursor-pointer'
            : 'cursor-default'
        }`}
        aria-expanded={open}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold tracking-[0.18em] text-ink-4">
              MODULE #{ordinal}
            </div>
            <h3 className="mt-1 text-lg sm:text-xl font-semibold text-ink-0 tracking-tight">
              {repository.title}
            </h3>
            {summary && <p className="text-sm text-ink-3 mt-1">{summary}</p>}
          </div>
          {hasExpandableContent && (
            <IconChevronDown
              size={20}
              className={`text-ink-4 shrink-0 transition-transform ${
                open ? 'rotate-180' : ''
              }`}
            />
          )}
        </div>

        {pct !== null && (
          <div className="mt-5 flex items-center gap-3">
            <div className="h-2 flex-1 bg-nav-hover rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${pct}%`,
                  backgroundColor: pct === 100 ? '#619462' : '#758CA0',
                }}
              />
            </div>
            <span className="text-sm font-medium text-ink-1 tabular-nums">
              {pct}%
            </span>
          </div>
        )}
      </button>

      {open && hasExpandableContent && (
        <div className="px-5 sm:px-6 pb-5 sm:pb-6 -mt-1 border-t border-line pt-5">
          {repository.team_formation_mode === 'SELF_FORMED' && rolePrefix === 'student' && (
            <TeamFormationBanner repository={repository} userTeam={userTeam} classSlug={classSlug} />
          )}

          {repository.description && (
            <p className="text-ink-2 mb-4">{repository.description}</p>
          )}

          <ResourceLinks
            pages={repository.pages}
            slides={repository.slides}
            classSlug={classSlug}
            slidesUrl={slidesUrl}
            pagesUrl={pagesUrl}
            rolePrefix={rolePrefix}
          />

          {((repository.pages?.length ?? 0) > 0 || (repository.slides?.length ?? 0) > 0) &&
            assignments.length > 0 && (
              <div className="border-t border-line my-4" />
            )}

          {assignments.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-ink-3 mb-3">
                Assignments
              </h4>
              {assignments.map(assignment => (
                <AssignmentCard
                  key={String(assignment.id)}
                  assignment={assignment}
                  repoAssignment={repoAssignmentsByAssignmentId[String(assignment.id)]}
                  classSlug={classSlug}
                  slidesUrl={slidesUrl}
                  pagesUrl={pagesUrl}
                  rolePrefix={rolePrefix}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

interface ModuleAccordionProps {
  repositories: Repository[];
  repoAssignmentsByAssignmentId: Record<string, RepoAssignment>;
  userTeamsByModuleSlug?: Record<string, UserTeam>;
  classSlug: string | undefined;
  slidesUrl: string;
  pagesUrl: string;
  rolePrefix?: string;
}

const ModuleAccordion = ({
  repositories,
  repoAssignmentsByAssignmentId,
  userTeamsByModuleSlug = {},
  classSlug,
  slidesUrl,
  pagesUrl,
  rolePrefix = 'student',
}: ModuleAccordionProps) => {
  return (
    <div className="space-y-4 lg:space-y-5">
      {repositories.map((repository, idx) => {
        const hasOpenAssignment = (repository.assignments ?? []).some(a => {
          const ra = repoAssignmentsByAssignmentId[String(a.id)];
          return !ra || ra.status !== 'CLOSED';
        });
        return (
          <ModuleCard
            key={repository.id}
            repository={repository}
            ordinal={idx + 1}
            repoAssignmentsByAssignmentId={repoAssignmentsByAssignmentId}
            userTeam={repository.slug ? userTeamsByModuleSlug[repository.slug] : undefined}
            classSlug={classSlug}
            slidesUrl={slidesUrl}
            pagesUrl={pagesUrl}
            rolePrefix={rolePrefix}
            defaultOpen={hasOpenAssignment}
          />
        );
      })}
    </div>
  );
};

export default ModuleAccordion;
