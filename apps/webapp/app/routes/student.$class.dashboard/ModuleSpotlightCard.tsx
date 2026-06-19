import { Link } from 'react-router';
import dayjs from 'dayjs';
import { IconArrowRight } from '@tabler/icons-react';

interface SpotlightAssignment {
  id: string;
  title: string;
  student_deadline: string | Date | null;
  is_published?: boolean;
}

interface SpotlightLinked {
  id: string;
  title: string;
}

export interface SpotlightModule {
  id: string;
  slug: string | null;
  title: string;
  type?: string | null;
  ordinal: number;
  assignments?: SpotlightAssignment[];
  pages?: { page: SpotlightLinked }[];
  slides?: { slide: SpotlightLinked }[];
  quizzes?: SpotlightLinked[];
}

interface ModuleSpotlightCardProps {
  repository: SpotlightModule | null;
  classSlug: string;
}

type SpotlightItemType = 'ASGN' | 'LECT' | 'PAGE' | 'QUIZ';

interface SpotlightItem {
  key: string;
  type: SpotlightItemType;
  title: string;
  meta?: string;
  href?: string;
}

const typeStyles: Record<SpotlightItemType, string> = {
  ASGN: 'bg-rose-50 text-rose-700 dark:bg-rose-900/30 dark:text-rose-200',
  LECT: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200',
  PAGE: 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200',
  QUIZ: 'bg-sky-50 text-sky-700 dark:bg-sky-900/30 dark:text-sky-200',
};

const formatRelative = (date: string | Date) => {
  const target = dayjs(date);
  const today = dayjs().startOf('day');
  const days = target.startOf('day').diff(today, 'day');
  if (days < 0) return `overdue · ${target.format('MMM D')}`;
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  if (days < 7) return target.format('ddd MMM D');
  return target.format('MMM D');
};

const buildItems = (repository: SpotlightModule): SpotlightItem[] => {
  const items: SpotlightItem[] = [];
  repository.assignments?.forEach(a => {
    items.push({
      key: `a-${a.id}`,
      type: 'ASGN',
      title: a.title,
      meta: a.student_deadline ? formatRelative(a.student_deadline) : undefined,
    });
  });
  repository.slides?.forEach(s => {
    items.push({ key: `s-${s.slide.id}`, type: 'LECT', title: s.slide.title });
  });
  repository.pages?.forEach(p => {
    items.push({ key: `p-${p.page.id}`, type: 'PAGE', title: p.page.title });
  });
  repository.quizzes?.forEach(q => {
    items.push({ key: `q-${q.id}`, type: 'QUIZ', title: q.title });
  });
  return items.slice(0, 5);
};

const buildSummary = (repository: SpotlightModule) => {
  const parts: string[] = [];
  const aCount = repository.assignments?.length ?? 0;
  const sCount = repository.slides?.length ?? 0;
  const pCount = repository.pages?.length ?? 0;
  const qCount = repository.quizzes?.length ?? 0;
  if (qCount) parts.push(`${qCount} ${qCount === 1 ? 'quiz' : 'quizzes'}`);
  if (sCount) parts.push(`${sCount} slide ${sCount === 1 ? 'deck' : 'decks'}`);
  if (pCount) parts.push(`${pCount} ${pCount === 1 ? 'page' : 'pages'}`);
  if (aCount) parts.push(`${aCount} ${aCount === 1 ? 'assignment' : 'assignments'}`);
  return parts.join(' · ');
};

const ModuleSpotlightCard = ({ repository, classSlug }: ModuleSpotlightCardProps) => {
  if (!repository) {
    return (
      <section className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 h-full flex flex-col items-center justify-center text-center">
        <h3 className="text-base font-semibold text-ink-1">
          No published repositories yet
        </h3>
        <p className="text-sm text-ink-3 mt-1">
          Repositories will appear here once your instructor publishes them.
        </p>
      </section>
    );
  }

  const items = buildItems(repository);
  const summary = buildSummary(repository);

  return (
    <section
      data-tour="dashboard-spotlight"
      className="rounded-2xl bg-panel ring-1 ring-line p-5 sm:p-6 h-full flex flex-col"
    >
      <div className="text-xs font-semibold tracking-[0.18em] text-ink-4">
        MODULE #{repository.ordinal}
      </div>
      <h3 className="mt-1 text-lg sm:text-xl font-semibold text-ink-0 tracking-tight">
        {repository.title}
      </h3>
      {summary && <p className="text-sm text-ink-3 mt-1">{summary}</p>}

      <div className="mt-5 text-xs font-semibold tracking-[0.18em] text-ink-4">
        THIS WEEK
      </div>
      <ul className="mt-2 flex-1 flex flex-col gap-1.5">
        {items.length === 0 && (
          <li className="text-sm text-ink-3">
            Nothing scheduled in this repository yet.
          </li>
        )}
        {items.map(item => (
          <li
            key={item.key}
            className="flex items-center gap-3 py-1.5 border-b border-line/60 last:border-0"
          >
            <span
              className={`text-xs font-bold tracking-wider px-1.5 py-0.5 rounded ${typeStyles[item.type]}`}
            >
              {item.type}
            </span>
            <span className="flex-1 text-sm text-ink-1 truncate">
              {item.title}
            </span>
            {item.meta && (
              <span className="text-xs text-ink-3 whitespace-nowrap">
                {item.meta}
              </span>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-4 pt-4 border-t border-line/60 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs">
          {repository.assignments && repository.assignments.length > 0 && (
            <span className="px-2 py-1 rounded-full ring-1 ring-line text-gray-600 dark:text-gray-300">
              Assignments
            </span>
          )}
          {repository.slides && repository.slides.length > 0 && (
            <span className="px-2 py-1 rounded-full ring-1 ring-line text-gray-600 dark:text-gray-300">
              Lectures
            </span>
          )}
        </div>
        <Link
          to={`/student/${classSlug}/repos`}
          className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-medium text-gray-700 dark:text-gray-200 px-3 py-1.5 rounded-full ring-1 ring-line bg-panel hover:bg-nav-hover transition-colors"
        >
          View repository
          <IconArrowRight size={14} />
        </Link>
      </div>
    </section>
  );
};

export default ModuleSpotlightCard;
