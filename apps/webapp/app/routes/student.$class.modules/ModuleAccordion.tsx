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

interface Module {
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
  module: Module;
  userTeam: UserTeam | undefined;
  classSlug: string | undefined;
}

const TeamFormationBanner = ({ module, userTeam, classSlug }: TeamFormationBannerProps) => {
  const deadlinePassed = module.team_formation_deadline
    ? new Date() > new Date(module.team_formation_deadline)
    : false;

  if (userTeam) {
    const maxTeamSize = module.max_team_size;
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
            <Link to={`/student/${classSlug}/modules/${module.slug}/team`}>
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
            You need to join or create a team for this module
            {module.team_formation_deadline && (
              <span className="ml-2 text-sm">
                (Deadline: {new Date(module.team_formation_deadline).toLocaleDateString()})
              </span>
            )}
          </span>
          <Link to={`/student/${classSlug}/modules/${module.slug}/team`}>
            <Button type="primary">Create or Join Team</Button>
          </Link>
        </div>
      }
      className="mb-4"
    />
  );
};

interface ModuleCardProps {
  module: Module;
  ordinal: number;
  repoAssignmentsByAssignmentId: Record<string, RepoAssignment>;
  userTeam?: UserTeam;
  classSlug: string | undefined;
  slidesUrl: string;
  pagesUrl: string;
  rolePrefix: string;
  defaultOpen: boolean;
}

const buildSummary = (module: Module) => {
  const qCount = module.quizzes?.length ?? 0;
  const sCount = module.slides?.length ?? 0;
  const pCount = module.pages?.length ?? 0;
  const aCount = module.assignments?.length ?? 0;
  const parts: string[] = [];
  if (qCount) parts.push(`${qCount} ${qCount === 1 ? 'quiz' : 'quizzes'}`);
  if (sCount) parts.push(`${sCount} slide ${sCount === 1 ? 'deck' : 'decks'}`);
  if (pCount) parts.push(`${pCount} ${pCount === 1 ? 'page' : 'pages'}`);
  if (aCount) parts.push(`${aCount} ${aCount === 1 ? 'assignment' : 'assignments'}`);
  return parts.join(' · ');
};

const ModuleCard = ({
  module,
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

  const assignments = module.assignments ?? [];
  const total = assignments.length;
  const done = assignments.filter(a => {
    const ra = repoAssignmentsByAssignmentId[String(a.id)];
    return ra?.status === 'CLOSED';
  }).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : null;
  const summary = buildSummary(module);

  const hasExpandableContent =
    (module.pages?.length ?? 0) > 0 ||
    (module.slides?.length ?? 0) > 0 ||
    assignments.length > 0 ||
    !!module.description ||
    (module.team_formation_mode === 'SELF_FORMED' && rolePrefix === 'student');

  return (
    <section
      id={module.slug ?? undefined}
      className="scroll-mt-24 rounded-2xl bg-panel ring-1 ring-stone-200 dark:ring-neutral-800 overflow-hidden"
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
            <div className="text-[11px] font-semibold tracking-[0.18em] text-gray-400 dark:text-gray-500">
              MODULE #{ordinal}
            </div>
            <h3 className="mt-1 text-lg sm:text-xl font-semibold text-gray-900 dark:text-gray-100 tracking-tight">
              {module.title}
            </h3>
            {summary && <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{summary}</p>}
          </div>
          {hasExpandableContent && (
            <IconChevronDown
              size={20}
              className={`text-gray-400 dark:text-gray-500 shrink-0 transition-transform ${
                open ? 'rotate-180' : ''
              }`}
            />
          )}
        </div>

        {pct !== null && (
          <div className="mt-5 flex items-center gap-3">
            <div className="h-2 flex-1 bg-stone-100 dark:bg-neutral-800 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${pct}%`,
                  backgroundColor: pct === 100 ? '#619462' : '#758CA0',
                }}
              />
            </div>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300 tabular-nums">
              {pct}%
            </span>
          </div>
        )}
      </button>

      {open && hasExpandableContent && (
        <div className="px-5 sm:px-6 pb-5 sm:pb-6 -mt-1 border-t border-stone-200/70 dark:border-neutral-800 pt-5">
          {module.team_formation_mode === 'SELF_FORMED' && rolePrefix === 'student' && (
            <TeamFormationBanner module={module} userTeam={userTeam} classSlug={classSlug} />
          )}

          {module.description && (
            <p className="text-gray-600 dark:text-gray-400 mb-4">{module.description}</p>
          )}

          <ResourceLinks
            pages={module.pages}
            slides={module.slides}
            classSlug={classSlug}
            slidesUrl={slidesUrl}
            pagesUrl={pagesUrl}
            rolePrefix={rolePrefix}
          />

          {((module.pages?.length ?? 0) > 0 || (module.slides?.length ?? 0) > 0) &&
            assignments.length > 0 && (
              <div className="border-t border-stone-200/70 dark:border-neutral-800 my-4" />
            )}

          {assignments.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-3">
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
  modules: Module[];
  repoAssignmentsByAssignmentId: Record<string, RepoAssignment>;
  userTeamsByModuleSlug?: Record<string, UserTeam>;
  classSlug: string | undefined;
  slidesUrl: string;
  pagesUrl: string;
  rolePrefix?: string;
}

const ModuleAccordion = ({
  modules,
  repoAssignmentsByAssignmentId,
  userTeamsByModuleSlug = {},
  classSlug,
  slidesUrl,
  pagesUrl,
  rolePrefix = 'student',
}: ModuleAccordionProps) => {
  return (
    <div className="space-y-4 lg:space-y-5">
      {modules.map((module, idx) => {
        const hasOpenAssignment = (module.assignments ?? []).some(a => {
          const ra = repoAssignmentsByAssignmentId[String(a.id)];
          return !ra || ra.status !== 'CLOSED';
        });
        return (
          <ModuleCard
            key={module.id}
            module={module}
            ordinal={idx + 1}
            repoAssignmentsByAssignmentId={repoAssignmentsByAssignmentId}
            userTeam={module.slug ? userTeamsByModuleSlug[module.slug] : undefined}
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
