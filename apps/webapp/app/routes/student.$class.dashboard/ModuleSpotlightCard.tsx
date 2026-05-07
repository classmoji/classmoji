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
  module: SpotlightModule | null;
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

const buildItems = (module: SpotlightModule): SpotlightItem[] => {
  const items: SpotlightItem[] = [];
  module.assignments?.forEach(a => {
    items.push({
      key: `a-${a.id}`,
      type: 'ASGN',
      title: a.title,
      meta: a.student_deadline ? formatRelative(a.student_deadline) : undefined,
    });
  });
  module.slides?.forEach(s => {
    items.push({ key: `s-${s.slide.id}`, type: 'LECT', title: s.slide.title });
  });
  module.pages?.forEach(p => {
    items.push({ key: `p-${p.page.id}`, type: 'PAGE', title: p.page.title });
  });
  module.quizzes?.forEach(q => {
    items.push({ key: `q-${q.id}`, type: 'QUIZ', title: q.title });
  });
  return items.slice(0, 5);
};

const buildSummary = (module: SpotlightModule) => {
  const parts: string[] = [];
  const aCount = module.assignments?.length ?? 0;
  const sCount = module.slides?.length ?? 0;
  const pCount = module.pages?.length ?? 0;
  const qCount = module.quizzes?.length ?? 0;
  if (qCount) parts.push(`${qCount} ${qCount === 1 ? 'quiz' : 'quizzes'}`);
  if (sCount) parts.push(`${sCount} slide ${sCount === 1 ? 'deck' : 'decks'}`);
  if (pCount) parts.push(`${pCount} ${pCount === 1 ? 'page' : 'pages'}`);
  if (aCount) parts.push(`${aCount} ${aCount === 1 ? 'assignment' : 'assignments'}`);
  return parts.join(' · ');
};

const ModuleSpotlightCard = ({ module, classSlug }: ModuleSpotlightCardProps) => {
  if (!module) {
    return (
      <section className="rounded-2xl bg-panel ring-1 ring-stone-200 dark:ring-neutral-800 p-5 sm:p-6 h-full flex flex-col items-center justify-center text-center">
        <h3 className="text-base font-semibold text-gray-800 dark:text-gray-200">
          No published modules yet
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Modules will appear here once your instructor publishes them.
        </p>
      </section>
    );
  }

  const items = buildItems(module);
  const summary = buildSummary(module);

  return (
    <section className="rounded-2xl bg-panel ring-1 ring-stone-200 dark:ring-neutral-800 p-5 sm:p-6 h-full flex flex-col">
      <div className="text-[11px] font-semibold tracking-[0.18em] text-gray-400 dark:text-gray-500">
        MODULE #{module.ordinal}
      </div>
      <h3 className="mt-1 text-lg sm:text-xl font-semibold text-gray-900 dark:text-gray-100 tracking-tight">
        {module.title}
      </h3>
      {summary && <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{summary}</p>}

      <div className="mt-5 text-[11px] font-semibold tracking-[0.18em] text-gray-400 dark:text-gray-500">
        THIS WEEK
      </div>
      <ul className="mt-2 flex-1 flex flex-col gap-1.5">
        {items.length === 0 && (
          <li className="text-sm text-gray-500 dark:text-gray-400">
            Nothing scheduled in this module yet.
          </li>
        )}
        {items.map(item => (
          <li
            key={item.key}
            className="flex items-center gap-3 py-1.5 border-b border-stone-200/60 dark:border-neutral-700/50 last:border-0"
          >
            <span
              className={`text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded ${typeStyles[item.type]}`}
            >
              {item.type}
            </span>
            <span className="flex-1 text-sm text-gray-800 dark:text-gray-200 truncate">
              {item.title}
            </span>
            {item.meta && (
              <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                {item.meta}
              </span>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-4 pt-4 border-t border-stone-200/60 dark:border-neutral-700/50 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs">
          {module.assignments && module.assignments.length > 0 && (
            <span className="px-2 py-1 rounded-full ring-1 ring-stone-200 dark:ring-neutral-700 text-gray-600 dark:text-gray-300">
              Assignments
            </span>
          )}
          {module.slides && module.slides.length > 0 && (
            <span className="px-2 py-1 rounded-full ring-1 ring-stone-200 dark:ring-neutral-700 text-gray-600 dark:text-gray-300">
              Lectures
            </span>
          )}
        </div>
        <Link
          to={`/student/${classSlug}/modules`}
          className="inline-flex items-center gap-1.5 text-xs sm:text-sm font-medium text-gray-700 dark:text-gray-200 px-3 py-1.5 rounded-full ring-1 ring-stone-200 dark:ring-neutral-700 bg-panel hover:bg-stone-50 dark:hover:bg-neutral-800 transition-colors"
        >
          View module
          <IconArrowRight size={14} />
        </Link>
      </div>
    </section>
  );
};

export default ModuleSpotlightCard;
